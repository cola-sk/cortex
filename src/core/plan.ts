import { z } from 'zod';

// Structured plan produced by the Orchestrator
export const TaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Key in agents.yaml that should execute this task */
  agent: z.string(),
  /** Instruction / prompt for the worker agent */
  input: z.string(),
  /** IDs of tasks that must complete before this one */
  dependsOn: z.array(z.string()).default([]),
});

export const PlanSchema = z.object({
  goal: z.string(),
  tasks: z.array(TaskSchema),
});

export type Task = z.infer<typeof TaskSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export interface TaskResult {
  taskId: string;
  output: string;
  error?: string;
}
