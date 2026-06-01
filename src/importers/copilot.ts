import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import type { DetectedTool } from './types.js';

function which(cmd: string): string | null {
  try { return execSync(`which ${cmd}`, { stdio: 'pipe' }).toString().trim(); } catch { return null; }
}

/**
 * GitHub Copilot CLI: invokes the `copilot` CLI binary as a subprocess.
 * Passes user prompt via -p, enables full auto-approvals via --yolo.
 */
export function detectCopilot(): DetectedTool {
  const configDir = path.join(os.homedir(), '.copilot');
  const cliPath = which('copilot');

  if (!fs.existsSync(configDir) && !cliPath) {
    return { id: 'copilot', name: 'GitHub Copilot CLI', detected: false };
  }

  if (!cliPath) {
    return {
      id: 'copilot',
      name: 'GitHub Copilot CLI',
      detected: true,
      note: '`copilot` binary not found in PATH. Install GitHub Copilot CLI first.',
    };
  }

  let model = 'copilot-default';
  try {
    const settingsPath = path.join(configDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { model?: string };
      model = settings.model ?? model;
    }
  } catch { /* ignore */ }

  return {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    detected: true,
    model,
    note: `CLI: ${cliPath}`,
    provider: {
      type: 'cli' as const,
      command: 'copilot',
      args: ['--output-format', 'json', '--stream', 'on', '-p', '{{PROMPT}}', '--yolo'],
    },
  };
}
