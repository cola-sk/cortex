import { detectClaudeCode } from './claude-code.js';
import { detectCodex } from './codex.js';
import { detectAntigravity } from './antigravity.js';
import { detectHermes } from './hermes.js';
import { detectCopilot } from './copilot.js';
import type { DetectedTool } from './types.js';

export type { DetectedTool } from './types.js';

export function detectAllTools(): DetectedTool[] {
  return [
    detectClaudeCode(),
    detectCodex(),
    detectAntigravity(),
    detectHermes(),
    detectCopilot(),
  ];
}

export function detectTool(id: string): DetectedTool | undefined {
  return detectAllTools().find((t) => t.id === id);
}
