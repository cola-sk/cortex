export type ProviderType = 'claude' | 'openai-compat';

export type AgentRole = 'orchestrator' | 'worker' | 'reviewer' | 'decider';

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
  role?: AgentRole;
  description?: string;
  system: string;
  provider: Provider;
}

export interface ApiError {
  error: string;
}
