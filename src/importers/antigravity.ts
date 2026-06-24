import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DetectedAgent } from '@sking7/agent-cli-unified';
import type { DetectedTool } from './types.js';

/**
 * Antigravity CLI: invokes `agy` or `antigravity` as a subprocess.
 * Binary detection is delegated to detectCliAgents() in index.ts, which
 * checks all known binaries ['agy', 'antigravity'] in PATH.
 */
export function detectAntigravity(agents: DetectedAgent[] = []): DetectedTool {
  const agent = agents.find((a) => a.id === 'antigravity');

  if (!agent || !agent.available) {
    return { id: 'antigravity', name: 'Antigravity CLI', detected: false };
  }

  // Read model from Antigravity settings if available
  const settingsPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
  const legacySettingsPath = path.join(os.homedir(), '.gemini', 'settings.json');
  let model = 'gemini-2.5-pro';
  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { model?: string };
      model = settings.model ?? model;
    } else if (fs.existsSync(legacySettingsPath)) {
      const settings = JSON.parse(fs.readFileSync(legacySettingsPath, 'utf-8')) as { model?: { name?: string } | string };
      if (settings.model) {
        model = typeof settings.model === 'string' ? settings.model : (settings.model.name ?? model);
      }
    }
  } catch { /* ignore */ }

  return {
    id: 'antigravity',
    name: agent.label,         // 'Antigravity CLI' from AGENT_DEFINITIONS
    detected: true,
    model,
    note: `CLI: ${agent.executablePath}${agent.version ? ` (v${agent.version})` : ''}`,
    provider: {
      type: 'cli' as const,
      command: 'antigravity',  // normalizeAgent('antigravity') resolves in agent-cli-unified
      args: [],
    },
  };
}
