import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, Message, ChatOptions } from './base.js';

export interface ClaudeProviderConfig {
  /** Anthropic API key. Defaults to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Custom base URL, e.g. a proxy or local claude-code compatible server. */
  baseURL?: string;
  /** Model to use. Defaults to claude-sonnet-4-5. */
  model?: string;
}

export class ClaudeProvider implements LLMProvider {
  readonly name = 'claude';
  private client: Anthropic;
  private model: string;

  constructor(config: ClaudeProviderConfig = {}) {
    this.model = config.model ?? 'claude-sonnet-4-5';
    this.client = new Anthropic({
      apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
  }

  async chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
    const systemMessage = messages.find((m) => m.role === 'system');
    const userMessages = messages.filter((m) => m.role !== 'system');

    const createParams = {
      model: this.model,
      max_tokens: options.maxTokens ?? 8096,
      ...(systemMessage ? { system: systemMessage.content } : {}),
      messages: userMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    };

    // Use streaming when onStreamEvent callback is provided
    if (options.onStreamEvent) {
      const stream = this.client.messages.stream(createParams, { signal: options.signal });

      let fullContent = '';
      let eventIdx = 0;
      let pendingChunks = '';

      stream.on('text', (text) => {
        fullContent += text;
        pendingChunks += text;

        if (pendingChunks.includes('\n') || pendingChunks.length >= 80) {
          options.onStreamEvent!({ index: eventIdx++, type: 'text', content: pendingChunks });
          pendingChunks = '';
        }
      });

      await stream.finalMessage();

      // Flush remaining text
      if (pendingChunks) {
        options.onStreamEvent({ index: eventIdx++, type: 'text', content: pendingChunks });
      }

      if (!fullContent) {
        throw new Error('Empty response from Claude');
      }
      return fullContent;
    }

    // Non-streaming fallback
    const response = await this.client.messages.create(createParams, { signal: options.signal });

    const block = response.content[0];
    if (block.type !== 'text') {
      throw new Error(`Unexpected response type: ${block.type}`);
    }
    return block.text;
  }
}
