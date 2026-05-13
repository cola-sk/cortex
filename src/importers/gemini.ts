import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DetectedTool } from './types.js';

/**
 * Gemini CLI stores config in ~/.gemini/settings.json
 * Uses OAuth by default (no static API key).
 * Gemini exposes an OpenAI-compatible endpoint at:
 *   https://generativelanguage.googleapis.com/v1beta/openai/
 */
export function detectGemini(): DetectedTool {
  const settingsPath = path.join(os.homedir(), '.gemini', 'settings.json');

  if (!fs.existsSync(settingsPath)) {
    return { id: 'gemini', name: 'Gemini CLI', detected: false };
  }

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      apiKey?: string;
      model?: string;
      security?: { auth?: { selectedType?: string; apiKey?: string } };
    };

    const apiKey =
      settings.apiKey ||
      settings.security?.auth?.apiKey ||
      process.env['GEMINI_API_KEY'] ||
      process.env['GOOGLE_API_KEY'] ||
      undefined;

    const model = settings.model ?? 'gemini-2.5-pro';
    const authType = settings.security?.auth?.selectedType ?? 'unknown';
    const isOAuth = authType.includes('oauth') || authType.includes('personal');

    const provider = {
      type: 'openai-compat' as const,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model,
      ...(apiKey ? { apiKey } : {}),
    };

    return {
      id: 'gemini',
      name: 'Gemini CLI',
      detected: true,
      provider,
      model,
      note: isOAuth
        ? 'OAuth login detected — set GEMINI_API_KEY env var for API key auth'
        : apiKey
          ? 'API key found'
          : 'No API key found',
    };
  } catch (e) {
    return {
      id: 'gemini',
      name: 'Gemini CLI',
      detected: true,
      note: `Parse error: ${(e as Error).message}`,
    };
  }
}
