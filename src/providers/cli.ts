import { spawn } from 'child_process';
import type { LLMProvider, Message, ChatOptions } from './base.js';

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

  constructor(opts: CliProviderOptions) {
    this.command = opts.command;
    this.argTemplates = opts.args;
    this.name = `cli:${opts.command}`;
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
          reject(new Error(`CLI "${this.command}" exited with error: ${errText}`));
          return;
        }
        resolve(stripAnsi(Buffer.concat(stdout).toString().trim()));
      });
    });
  }
}
