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
  | 'task:tool_event'
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

// ---- Run history types ----

export type ToolEventType = 'tool_use' | 'tool_result' | 'text';

export interface ToolEvent {
  index: number;
  type: ToolEventType;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  toolUseId?: string;
  isError?: boolean;
}

export interface RunTaskRecord {
  taskId: string;
  taskName: string;
  agents: string[];
  status: 'pending' | 'running' | 'done' | 'error';
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  output?: string;
  error?: string;
  /** Per-worker tool events (only for CLI agents using stream-json output) */
  toolEvents?: ToolEvent[][];
}

export interface RunSummary {
  id: string;
  pipelineId: string;
  pipelineName: string;
  goal: string;
  status: 'running' | 'done' | 'error';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  taskCount: number;
  toolCallCount: number;
}

export interface RunRecord extends RunSummary {
  tasks: RunTaskRecord[];
}
