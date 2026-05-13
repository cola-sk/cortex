import type { LLMProvider, Message, ChatOptions } from '../providers/index.js';
import { ClaudeProvider } from '../providers/claude.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import { CliProvider } from '../providers/cli.js';
import type { AgentConfig } from '../config/schema.js';

export class Agent {
  readonly id: string;
  readonly systemPrompt: string;
  private provider: LLMProvider;

  constructor(id: string, config: AgentConfig) {
    this.id = id;
    this.systemPrompt = config.system;
    this.provider = Agent.createProvider(config);
  }

  async chat(userMessage: string, history: Message[] = [], options?: ChatOptions): Promise<string> {
    const messages: Message[] = [
      { role: 'system', content: this.systemPrompt },
      ...history,
      { role: 'user', content: userMessage },
    ];
    return this.provider.chat(messages, options);
  }

  private static createProvider(config: AgentConfig): LLMProvider {
    switch (config.provider.type) {
      case 'claude':
        return new ClaudeProvider({
          apiKey: config.provider.apiKey,
          baseURL: config.provider.baseURL,
          model: config.provider.model,
        });
      case 'openai-compat':
        return new OpenAICompatProvider({
          baseURL: config.provider.baseURL,
          apiKey: config.provider.apiKey,
          model: config.provider.model,
        });
      case 'cli':
        return new CliProvider({
          command: config.provider.command,
          args: config.provider.args,
        });
    }
  }
}
