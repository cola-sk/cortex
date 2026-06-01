import type { LLMProvider, Message, ChatOptions } from '../providers/index.js';
import { ClaudeProvider } from '../providers/claude.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import { CliProvider } from '../providers/cli.js';
import type { AgentConfig, ProviderConfig } from '../config/schema.js';import type { ToolEvent } from './events.js';
export class Agent {
  readonly id: string;
  readonly systemPrompt: string;
  private provider: LLMProvider;

  constructor(id: string, config: AgentConfig & { provider: ProviderConfig }) {
    this.id = id;
    this.systemPrompt = config.system;
    this.provider = Agent.createProvider(config.provider);
  }

  async chat(userMessage: string, history: Message[] = [], options?: ChatOptions): Promise<string> {
    const messages: Message[] = [
      { role: 'system', content: this.systemPrompt },
      ...history,
      { role: 'user', content: userMessage },
    ];
    return this.provider.chat(messages, options);
  }

  /** Returns tool events from the most recent chat() call. Only populated for CLI providers using stream-json output format. */
  getLastToolEvents(): ToolEvent[] {
    if (this.provider instanceof CliProvider) {
      return this.provider.getLastToolEvents();
    }
    return [];
  }

  /** Returns true if this agent's provider supports multi-turn message history (API providers). CLI providers don't. */
  supportsHistory(): boolean {
    return !(this.provider instanceof CliProvider);
  }

  /** Returns true if this agent uses a CLI provider (local subprocess). */
  isCli(): boolean {
    return this.provider instanceof CliProvider;
  }

  private static createProvider(provider: ProviderConfig): LLMProvider {
    switch (provider.type) {
      case 'claude':
        return new ClaudeProvider({
          apiKey: provider.apiKey,
          baseURL: provider.baseURL,
          model: provider.model,
        });
      case 'openai-compat':
        return new OpenAICompatProvider({
          baseURL: provider.baseURL,
          apiKey: provider.apiKey,
          model: provider.model,
        });
      case 'cli':
        return new CliProvider({
          command: provider.command,
          args: provider.args,
          model: provider.model,
        });
    }
  }
}
