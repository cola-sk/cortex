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
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: options.maxTokens ?? 8096,
      temperature: options.temperature,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const choice = response.choices[0];
    if (!choice?.message?.content) {
      throw new Error('Empty response from OpenAI-compatible provider');
    }
    return choice.message.content;
  }
}
