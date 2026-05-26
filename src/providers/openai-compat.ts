import OpenAI from 'openai';
import type { LLMProvider, Message, ChatOptions } from './base.js';

export interface OpenAICompatProviderConfig {
  /** HTTP endpoint base URL, e.g. http://localhost:11434/v1 (Ollama) */
  baseURL: string;
  apiKey?: string;
  model: string;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly name = 'openai-compat';
  private client: OpenAI;
  private model: string;

  constructor(config: OpenAICompatProviderConfig) {
    this.model = config.model;
    this.client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey ?? 'no-key',
    });
  }

  async chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
    const mappedMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Use streaming when onStreamEvent callback is provided
    if (options.onStreamEvent) {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: options.maxTokens ?? 8096,
        temperature: options.temperature,
        messages: mappedMessages,
        stream: true,
      }, { signal: options.signal });

      let fullContent = '';
      let eventIdx = 0;
      let pendingChunks = '';

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          pendingChunks += delta;

          // Emit text events in reasonable batches (on sentence/line boundaries or after accumulating enough)
          if (pendingChunks.includes('\n') || pendingChunks.length >= 80) {
            options.onStreamEvent({ index: eventIdx++, type: 'text', content: pendingChunks });
            pendingChunks = '';
          }
        }
      }

      // Flush remaining text
      if (pendingChunks) {
        options.onStreamEvent({ index: eventIdx++, type: 'text', content: pendingChunks });
      }

      if (!fullContent) {
        throw new Error('Empty response from OpenAI-compatible provider');
      }
      return fullContent;
    }

    // Non-streaming fallback
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: options.maxTokens ?? 8096,
      temperature: options.temperature,
      messages: mappedMessages,
    }, { signal: options.signal });

    const choice = response.choices[0];
    if (!choice?.message?.content) {
      throw new Error('Empty response from OpenAI-compatible provider');
    }
    return choice.message.content;
  }
}
