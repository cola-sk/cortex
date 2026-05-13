import type { ToolEvent } from '../core/events.js';

// Core message types
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  onStreamEvent?: (event: ToolEvent) => void;
  signal?: AbortSignal;
}

// Unified LLM provider interface
export interface LLMProvider {
  readonly name: string;
  chat(messages: Message[], options?: ChatOptions): Promise<string>;
}
