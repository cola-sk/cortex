import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { parse as parseToml } from 'smol-toml';
import type { DetectedTool } from './types.js';

function which(cmd: string): string | null {
  try { return execSync(`which ${cmd}`, { stdio: 'pipe' }).toString().trim(); } catch { return null; }
}

/**
 * Codex CLI: invokes `codex` as a subprocess.
 * System prompt is folded into the prompt (no dedicated system flag).
 */
export function detectCodex(): DetectedTool {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  const cliPath = which('codex');

  if (!fs.existsSync(configPath) && !cliPath) {
    return { id: 'codex', name: 'Codex (OpenAI)', detected: false };
  }

  if (!cliPath) {
    return {
      id: 'codex',
      name: 'Codex (OpenAI)',
      detected: true,
      note: '`codex` binary not found in PATH. Install OpenAI Codex CLI first.',
    };
  }

  let model = 'o4-mini';
  try {
    if (fs.existsSync(configPath)) {
      const cfg = parseToml(fs.readFileSync(configPath, 'utf-8')) as { model?: string };
      model = cfg.model ?? model;
    }
  } catch { /* ignore */ }

  return {
    id: 'codex',
    name: 'Codex (OpenAI)',
    detected: true,
    model,
    note: `CLI: ${cliPath}`,
    provider: {
      type: 'cli' as const,
      command: 'codex',
      // `exec` is the non-interactive subcommand; prompt is passed as positional arg
      // stdin is inherited (TTY) so user can approve permissions interactively
      args: ['exec', '{{PROMPT}}'],
    },
  };
}
