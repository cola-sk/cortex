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

// CLI provider — invokes a local binary as a subprocess
// Args may contain {{SYSTEM}} and {{PROMPT}} placeholders.
// If {{SYSTEM}} is absent, the system prompt is prepended to {{PROMPT}}.
// If {{PROMPT}} is absent entirely, the prompt is appended as the last arg.
const CliProviderConfigSchema = z.object({
  type: z.literal('cli'),
  command: z.string(),
  args: z.array(z.string()).default([]),
});

export const ProviderConfigSchema = z.discriminatedUnion('type', [
  ClaudeProviderConfigSchema,
  OpenAICompatProviderConfigSchema,
  CliProviderConfigSchema,
]);

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// ---- Agent config schema ----

export const AGENT_ROLES = ['orchestrator', 'worker', 'reviewer', 'decider'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AgentConfigSchema = z.object({
  /** Display name shown in UI (optional, falls back to id) */
  name: z.string().optional(),
  /** Role of this agent in the system */
  role: z.enum(AGENT_ROLES).optional(),
  /** Short description shown in logs and UI */
  description: z.string().optional(),
  /** System prompt for this agent */
  system: z.string().default(''),
  /** Provider configuration — direct inline config */
  provider: ProviderConfigSchema.optional(),
  /** Reference to another agent whose provider config is inherited */
  baseAgent: z.string().optional(),
}).refine(
  (d) => d.provider != null || d.baseAgent != null,
  { message: 'Agent must specify either a provider or a baseAgent reference' },
);

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ---- Full config file schema ----

export const ConfigFileSchema = z.object({
  agents: z.record(z.string(), AgentConfigSchema),
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;
