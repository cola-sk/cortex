import { z } from 'zod';
import { TaskSchema, DecisionPointSchema } from '../core/plan.js';

export const PipelineConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  tasks: z.array(TaskSchema).default([]),
  decisions: z.array(DecisionPointSchema).default([]),
});

export const PipelineFileSchema = z.object({
  pipelines: z.record(z.string(), PipelineConfigSchema),
});

export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
export type PipelineFile = z.infer<typeof PipelineFileSchema>;
