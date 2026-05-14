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
  /** When true, runner pauses after this task for human review */
  requiresReview?: boolean;
  /** When true, inject git diff HEAD output into this task's prompt */
  gitDiff?: boolean;
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
  /** Working directory for CLI agents and gitDiff. Defaults to server cwd. */
  workspace?: string;
  tasks: PipelineTask[];
  decisions: PipelineDecision[];
}

// ---- Run event types ----

export type RunEventType =
  | 'task:start'
  | 'task:tool_event'
  | 'task:complete'
  | 'worker:complete'
  | 'decision:start'
  | 'decision:complete'
  | 'review:pending'
  | 'review:submitted'
  | 'task:revision'
  | 'task:rollback'
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

export interface ReviewRecord {
  action: 'approve' | 'revise';
  comment: string;
  targetTaskId?: string;
  reviewedAt: string;
}

export interface RoundRecord {
  round: number;
  output: string;
  toolEvents?: ToolEvent[][];
  finishedAt: string;
  review?: ReviewRecord;
}

export interface RunTaskRecord {
  taskId: string;
  taskName: string;
  agents: string[];
  status: 'pending' | 'running' | 'done' | 'error' | 'awaiting_review';
  requiresReview?: boolean;
  currentRound?: number;
  rounds?: RoundRecord[];
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  output?: string;
  outputs?: string[];
  error?: string;
  /** Per-worker tool events (only for CLI agents using stream-json output) */
  toolEvents?: ToolEvent[][];
  /** Per-worker completion status */
  workerStatus?: ('running' | 'done' | 'error')[];
}

export interface RunSummary {
  id: string;
  pipelineId: string;
  pipelineName: string;
  goal: string;
  status: 'running' | 'done' | 'error' | 'awaiting_review';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  taskCount: number;
  toolCallCount: number;
}

export interface RunRecord extends RunSummary {
  tasks: RunTaskRecord[];
}
