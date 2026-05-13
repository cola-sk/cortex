import { spawn } from 'child_process';
import type { LLMProvider, Message, ChatOptions } from './base.js';
import type { ToolEvent } from '../core/events.js';

export interface CliProviderOptions {
  command: string;
  /** Arg templates. Use {{SYSTEM}} for system prompt, {{PROMPT}} for user input. */
  args: string[];
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
    let finalOutput = '';
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
              finalOutput = block.text as string;
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
          if (ev.result) finalOutput = ev.result as string;
        }
      } catch { /* non-JSON line */ }
    }

    if (!hasEvents) return null;
    return { output: finalOutput || raw, toolEvents };
  }

  async chat(messages: Message[], _options?: ChatOptions): Promise<string> {
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

    if (!hasPromptPlaceholder) {
      resolvedArgs.push(effectivePrompt);
    }

    return new Promise((resolve, reject) => {
      const child = spawn(this.command, resolvedArgs, {
        env: {
          ...process.env,
          CI: '1',
          NO_COLOR: '1',
          TERM: 'dumb',
        },
        timeout: 15 * 60 * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

      child.on('error', (err) => reject(new Error(`CLI "${this.command}" failed to start: ${err.message}`)));

      child.on('close', (code) => {
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
          resolve(rawOutput);
        }
      });
    });
  }
}
