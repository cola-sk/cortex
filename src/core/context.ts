import type { Agent } from './agent.js';
import type { TaskRound } from './plan.js';
import type { Message } from '../providers/base.js';

const ROUND_COMPRESS_THRESHOLD = 3;

/**
 * Build multi-turn message history from previous rounds.
 * Used for API providers (Claude/OpenAI) that support conversation history.
 */
export function buildMessageHistory(rounds: TaskRound[]): Message[] {
  const history: Message[] = [];
  for (const round of rounds) {
    history.push({ role: 'user', content: round.input });
    history.push({ role: 'assistant', content: round.output });
    if (round.review) {
      history.push({
        role: 'user',
        content: `Feedback:\n${round.review.comment}\n\nPlease revise based on the above feedback.`,
      });
    }
  }
  return history;
}

/**
 * Build revision context as a single text block.
 * Used for CLI providers that don't support conversation history.
 */
export function buildRevisionContext(rounds: TaskRound[]): string {
  if (rounds.length === 0) return '';
  return rounds
    .map(
      (r, i) =>
        `=== Round ${i + 1} ===\nYour output:\n${r.output}\n\n` +
        `Human feedback:\n${r.review?.comment ?? 'Approved'}`,
    )
    .join('\n\n');
}

/**
 * Compress earlier rounds when the history grows too long.
 * Keeps the most recent 2 rounds in full and summarizes earlier ones via LLM.
 */
export async function compressRounds(
  rounds: TaskRound[],
  agent: Agent,
): Promise<{ history: Message[]; contextText: string }> {
  if (rounds.length <= ROUND_COMPRESS_THRESHOLD) {
    return {
      history: buildMessageHistory(rounds),
      contextText: buildRevisionContext(rounds),
    };
  }

  const early = rounds.slice(0, -2);
  const recent = rounds.slice(-2);

  const earlyText = early
    .map(
      (r, i) =>
        `[Round ${i + 1}]\nOutput: ${r.output}\nFeedback: ${r.review?.comment ?? 'N/A'}`,
    )
    .join('\n\n');

  let summary: string;
  try {
    summary = await agent.chat(
      `Summarize the key decisions, changes, and unresolved issues from these review rounds. Be concise (under 300 words):\n\n${earlyText}`,
      [],
      { temperature: 0 },
    );
  } catch {
    // Fallback: truncate each early round to first 200 chars
    summary = early
      .map((r, i) => `Round ${i + 1}: ${r.output.slice(0, 200)}... | Feedback: ${r.review?.comment ?? 'N/A'}`)
      .join('\n');
  }

  // Build compressed message history
  const history: Message[] = [
    { role: 'user', content: `[Summary of Rounds 1-${early.length}]\n${summary}` },
    { role: 'assistant', content: 'Understood. I have the context from earlier rounds.' },
    ...buildMessageHistory(recent),
  ];

  // Build compressed context text
  const recentText = recent
    .map((r, i) => {
      const idx = rounds.length - 2 + i + 1;
      return (
        `=== Round ${idx} ===\nYour output:\n${r.output}\n\n` +
        `Human feedback:\n${r.review?.comment ?? 'Approved'}`
      );
    })
    .join('\n\n');

  const contextText = `[Summary of Rounds 1-${early.length}]\n${summary}\n\n${recentText}`;

  return { history, contextText };
}
