import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DetectedAgent } from '@sking7/agent-cli-unified';
import type { DetectedTool } from './types.js';

/**
 * GitHub Copilot CLI: invokes the `copilot` CLI binary as a subprocess.
 * Binary detection is delegated to detectCliAgents() in index.ts.
 */
export function detectCopilot(agents: DetectedAgent[] = []): DetectedTool {
  const agent = agents.find((a) => a.id === 'copilot');

  if (!agent || !agent.available) {
    return { id: 'copilot', name: 'GitHub Copilot CLI', detected: false };
  }

  let model = 'copilot-default';
  try {
    const settingsPath = path.join(os.homedir(), '.copilot', 'settings.json');
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
    note: `CLI: ${agent.executablePath}${agent.version ? ` (v${agent.version})` : ''}`,
    provider: {
      type: 'cli' as const,
      command: 'copilot',
      args: ['--output-format', 'json', '--stream', 'on', '-p', '{{PROMPT}}', '--yolo'],
    },
  };
}
