import { z } from 'zod';

// ---- Task ----

export const TaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Agent key. Use an array to run multiple workers in PARALLEL on the same task. */
  agent: z.union([z.string(), z.array(z.string().min(1))]),
  /** Instruction / prompt for the worker agent */
  input: z.string(),
  /** IDs of tasks that must complete before this one runs */
  dependsOn: z.array(z.string()).default([]),
  /** When true, the runner pauses after this task completes and waits for human review */
  requiresReview: z.boolean().default(false),
  /**
   * When true, inject the current git diff (staged + unstaged) into the prompt.
   * Useful for API models doing code review — they can't access the filesystem,
   * but they can review the diff injected into their context.
   */
  gitDiff: z.boolean().default(false),
});

// ---- Decision Point ----

/**
 * A decision point is evaluated automatically by the runner once all
 * tasks listed in `evaluates` have completed.
 * The designated `agent` (decider) receives the task outputs and responds
 * with a JSON decision: continue | retry.
 * If "retry", the listed task ids are re-queued and the decision is re-evaluated.
 */
export const DecisionPointSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  /** Decider agent key */
  agent: z.string(),
  /** Task ids whose outputs the decider should evaluate */
  evaluates: z.array(z.string()).min(1),
  /** Maximum number of retry loops before forcing continue (default 3) */
  maxRetries: z.number().int().min(1).default(3),
});

// ---- Plan ----

export const PlanSchema = z.object({
  goal: z.string(),
  tasks: z.array(TaskSchema),
  /** Optional decision checkpoints — evaluated after the listed tasks complete */
  decisions: z.array(DecisionPointSchema).default([]),
});

export type Task = z.infer<typeof TaskSchema>;
export type DecisionPoint = z.infer<typeof DecisionPointSchema>;
export type Plan = z.infer<typeof PlanSchema>;

// ---- Results ----

export interface TaskResult {
  taskId: string;
  /** Combined outputs when multiple parallel workers ran this task */
  outputs: string[];
  /** Convenience: first output (or joined for parallel) */
  output: string;
  error?: string;
  /** Per-worker tool events — populated when the agent uses CLI provider with stream-json output */
  toolEvents?: import('./events.js').ToolEvent[][];
}

export type DecisionAction = 'continue' | 'retry';

export interface DecisionResult {
  action: DecisionAction;
  /** Task ids to re-run (only when action === 'retry') */
  retryTaskIds?: string[];
  reason: string;
}

// ---- Human Review ----

export interface ReviewAction {
  action: 'approve' | 'revise';
  comment: string;
  /** When revising, optionally target an upstream task instead of the current one */
  targetTaskId?: string;
  /** Optional agent override for the target task revision */
  agentId?: string;
}

export interface TaskRound {
  round: number;
  agents?: string[];
  input: string;
  output: string;
  toolEvents?: import('./events.js').ToolEvent[][];
  finishedAt: string;
  review?: {
    action: 'approve' | 'revise';
    comment: string;
    targetTaskId?: string;
    agentId?: string;
    reviewedAt: string;
  };
}
