import { detectClaudeCode } from './claude-code.js';
import { detectCodex } from './codex.js';
import { detectGemini } from './gemini.js';
import { detectHermes } from './hermes.js';
import type { DetectedTool } from './types.js';

export type { DetectedTool } from './types.js';

export function detectAllTools(): DetectedTool[] {
  return [
    detectClaudeCode(),
    detectCodex(),
    detectGemini(),
    detectHermes(),
  ];
}

export function detectTool(id: string): DetectedTool | undefined {
  return detectAllTools().find((t) => t.id === id);
}
