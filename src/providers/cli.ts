import { spawn } from 'child_process';
import path from 'path';
import type { LLMProvider, Message, ChatOptions } from './base.js';
import type { ToolEvent } from '../core/events.js';

export interface CliProviderOptions {
  command: string;
  /** Arg templates. Use {{SYSTEM}} for system prompt, {{PROMPT}} for user input. */
  args: string[];
  model?: string;
}

/**
 * Build a robust PATH for CLI tools.
 * Helps when server is launched from GUI/non-login shells where PATH is incomplete.
 */
function buildCliPath(): string {
  const existing = process.env.PATH ?? '';
  const home = process.env.HOME ?? '';
  const extras = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    home ? `${home}/.local/bin` : '',
  ].filter(Boolean);

  const merged = [...new Set([...existing.split(':'), ...extras].filter(Boolean))];
  return merged.join(':');
}

function normalizeCwd(cwd?: string): string | undefined {
  if (!cwd?.trim()) return undefined;
  const trimmed = cwd.trim();
  if (trimmed.startsWith('~')) {
    return path.join(process.env.HOME ?? '', trimmed.slice(1));
  }
  return path.resolve(trimmed);
}

/** Check if the task explicitly requests accessing paths outside the workspace */
function explicitlyRequestsExternalAccess(userContent: string, workspacePath?: string): boolean {
  if (!workspacePath) return false;
  
  // Find all absolute paths in userContent (starting with / on unix, or drive letters on windows)
  const absPathRegex = /(?:\s|^)(\/[a-zA-Z0-9_\.\-]+(?:\/[a-zA-Z0-9_\.\-]+)*)/g;
  let match;
  while ((match = absPathRegex.exec(userContent)) !== null) {
    const matchedPath = match[1];
    // Check if matchedPath is outside the workspace
    const relative = path.relative(workspacePath, matchedPath);
    const isInside = !relative.startsWith('..') && !path.isAbsolute(relative);
    if (!isInside) {
      return true; // Explicitly requested access to a path outside the workspace
    }
  }
  
  // Semantic keywords requesting external or out-of-workspace directory access
  const keywords = [
    'other directory', 'external directory', 'outside of', 'cross-directory', 
    'system directory', 'home directory', 'slash', 'root folder',
    '其它目录', '外部目录', '工作区之外', '跨目录', '系统目录', '家目录', '根目录'
  ];
  const lowercaseContent = userContent.toLowerCase();
  if (keywords.some(kw => lowercaseContent.includes(kw))) {
    return true;
  }
  
  return false;
}

/** Physically check if the tool parameters are attempting to access paths outside the workspace */
function isAttemptingUnauthorizedAccess(toolName: string, input: any, workspacePath: string): boolean {
  if (!toolName || !input) return false;
  
  // 1. Validate file path parameters
  const filePathKeys = ['file_path', 'path', 'filepath', 'file', 'target', 'dest', 'source', 'src'];
  for (const key of filePathKeys) {
    const val = input[key];
    if (typeof val === 'string' && val.trim()) {
      // Resolve path (could be relative or absolute)
      const resolved = path.isAbsolute(val) ? path.resolve(val) : path.resolve(workspacePath, val);
      const relative = path.relative(workspacePath, resolved);
      const isInside = !relative.startsWith('..') && !path.isAbsolute(relative);
      // Allow exact match with workspace directory itself
      if (!isInside && resolved !== workspacePath) {
        return true; // Path is physically outside the workspace!
      }
    }
  }
  
  // 2. Validate bash/command execution parameters
  const cmdKeys = ['command', 'cmd', 'script', 'args'];
  for (const key of cmdKeys) {
    const val = input[key];
    const checkStr = Array.isArray(val) ? val.join(' ') : (typeof val === 'string' ? val : '');
    if (checkStr.trim()) {
      // Check if command references any absolute paths outside the workspace
      const absPathRegex = /(?:\s|^)(\/[a-zA-Z0-9_\.\-]+(?:\/[a-zA-Z0-9_\.\-]+)*)/g;
      let match;
      while ((match = absPathRegex.exec(checkStr)) !== null) {
        const matchedPath = match[1];
        const relative = path.relative(workspacePath, matchedPath);
        const isInside = !relative.startsWith('..') && !path.isAbsolute(relative);
        if (!isInside && matchedPath !== workspacePath) {
          return true; // Command is trying to access an external absolute path!
        }
      }
    }
  }
  
  return false;
}

/** Strip ANSI escape codes from terminal output */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/**
 * Invokes a local CLI binary as a subprocess and returns stdout as the response.
 *
 * Placeholder replacement in args:
 *   {{SYSTEM}}  — replaced with the system prompt text
 *   {{PROMPT}}  — replaced with the combined user message
 *
 * If {{SYSTEM}} is absent, system prompt is prepended to the prompt.
 * If {{PROMPT}} is absent, the prompt is appended as the last positional arg.
 */
export class CliProvider implements LLMProvider {
  readonly name: string;
  private command: string;
  private argTemplates: string[];
  private model?: string;
  private _lastToolEvents: ToolEvent[] = [];

  constructor(opts: CliProviderOptions) {
    this.command = opts.command;
    this.argTemplates = opts.args;
    this.model = opts.model;
    this.name = `cli:${opts.command}`;
  }

  /** Returns tool events from the most recent chat() call (populated when CLI uses --output-format stream-json). */
  getLastToolEvents(): ToolEvent[] {
    return this._lastToolEvents;
  }

  private extractCodexToolResultContent(item: Record<string, unknown>): string {
    const text =
      (typeof item.aggregated_output === 'string' && item.aggregated_output) ||
      (typeof item.output === 'string' && item.output) ||
      (typeof item.text === 'string' && item.text);
    if (text) return text;
    return JSON.stringify(item, null, 2);
  }

  private normalizeCodexCommandForGuard(command: string): string {
    const trimmed = command.trim();
    const shellWrapped = trimmed.replace(/^\/bin\/(?:zsh|bash|sh)\s+-lc\s+/, '').trim();
    // Handle wrappers like: /bin/zsh -lc 'pwd && ls'
    return shellWrapped.replace(/^['"]|['"]$/g, '');
  }

  private parseJsonLineEvents(
    ev: Record<string, unknown>,
    nextIndex: () => number,
  ): { events: ToolEvent[]; resultOutput?: string; hasEvents: boolean } {
    const out: ToolEvent[] = [];
    let resultOutput = '';
    let hasEvents = false;

    if (ev.type === 'assistant') {
      hasEvents = true;
      const msg = ev.message as { content?: Array<Record<string, unknown>> };
      for (const block of msg?.content ?? []) {
        if (block.type === 'text' && block.text) {
          out.push({ index: nextIndex(), type: 'text', content: block.text as string });
        } else if (block.type === 'tool_use') {
          out.push({
            index: nextIndex(),
            type: 'tool_use',
            name: block.name as string,
            input: block.input as Record<string, unknown>,
            toolUseId: block.id as string,
          });
        }
      }
    } else if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
      hasEvents = true;
      out.push({ index: nextIndex(), type: 'text', content: ev.content });
    } else if (ev.type === 'tool_use') {
      hasEvents = true;
      out.push({
        index: nextIndex(),
        type: 'tool_use',
        name: ev.tool_name as string,
        input: (ev.parameters ?? {}) as Record<string, unknown>,
        toolUseId: ev.tool_id as string,
      });
    } else if (ev.type === 'tool') {
      hasEvents = true;
      const content = ev.content as Array<{ type: string; text?: string }> | undefined;
      const text = content?.map((c) => c.text ?? '').join('') ?? String(ev.content ?? '');
      out.push({
        index: nextIndex(),
        type: 'tool_result',
        content: text,
        toolUseId: ev.tool_use_id as string,
        isError: ev.is_error as boolean | undefined,
      });
    } else if (ev.type === 'tool_result') {
      hasEvents = true;
      out.push({
        index: nextIndex(),
        type: 'tool_result',
        content: ev.output as string,
        toolUseId: ev.tool_id as string,
        isError: ev.status !== 'success',
      });
    } else if (ev.type === 'result') {
      hasEvents = true;
      if (typeof ev.result === 'string') resultOutput = ev.result;
    } else if ((ev.type === 'item.started' || ev.type === 'item.completed') && ev.item && typeof ev.item === 'object') {
      const item = ev.item as Record<string, unknown>;
      const itemType = String(item.type ?? '');
      const itemId = String(item.id ?? '');
      if (itemType === 'agent_message') {
        if (ev.type === 'item.completed' && typeof item.text === 'string' && item.text) {
          hasEvents = true;
          out.push({ index: nextIndex(), type: 'text', content: item.text as string });
        }
      } else if (ev.type === 'item.started') {
        hasEvents = true;
        const input: Record<string, unknown> = {};
        if (typeof item.command === 'string') input.command = this.normalizeCodexCommandForGuard(item.command);
        if (item.status != null) input.status = item.status;
        out.push({
          index: nextIndex(),
          type: 'tool_use',
          name: itemType || 'codex_item',
          input,
          toolUseId: itemId || undefined,
        });
      } else if (ev.type === 'item.completed') {
        hasEvents = true;
        const status = String(item.status ?? '');
        const exitCode = item.exit_code as number | null | undefined;
        out.push({
          index: nextIndex(),
          type: 'tool_result',
          content: this.extractCodexToolResultContent(item),
          toolUseId: itemId || undefined,
          isError: (typeof exitCode === 'number' && exitCode !== 0) || (status === 'failed'),
        });
      }
    }

    return { events: out, resultOutput, hasEvents };
  }

  /**
   * Attempt to parse CLI stdout as Claude stream-json JSONL.
   * Returns extracted text output + tool events, or null if not stream-json.
   */
  private tryParseStreamJson(raw: string): { output: string; toolEvents: ToolEvent[] } | null {
    const lines = raw.split('\n').filter((l) => l.trim().startsWith('{'));
    if (lines.length === 0) return null;
    try { JSON.parse(lines[0]); } catch { return null; }

    const toolEvents: ToolEvent[] = [];
    let idx = 0;
    const textParts: string[] = [];
    const geminiTextParts: string[] = [];
    let resultOutput = '';
    let hasEvents = false;

    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;

        const parsed = this.parseJsonLineEvents(ev, () => idx++);
        if (parsed.hasEvents) hasEvents = true;
        if (parsed.resultOutput) resultOutput = parsed.resultOutput;
        for (const event of parsed.events) {
          toolEvents.push(event);
          if (event.type === 'text' && event.content) {
            textParts.push(event.content);
            geminiTextParts.push(event.content);
          }
        }
      } catch { /* non-JSON line */ }
    }

    if (!hasEvents) return null;
    const finalOutput = resultOutput || textParts.join('') || raw;
    return { output: finalOutput, toolEvents };
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    let systemContent = messages.find((m) => m.role === 'system')?.content ?? '';
    const userContent = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n\n');

    // Security Constraint: Lock CLI agent to the active workspace unless the task explicitly requests external path access
    if (options?.cwd) {
      const workspacePath = normalizeCwd(options.cwd);
      if (workspacePath && !explicitlyRequestsExternalAccess(userContent, workspacePath)) {
        systemContent = `${systemContent}\n\n` +
          `[SECURITY POLICY - WORKSPACE LOCK]\n` +
          `- You are strictly restricted to operate ONLY within the active workspace directory: "${workspacePath}".\n` +
          `- Do NOT read, write, create, or execute any commands in directories outside of "${workspacePath}".\n` +
          `- All file operations (read, write, list) and shell commands must be relative to or inside "${workspacePath}".\n` +
          `- Unless explicitly requested in your prompt to access a specific external path, you must not access any default home sandbox (~/.codex or ~/.cortex) or system directories.\n` +
          `- If you need to write temporary files, create a temporary folder INSIDE "${workspacePath}".\n` +
          `- If you cannot fulfill the request within "${workspacePath}", explain this limitation to the user.`;
      }
    }

    const hasSystemPlaceholder = this.argTemplates.some((a) => a.includes('{{SYSTEM}}'));
    const hasPromptPlaceholder = this.argTemplates.some((a) => a.includes('{{PROMPT}}'));

    const effectivePrompt =
      hasSystemPlaceholder || !systemContent
        ? userContent
        : `${systemContent}\n\n${userContent}`;

    const resolvedArgs = this.argTemplates.map((a) =>
      a.replace('{{SYSTEM}}', systemContent)
       .replace('{{PROMPT}}', effectivePrompt)
       .replace('{{MODEL}}', this.model ?? ''),
    );

    // When no {{PROMPT}} placeholder exists, build appropriate flags for the CLI.
    // stdin pipe is unreliable with some CLIs (e.g. claude), so we construct
    // explicit flags based on the command name.
    if (!hasPromptPlaceholder) {
      const cmd = this.command.toLowerCase();
      if (cmd === 'claude') {
        // Claude CLI: use -p for prompt, --system-prompt for system, --output-format stream-json --verbose for structured streaming
        if (systemContent) {
          resolvedArgs.push('--system-prompt', systemContent);
        }
        resolvedArgs.push('-p', userContent, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions');
        if (this.model) {
          resolvedArgs.push('--model', this.model);
        }
      } else if (cmd === 'gemini') {
        resolvedArgs.push('--skip-trust', '-p', effectivePrompt, '--output-format', 'stream-json', '--yolo');
        if (this.model) {
          resolvedArgs.push('--model', this.model);
        }
      } else if (cmd === 'copilot') {
        resolvedArgs.push('-p', userContent, '--yolo');
        if (this.model) {
          resolvedArgs.push('--model', this.model);
        }
      } else if (cmd === 'codex') {
        // Codex CLI: use -C to specify working root, then exec subcommand with positional prompt
        if (options?.cwd) {
          resolvedArgs.push('-C', options.cwd);
        }
        resolvedArgs.push('exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox');
        if (this.model) {
          resolvedArgs.push('--model', this.model);
        }
        resolvedArgs.push(effectivePrompt);
      } else {
        // Generic: append prompt as positional arg
        resolvedArgs.push(effectivePrompt);
      }
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = (val: string) => { if (!settled) { settled = true; resolve(val); } };
      const safeReject = (err: Error) => { if (!settled) { settled = true; reject(err); } };

      const finalArgs = [...resolvedArgs];
      if (this.command.toLowerCase() === 'gemini' && !finalArgs.includes('--skip-trust')) {
        finalArgs.unshift('--skip-trust');
      }

      let streamIdx = 0;
      const logCommand = `${this.command} ${finalArgs.map(arg => {
        if (arg.length > 200) {
          return `'${arg.slice(0, 200)}... [truncated ${arg.length - 200} chars]'`;
        }
        return arg.includes(' ') ? `'${arg}'` : arg;
      }).join(' ')}`;
      console.log(`[CliProvider] Spawning CLI: ${logCommand}`);

      if (options?.onStreamEvent) {
        options.onStreamEvent({
          index: streamIdx++,
          type: 'text',
          content: `\n> 💻 **CLI Command:** \`${logCommand}\`\n\n`,
        });
      }

      const child = spawn(this.command, finalArgs, {
        cwd: normalizeCwd(options?.cwd),
        env: {
          ...process.env,
          PATH: buildCliPath(),
          CI: '1',
          NO_COLOR: '1',
          TERM: 'dumb',
          COLUMNS: '10000',
          LINES: '10000',
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
          ...(this.model ? {
            ANTHROPIC_MODEL: this.model,
            ANTHROPIC_DEFAULT_SONNET_MODEL: this.model,
            GEMINI_MODEL: this.model,
            COPILOT_MODEL: this.model,
            MODEL: this.model,
          } : {}),
        },
        timeout: 15 * 60 * 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Close stdin immediately so CLIs don't wait for input
      child.stdin?.end();

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bufferStr = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout.push(chunk);
        
        if (options?.onStreamEvent) {
          bufferStr += chunk.toString('utf-8');
          const lines = bufferStr.split('\n');
          // Keep the last incomplete line in the buffer
          bufferStr = lines.pop() ?? ''; 

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            
            let handledAsJson = false;
            if (line.startsWith('{')) {
              try {
                const ev = JSON.parse(line) as Record<string, unknown>;
                const parsed = this.parseJsonLineEvents(ev, () => streamIdx++);
                for (const streamEvent of parsed.events) {
                  // Active-Kill Sandbox Guardrail for structured tool use
                  if (streamEvent.type === 'tool_use' && options?.cwd && !explicitlyRequestsExternalAccess(userContent, options.cwd)) {
                    const workspacePath = normalizeCwd(options.cwd);
                    if (workspacePath && isAttemptingUnauthorizedAccess(streamEvent.name ?? '', streamEvent.input || {}, workspacePath)) {
                      child.kill('SIGKILL');
                      safeReject(new Error(`[SECURITY VIOLATION] Agent attempted to access unauthorized path outside the workspace: ${JSON.stringify(streamEvent.input)}. Process killed.`));
                      return;
                    }
                  }
                  options.onStreamEvent(streamEvent);
                  handledAsJson = true;
                }
              } catch { /* ignore parsing errors and fallback to text */ }
            }
            
            if (!handledAsJson) {
              // Raw text output from CLI
              options.onStreamEvent({ index: streamIdx++, type: 'text', content: stripAnsi(rawLine) + '\n' });
            }
          }
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
        // Stream stderr as text events too — tools like codex write progress to stderr
        if (options?.onStreamEvent) {
          const text = stripAnsi(chunk.toString('utf-8')).trim();
          if (text) {
            options.onStreamEvent({ index: streamIdx++, type: 'text', content: text + '\n' });
          }
        }
      });

      child.on('error', (err) => {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          safeReject(new Error(
            `CLI "${this.command}" not found in PATH. ` +
            `Ensure it is installed and available to the server process. ` +
            `Current PATH: ${buildCliPath()}`,
          ));
          return;
        }
        safeReject(new Error(`CLI "${this.command}" failed to start: ${err.message}`));
      });

      // Abort support: kill child when signal fires
      if (options?.signal) {
        const signal = options.signal;
        if (signal.aborted) {
          // Signal already aborted before spawn — but don't reject immediately.
          // The process may still complete quickly. Kill it and let the 'close'
          // handler produce the proper error.
          child.kill('SIGTERM');
        } else {
          signal.addEventListener('abort', () => {
            child.kill('SIGTERM');
          }, { once: true });
        }
      }

      child.on('close', (code, signal) => {
        // SIGTERM (exit 143) means the process was intentionally killed — treat as abort
        if (signal === 'SIGTERM' || code === 143) {
          safeReject(new Error('Aborted'));
          return;
        }
        if (code !== 0) {
          let errText = stripAnsi(Buffer.concat(stderr).toString().trim()) || `exit code ${code}`;
          
          // Clean up progress/informational logs from stderr to reveal the actual error
          const lines = errText.split('\n');
          const filteredLines = lines.filter(line => {
            const trimmed = line.trim();
            return !trimmed.startsWith('Reading additional input from stdin') &&
                   !trimmed.startsWith('Thinking');
          });
          errText = filteredLines.join('\n').trim() || `exit code ${code}`;
          
          this._lastToolEvents = [];
          safeReject(new Error(`CLI "${this.command}" exited with error: ${errText}`));
          return;
        }
        const rawOutput = stripAnsi(Buffer.concat(stdout).toString().trim());
        const parsed = this.tryParseStreamJson(rawOutput);
        if (parsed) {
          this._lastToolEvents = parsed.toolEvents;
          safeResolve(parsed.output);
        } else {
          this._lastToolEvents = [];
          // Some CLIs (e.g. codex) write progress to stderr and only a brief result to stdout.
          // If stdout is empty, fall back to stderr content.
          const output = rawOutput || stripAnsi(Buffer.concat(stderr).toString().trim());
          safeResolve(output);
        }
      });
    });
  }
}
