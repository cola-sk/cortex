import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DetectedTool } from './types.js';

/**
 * Claude Code stores provider config in ~/.claude/settings.json under `env`.
 * Key fields:
 *   env.ANTHROPIC_AUTH_TOKEN  → apiKey
 *   env.ANTHROPIC_BASE_URL    → baseURL
 *   env.ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_SONNET_MODEL → model
 */
export function detectClaudeCode(): DetectedTool {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  if (!fs.existsSync(settingsPath)) {
    return { id: 'claude-code', name: 'Claude Code', detected: false };
  }

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      env?: Record<string, string>;
      model?: string;
    };

    const env = settings.env ?? {};
    const apiKey = env['ANTHROPIC_AUTH_TOKEN'] || env['ANTHROPIC_API_KEY'] || undefined;
    const baseURL = env['ANTHROPIC_BASE_URL'] || undefined;
    const model =
      env['ANTHROPIC_MODEL'] ||
      env['ANTHROPIC_DEFAULT_SONNET_MODEL'] ||
      settings.model ||
      'claude-sonnet-4-5';

    // If a custom baseURL is set, use openai-compat; otherwise claude (official)
    const hasCustomEndpoint = !!baseURL;

    const provider = hasCustomEndpoint
      ? {
          type: 'openai-compat' as const,
          baseURL: baseURL.endsWith('/v1') ? baseURL : `${baseURL}/v1`,
          model,
          ...(apiKey ? { apiKey } : {}),
        }
      : {
          type: 'claude' as const,
          model,
          ...(apiKey ? { apiKey } : {}),
        };

    return {
      id: 'claude-code',
      name: 'Claude Code',
      detected: true,
      provider,
      model,
      note: hasCustomEndpoint ? `Custom endpoint: ${baseURL}` : 'Official Anthropic API',
    };
  } catch (e) {
    return {
      id: 'claude-code',
      name: 'Claude Code',
      detected: true,
      note: `Parse error: ${(e as Error).message}`,
    };
  }
}
