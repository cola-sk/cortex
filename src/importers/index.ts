import { detectCliAgents } from '@sking7/agent-cli-unified';
import type { DetectedAgent } from '@sking7/agent-cli-unified';
import { detectClaudeCode } from './claude-code.js';
import { detectCodex } from './codex.js';
import { detectAntigravity } from './antigravity.js';
import { detectHermes } from './hermes.js';
import { detectCopilot } from './copilot.js';
import type { DetectedTool } from './types.js';

export type { DetectedTool } from './types.js';

/** Run binary detection once and share across all importers to avoid redundant subprocess calls. */
function getDetectedAgents(): DetectedAgent[] {
  try {
    return detectCliAgents();
  } catch {
    return [];
  }
}

export function detectAllTools(): DetectedTool[] {
  const agents = getDetectedAgents();
  return [
    detectClaudeCode(agents),
    detectCodex(agents),
    detectAntigravity(agents),
    detectHermes(),
    detectCopilot(agents),
  ];
}

export function detectTool(id: string): DetectedTool | undefined {
  return detectAllTools().find((t) => t.id === id);
}
