export type ProviderType = 'claude' | 'openai-compat' | 'cli';

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

export interface CliProvider {
  type: 'cli';
  command: string;
  args: string[];
}

export type Provider = ClaudeProvider | OpenAICompatProvider | CliProvider;

export interface Agent {
  id: string;
  name?: string;
  role?: AgentRole;
  description?: string;
  system: string;
  provider?: Provider;
  /** References another agent's ID whose provider config is inherited */
  baseAgent?: string;
}

// ---- Pipeline types ----

export interface PipelineTask {
  id: string;
  name: string;
  /** Single agent key, or array for parallel workers */
  agent: string | string[];
  input: string;
  dependsOn: string[];
}

export interface PipelineDecision {
  id: string;
  name?: string;
  agent: string;
  evaluates: string[];
  maxRetries: number;
}

export interface Pipeline {
  id: string;
  name: string;
  description?: string;
  tasks: PipelineTask[];
  decisions: PipelineDecision[];
}

// ---- Run event types ----

export type RunEventType =
  | 'task:start'
  | 'task:complete'
  | 'decision:start'
  | 'decision:complete'
  | 'complete'
  | 'error';

export interface RunEvent {
  type: RunEventType;
  data: unknown;
}

export interface ApiError {
  error: string;
}
