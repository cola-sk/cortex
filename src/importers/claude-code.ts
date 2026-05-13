import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import type { DetectedTool } from './types.js';

function which(cmd: string): string | null {
  try { return execSync(`which ${cmd}`, { stdio: 'pipe' }).toString().trim(); } catch { return null; }
}

/**
 * Claude Code: invokes the `claude` CLI binary as a subprocess.
 * Passes system prompt via --system-prompt flag, user prompt via -p.
 */
export function detectClaudeCode(): DetectedTool {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const cliPath = which('claude');

  if (!fs.existsSync(settingsPath) && !cliPath) {
    return { id: 'claude-code', name: 'Claude Code', detected: false };
  }

  if (!cliPath) {
    return {
      id: 'claude-code',
      name: 'Claude Code',
      detected: true,
      note: '`claude` binary not found in PATH. Install Claude Code CLI first.',
    };
  }

  let model = 'claude-sonnet-4-5';
  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        env?: Record<string, string>; model?: string;
      };
      model =
        settings.env?.['ANTHROPIC_MODEL'] ||
        settings.env?.['ANTHROPIC_DEFAULT_SONNET_MODEL'] ||
        settings.model ||
        model;
    }
  } catch { /* ignore */ }

  return {
    id: 'claude-code',
    name: 'Claude Code',
    detected: true,
    model,
    note: `CLI: ${cliPath}`,
    provider: {
      type: 'cli' as const,
      command: 'claude',
      args: ['--system-prompt', '{{SYSTEM}}', '-p', '{{PROMPT}}', '--output-format', 'text', '--dangerously-skip-permissions'],
    },
  };
}
