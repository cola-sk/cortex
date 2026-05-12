export type ProviderType = 'claude' | 'openai-compat';

export interface ClaudeProvider {
  type: 'claude';
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export interface OpenAICompatProvider {
  type: 'openai-compat';
  baseURL: string;
  apiKey?: string;
  model: string;
}

export type Provider = ClaudeProvider | OpenAICompatProvider;

export interface Agent {
  id: string;
  description?: string;
  system: string;
  provider: Provider;
}

export interface ApiError {
  error: string;
}
