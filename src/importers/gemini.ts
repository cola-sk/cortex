import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import type { DetectedTool } from './types.js';

function which(cmd: string): string | null {
  try { return execSync(`which ${cmd}`, { stdio: 'pipe' }).toString().trim(); } catch { return null; }
}

/**
 * Gemini CLI: invokes `gemini` as a subprocess.
 * System prompt is folded into the prompt (no dedicated system flag).
 */
export function detectGemini(): DetectedTool {
  const settingsPath = path.join(os.homedir(), '.gemini', 'settings.json');
  const cliPath = which('gemini');

  if (!fs.existsSync(settingsPath) && !cliPath) {
    return { id: 'gemini', name: 'Gemini CLI', detected: false };
  }

  if (!cliPath) {
    return {
      id: 'gemini',
      name: 'Gemini CLI',
      detected: true,
      note: '`gemini` binary not found in PATH. Install Gemini CLI first.',
    };
  }

  let model = 'gemini-2.5-pro';
  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { model?: string };
      model = settings.model ?? model;
    }
  } catch { /* ignore */ }

  return {
    id: 'gemini',
    name: 'Gemini CLI',
    detected: true,
    model,
    note: `CLI: ${cliPath}`,
    provider: {
      type: 'cli' as const,
      command: 'gemini',
      args: ['-p', '{{PROMPT}}', '--output-format', 'stream-json', '--yolo'],
    },
  };
}
