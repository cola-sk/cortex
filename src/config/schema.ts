import { z } from 'zod';

// ---- Provider config schemas ----

const ClaudeProviderConfigSchema = z.object({
  type: z.literal('claude'),
  apiKey: z.string().optional(),
  baseURL: z.string().url().optional(),
  model: z.string().optional(),
});

const OpenAICompatProviderConfigSchema = z.object({
  type: z.literal('openai-compat'),
  baseURL: z.string().url(),
  apiKey: z.string().optional(),
  model: z.string(),
});

export const ProviderConfigSchema = z.discriminatedUnion('type', [
  ClaudeProviderConfigSchema,
  OpenAICompatProviderConfigSchema,
]);

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// ---- Agent config schema ----

export const AgentConfigSchema = z.object({
  /** Role description shown in logs */
  description: z.string().optional(),
  /** System prompt for this agent */
  system: z.string(),
  /** Provider configuration */
  provider: ProviderConfigSchema,
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ---- Full config file schema ----

export const ConfigFileSchema = z.object({
  agents: z.record(z.string(), AgentConfigSchema),
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;
