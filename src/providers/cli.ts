import type { LLMProvider, Message, ChatOptions } from './base.js';
import type { ToolEvent } from '../core/events.js';
import { buildCliInvocation, runCliAgent } from '@sking7/agent-cli-unified';

export interface CliProviderOptions {
  command: string;
  args: string[];
  model?: string;
}

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

  getLastToolEvents(): ToolEvent[] {
    return this._lastToolEvents;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    const systemContent = messages.find((m) => m.role === 'system')?.content ?? '';
    const userContent = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n\n');

    // 1. Build CLI invocation via agent-cli-unified
    const invocation = buildCliInvocation({
      agent: this.command,
      prompt: userContent,
      cwd: options?.cwd,
      systemPrompt: systemContent,
      model: this.model,
      argsTemplate: this.argTemplates,
      sandbox: {
        restrictToWorkspace: true,
      },
    });

    // 2. Generate standard command line output for cortex UX
    const logCommand = `${invocation.command} ${invocation.args.map(arg => {
      if (arg.length > 200) {
        return `'${arg.slice(0, 200)}... [truncated ${arg.length - 200} chars]'`;
      }
      return arg.includes(' ') ? `'${arg}'` : arg;
    }).join(' ')}`;
    
    console.log(`[CliProvider] Spawning CLI: ${logCommand}`);

    let streamIdx = 0;
    if (options?.onStreamEvent) {
      options.onStreamEvent({
        index: streamIdx++,
        type: 'text',
        content: `\n> 💻 **CLI Command:** \`${logCommand}\`\n\n`,
      });
    }

    // 3. Execute the CLI Agent via agent-cli-unified
    const result = await runCliAgent({
      agent: this.command,
      prompt: userContent,
      cwd: options?.cwd,
      commandPath: invocation.command,
      argsOverride: invocation.args,
      sandbox: {
        restrictToWorkspace: true,
      },
      onEvent: (event) => {
        if (options?.onStreamEvent) {
          options.onStreamEvent({
            index: streamIdx++,
            type: event.type,
            name: event.name,
            input: event.input,
            content: event.text || event.content,
            toolUseId: event.toolUseId,
            isError: event.isError,
          });
        }
      },
    });

    // 4. Update tool events history
    this._lastToolEvents = (result.events || []).map((event, idx) => ({
      index: idx,
      type: event.type,
      name: event.name,
      input: event.input,
      content: event.text || event.content,
      toolUseId: event.toolUseId,
      isError: event.isError,
    }));

    if (!result.ok) {
      let errText = result.stderr || `exit code ${result.exitCode}`;
      const lines = errText.split('\n');
      const filteredLines = lines.filter(line => {
        const trimmed = line.trim();
        return !trimmed.startsWith('Reading additional input from stdin') &&
               !trimmed.startsWith('Thinking');
      });
      errText = filteredLines.join('\n').trim() || `exit code ${result.exitCode}`;
      throw new Error(`CLI "${this.command}" exited with error: ${errText}`);
    }

    // 5. Resolve output content
    const resultEvent = result.events.find(e => e.type === 'json' && e.payload?.type === 'result');
    if (resultEvent && typeof resultEvent.payload.result === 'string') {
      return resultEvent.payload.result;
    }

    const textEvents = result.events.filter(e => e.type === 'text');
    if (textEvents.length > 0) {
      // Smart join: agy/--print outputs one plain-text line per event (no trailing \n),
      // while claude stream-json outputs multi-line blocks per event (already has \n).
      // Insert \n between events only when the previous event text doesn't already end with one.
      return textEvents.reduce((acc: string, e: { text?: string }, i: number) => {
        const chunk = e.text ?? '';
        if (i === 0) return chunk;
        return acc.endsWith('\n') ? acc + chunk : acc + '\n' + chunk;
      }, '');
    }

    return result.stdout || result.stderr;
  }
}
