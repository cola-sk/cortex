import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DetectedAgent } from '@sking7/agent-cli-unified';
import type { DetectedTool } from './types.js';

/**
 * Claude Code CLI: invokes `claude` as a subprocess.
 * Binary detection is delegated to detectCliAgents() in index.ts.
 */
export function detectClaudeCode(agents: DetectedAgent[] = []): DetectedTool {
  const agent = agents.find((a) => a.id === 'claude');

  if (!agent || !agent.available) {
    return { id: 'claude-code', name: 'Claude Code', detected: false };
  }

  let model = 'claude-sonnet-4-5';
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
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
    note: `CLI: ${agent.executablePath}${agent.version ? ` (v${agent.version})` : ''}`,
    provider: {
      type: 'cli' as const,
      command: 'claude',
      args: ['--system-prompt', '{{SYSTEM}}', '-p', '{{PROMPT}}', '--output-format', 'text', '--dangerously-skip-permissions'],
    },
  };
}
