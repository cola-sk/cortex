import { spawn } from 'child_process';
import path from 'path';
import type { LLMProvider, Message, ChatOptions } from './base.js';
import type { ToolEvent } from '../core/events.js';

export interface CliProviderOptions {
  command: string;
  /** Arg templates. Use {{SYSTEM}} for system prompt, {{PROMPT}} for user input. */
  args: string[];
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
  private _lastToolEvents: ToolEvent[] = [];

  constructor(opts: CliProviderOptions) {
    this.command = opts.command;
    this.argTemplates = opts.args;
    this.name = `cli:${opts.command}`;
  }

  /** Returns tool events from the most recent chat() call (populated when CLI uses --output-format stream-json). */
  getLastToolEvents(): ToolEvent[] {
    return this._lastToolEvents;
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
    let resultOutput = '';
    let hasEvents = false;

    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;

        if (ev.type === 'assistant') {
          hasEvents = true;
          const msg = ev.message as { content?: Array<Record<string, unknown>> };
          for (const block of msg?.content ?? []) {
            if (block.type === 'text' && block.text) {
              toolEvents.push({ index: idx++, type: 'text', content: block.text as string });
              textParts.push(block.text as string);
            } else if (block.type === 'tool_use') {
              toolEvents.push({
                index: idx++,
                type: 'tool_use',
                name: block.name as string,
                input: block.input as Record<string, unknown>,
                toolUseId: block.id as string,
              });
            }
          }
        } else if (ev.type === 'tool') {
          hasEvents = true;
          const content = ev.content as Array<{ type: string; text?: string }> | undefined;
          const text = content?.map((c) => c.text ?? '').join('') ?? String(ev.content ?? '');
          toolEvents.push({
            index: idx++,
            type: 'tool_result',
            content: text,
            toolUseId: ev.tool_use_id as string,
            isError: ev.is_error as boolean | undefined,
          });
        } else if (ev.type === 'result') {
          hasEvents = true;
          if (ev.result) resultOutput = ev.result as string;
        }
      } catch { /* non-JSON line */ }
    }

    if (!hasEvents) return null;
    // Prefer the `result` event output (Claude CLI's final summary).
    // Fall back to concatenated text blocks from assistant events.
    const finalOutput = resultOutput || textParts.join('\n\n') || raw;
    return { output: finalOutput, toolEvents };
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    const systemContent = messages.find((m) => m.role === 'system')?.content ?? '';
    const userContent = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n\n');

    const hasSystemPlaceholder = this.argTemplates.some((a) => a.includes('{{SYSTEM}}'));
    const hasPromptPlaceholder = this.argTemplates.some((a) => a.includes('{{PROMPT}}'));

    const effectivePrompt =
      hasSystemPlaceholder || !systemContent
        ? userContent
        : `${systemContent}\n\n${userContent}`;

    const resolvedArgs = this.argTemplates.map((a) =>
      a.replace('{{SYSTEM}}', systemContent).replace('{{PROMPT}}', effectivePrompt),
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
      } else if (cmd === 'codex') {
        // Codex CLI: use exec subcommand with positional prompt
        resolvedArgs.push('exec', effectivePrompt);
      } else {
        // Generic: append prompt as positional arg
        resolvedArgs.push(effectivePrompt);
      }
    }

    return new Promise((resolve, reject) => {
      const child = spawn(this.command, resolvedArgs, {
        cwd: normalizeCwd(options?.cwd),
        env: {
          ...process.env,
          PATH: buildCliPath(),
          CI: '1',
          NO_COLOR: '1',
          TERM: 'dumb',
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
        },
        timeout: 15 * 60 * 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Close stdin immediately so CLIs don't wait for input
      child.stdin?.end();

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bufferStr = '';
      let streamIdx = 0;

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
                let streamEvent: ToolEvent | null = null;

                if (ev.type === 'assistant') {
                  const msg = ev.message as { content?: Array<Record<string, unknown>> };
                  for (const block of msg?.content ?? []) {
                    if (block.type === 'text' && block.text) {
                      streamEvent = { index: streamIdx++, type: 'text', content: block.text as string };
                    } else if (block.type === 'tool_use') {
                      streamEvent = {
                        index: streamIdx++,
                        type: 'tool_use',
                        name: block.name as string,
                        input: block.input as Record<string, unknown>,
                        toolUseId: block.id as string,
                      };
                    }
                    if (streamEvent) {
                      options.onStreamEvent(streamEvent);
                      handledAsJson = true;
                    }
                  }
                } else if (ev.type === 'tool') {
                  const content = ev.content as Array<{ type: string; text?: string }> | undefined;
                  const text = content?.map((c) => c.text ?? '').join('') ?? String(ev.content ?? '');
                  streamEvent = {
                    index: streamIdx++,
                    type: 'tool_result',
                    content: text,
                    toolUseId: ev.tool_use_id as string,
                    isError: ev.is_error as boolean | undefined,
                  };
                  options.onStreamEvent(streamEvent);
                  handledAsJson = true;
                }
              } catch { /* ignore parsing errors and fallback to text */ }
            }
            
            if (!handledAsJson) {
              // Raw text output from CLI
              options.onStreamEvent({ index: streamIdx++, type: 'text', content: stripAnsi(rawLine) });
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
            options.onStreamEvent({ index: streamIdx++, type: 'text', content: text });
          }
        }
      });

      child.on('error', (err) => {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          reject(new Error(
            `CLI "${this.command}" not found in PATH. ` +
            `Ensure it is installed and available to the server process. ` +
            `Current PATH: ${buildCliPath()}`,
          ));
          return;
        }
        reject(new Error(`CLI "${this.command}" failed to start: ${err.message}`));
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
          reject(new Error('Aborted'));
          return;
        }
        if (code !== 0) {
          const errText = stripAnsi(Buffer.concat(stderr).toString().trim()) || `exit code ${code}`;
          this._lastToolEvents = [];
          reject(new Error(`CLI "${this.command}" exited with error: ${errText}`));
          return;
        }
        const rawOutput = stripAnsi(Buffer.concat(stdout).toString().trim());
        const parsed = this.tryParseStreamJson(rawOutput);
        if (parsed) {
          this._lastToolEvents = parsed.toolEvents;
          resolve(parsed.output);
        } else {
          this._lastToolEvents = [];
          // Some CLIs (e.g. codex) write progress to stderr and only a brief result to stdout.
          // If stdout is empty, fall back to stderr content.
          const output = rawOutput || stripAnsi(Buffer.concat(stderr).toString().trim());
          resolve(output);
        }
      });
    });
  }
}
