import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import type { DetectedTool } from './types.js';

interface HermesConfig {
  model?: {
    default?: string;
    provider?: string;
    base_url?: string;
    api_key?: string;
  };
}

/**
 * Hermes Agent stores config in ~/.hermes/config.yaml
 * Key fields:
 *   model.api_key  → apiKey
 *   model.base_url → baseURL
 *   model.default  → model name
 */
export function detectHermes(): DetectedTool {
  const configPath = path.join(os.homedir(), '.hermes', 'config.yaml');

  if (!fs.existsSync(configPath)) {
    return { id: 'hermes', name: 'Hermes Agent', detected: false };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = yaml.load(raw) as HermesConfig;
    const modelConfig = config?.model ?? {};

    const apiKey = modelConfig.api_key || undefined;
    const baseURL = modelConfig.base_url || undefined;
    const model = modelConfig.default ?? 'default';

    if (!baseURL) {
      return {
        id: 'hermes',
        name: 'Hermes Agent',
        detected: true,
        note: 'No base_url found in config',
      };
    }

    const provider = {
      type: 'openai-compat' as const,
      baseURL: baseURL.endsWith('/v1') ? baseURL : `${baseURL}`,
      model,
      ...(apiKey ? { apiKey } : {}),
    };

    return {
      id: 'hermes',
      name: 'Hermes Agent',
      detected: true,
      provider,
      model,
      note: `${modelConfig.provider ?? 'custom'} · ${baseURL}`,
    };
  } catch (e) {
    return {
      id: 'hermes',
      name: 'Hermes Agent',
      detected: true,
      note: `Parse error: ${(e as Error).message}`,
    };
  }
}
