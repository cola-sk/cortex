import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse as parseToml } from 'smol-toml';
import type { DetectedTool } from './types.js';

/**
 * Codex stores config in ~/.codex/config.toml
 * Key fields:
 *   model        → model name
 *   provider     → provider name (openai / custom)
 *   base_url     → custom base URL
 *   api_key      → API key (or from auth.json)
 */
export function detectCodex(): DetectedTool {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  const authPath = path.join(os.homedir(), '.codex', 'auth.json');

  if (!fs.existsSync(configPath)) {
    return { id: 'codex', name: 'Codex (OpenAI)', detected: false };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = parseToml(raw) as {
      model?: string;
      provider?: string;
      base_url?: string;
      api_key?: string;
    };

    // Try to get API key from auth.json if not in config
    let apiKey = config.api_key;
    if (!apiKey && fs.existsSync(authPath)) {
      try {
        const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as {
          OPENAI_API_KEY?: string | null;
          tokens?: { access_token?: string };
        };
        apiKey = auth.OPENAI_API_KEY ?? undefined;
        // If using OAuth tokens, note it but don't extract the JWT
        if (!apiKey && auth.tokens?.access_token) {
          apiKey = undefined; // OAuth, not a static key
        }
      } catch {
        // ignore
      }
    }

    const model = config.model ?? 'gpt-4o';
    const baseURL = config.base_url;

    const provider = {
      type: 'openai-compat' as const,
      baseURL: baseURL ?? 'https://api.openai.com/v1',
      model,
      ...(apiKey ? { apiKey } : {}),
    };

    return {
      id: 'codex',
      name: 'Codex (OpenAI)',
      detected: true,
      provider,
      model,
      note: baseURL ? `Custom endpoint: ${baseURL}` : 'Official OpenAI API',
    };
  } catch (e) {
    return {
      id: 'codex',
      name: 'Codex (OpenAI)',
      detected: true,
      note: `Parse error: ${(e as Error).message}`,
    };
  }
}
