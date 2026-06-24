import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse as parseToml } from 'smol-toml';
import type { DetectedAgent } from '@sking7/agent-cli-unified';
import type { DetectedTool } from './types.js';

/**
 * Codex CLI: invokes `codex` as a subprocess.
 * Binary detection is delegated to detectCliAgents() in index.ts.
 * System prompt is folded into the prompt (no dedicated system flag).
 */
export function detectCodex(agents: DetectedAgent[] = []): DetectedTool {
  const agent = agents.find((a) => a.id === 'codex');

  if (!agent || !agent.available) {
    return { id: 'codex', name: 'Codex (OpenAI)', detected: false };
  }

  let model = 'o4-mini';
  try {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
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
    note: `CLI: ${agent.executablePath}${agent.version ? ` (v${agent.version})` : ''}`,
    provider: {
      type: 'cli' as const,
      command: 'codex',
      // `exec` is the non-interactive subcommand; prompt is passed as positional arg
      // stdin is inherited (TTY) so user can approve permissions interactively
      args: ['exec', '{{PROMPT}}'],
    },
  };
}
