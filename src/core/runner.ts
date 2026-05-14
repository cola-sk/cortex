import { execSync } from 'child_process';
import type { Agent } from './agent.js';
import type { Plan, Task, TaskResult, DecisionResult, ReviewAction, TaskRound } from './plan.js';
import { buildMessageHistory, buildRevisionContext, compressRounds } from './context.js';

const DECISION_PREFIX = '__decision_';

/**
 * Get the current git diff (staged + unstaged) for injection into the prompt.
 * Returns empty string if not in a git repo or no changes.
 */
function getGitDiff(cwd?: string): string {
  try {
    // Combined diff: staged + unstaged working tree changes
    const diff = execSync('git diff HEAD', { encoding: 'utf-8', maxBuffer: 1024 * 1024, cwd: cwd || undefined }).trim();
    if (!diff) return '';
    return `\`\`\`diff\n${diff}\n\`\`\``;
  } catch {
    return '';
  }
}

export interface RunnerCallbacks {
  onTaskStart?: (taskId: string, taskName: string, agents: string[]) => void;
  onTaskProgress?: (taskId: string, workerIndex: number, event: import('./events.js').ToolEvent) => void;
  onWorkerComplete?: (taskId: string, workerIndex: number, output: string, error?: string) => void;
  onTaskComplete?: (taskId: string, taskName: string, result: TaskResult) => void;
  onDecisionStart?: (decisionId: string, evaluates: string[]) => void;
  onDecisionComplete?: (decisionId: string, decision: DecisionResult, retrying?: string[]) => void;
  /** Called when a task with requiresReview completes. Runner pauses until the returned Promise resolves. */
  onReviewRequired?: (taskId: string, taskName: string, output: string, round: number) => Promise<ReviewAction>;
  onReviewSubmitted?: (taskId: string, action: ReviewAction, round: number) => void;
  onTaskRevision?: (taskId: string, round: number) => void;
  onTaskRollback?: (fromTaskId: string, toTaskId: string, reason: string) => void;
}

export class Runner {
  private agents: Map<string, Agent>;
  private callbacks: RunnerCallbacks;
  private silent: boolean;
  private workspace?: string;

  constructor(agents: Map<string, Agent>, callbacks: RunnerCallbacks = {}, silent = false, workspace?: string) {
    this.agents = agents;
    this.callbacks = callbacks;
    // Silent mode: suppress internal progress logs (used when caller provides callbacks)
    this.silent = silent || Object.keys(callbacks).length > 0;
    this.workspace = workspace;
  }

  /**
   * Execute a plan with:
   *  - True parallel execution for tasks that have no dependency between them
   *  - Multi-worker parallel execution when task.agent is an array
   *  - Decision point evaluation with retry loops
   *  - Human-in-the-loop review with pause/resume
   */
  async run(plan: Plan, signal?: AbortSignal): Promise<Map<string, TaskResult>> {
    const results = new Map<string, TaskResult>();
    const retryCount = new Map<string, number>();
    // Track revision rounds per task
    const taskRounds = new Map<string, TaskRound[]>();

    const decisionCount = plan.decisions?.length ?? 0;
    if (!this.silent) {
      console.log(`\n▶ Running plan: "${plan.goal}"`);
      console.log(`  Tasks: ${plan.tasks.length}  Decision points: ${decisionCount}\n`);
    }

    // Mutable pool of tasks still waiting to run
    const pending = new Map<string, Task>(plan.tasks.map((t) => [t.id, t]));
    const completed = new Set<string>();

    // Safety ceiling to prevent infinite retry loops
    const MAX_ITERATIONS = (plan.tasks.length + decisionCount + 1) * 20;
    let iterations = 0;

    while (pending.size > 0) {
      if (++iterations > MAX_ITERATIONS) {
        console.error('⚠ Max iterations reached — possible circular dependency or infinite retry loop.');
        break;
      }

      // ---- Find all tasks whose deps are satisfied ----
      const ready: Task[] = [];
      for (const [, task] of pending) {
        if (task.dependsOn.every((dep) => completed.has(dep))) {
          ready.push(task);
        }
      }

      if (ready.length === 0) {
        if (!this.silent) console.error('⚠ No tasks ready to execute — possible unresolvable dependency.');
        break;
      }

      // Remove ready tasks from pending before async work (avoid duplicate execution)
      for (const t of ready) pending.delete(t.id);

      if (!this.silent) {
        const agentNames = ready.map((t) =>
          Array.isArray(t.agent) ? `[${t.agent.join('+')}]` : t.agent,
        );
        console.log(`⚡ Parallel batch (${ready.length}): ${ready.map((t, i) => `${t.id}→${agentNames[i]}`).join('  ')}`);
      }

      // ---- Execute the ready batch in parallel ----
      await Promise.all(
        ready.map(async (task) => {
          await this.executeTaskWithReview(task, plan, results, taskRounds, pending, completed, signal);
        }),
      );

      if (!this.silent) console.log('');

      // ---- Evaluate decision points whose tasks just completed ----
      for (const dp of plan.decisions ?? []) {
        const dpKey = `${DECISION_PREFIX}${dp.id}`;

        // Skip if already resolved
        if (results.has(dpKey)) continue;

        // Skip if not all evaluated tasks are done
        if (!dp.evaluates.every((id) => completed.has(id))) continue;

        const deciderAgent = this.agents.get(dp.agent);
        if (!deciderAgent) {
          if (!this.silent) console.warn(`  ⚠ Decider agent "${dp.agent}" not found — skipping decision "${dp.id}"`);
          results.set(dpKey, { taskId: dpKey, outputs: ['{}'], output: '{}' });
          continue;
        }

        // Build evaluation prompt
        const evalSections = dp.evaluates
          .map((id) => {
            const r = results.get(id);
            return r ? `[Task "${id}"]\n${r.output}` : `[Task "${id}": no output]`;
          })
          .join('\n\n');

        const deciderPrompt =
          `Goal: ${plan.goal}\n\n` +
          `Evaluate the following task results and decide whether to continue or request a retry.\n\n` +
          `${evalSections}\n\n` +
          `Respond with ONLY valid JSON (no markdown fences):\n` +
          `{ "action": "continue" | "retry", "retryTaskIds": ["<task_id>", ...], "reason": "<brief explanation>" }`;

        if (!this.silent) console.log(`🔍 Decision point "${dp.id}" — evaluating: ${dp.evaluates.join(', ')}`);
        this.callbacks.onDecisionStart?.(dp.id, dp.evaluates);

        let decision: DecisionResult = { action: 'continue', reason: 'default' };
        try {
          const raw = await deciderAgent.chat(deciderPrompt, [], { temperature: 0.1 });
          const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
          decision = JSON.parse(cleaned) as DecisionResult;
        } catch (e) {
          if (!this.silent) console.warn(`  ⚠ Decision parse failed (${(e as Error).message}) — defaulting to continue`);
        }

        if (!this.silent) console.log(`  → ${decision.action.toUpperCase()}: ${decision.reason}`);

        if (decision.action === 'retry' && decision.retryTaskIds?.length) {
          // Check if we've exceeded max retries for any of these tasks
          const overLimit = decision.retryTaskIds.filter(
            (id) => (retryCount.get(id) ?? 0) >= dp.maxRetries,
          );

          if (overLimit.length > 0) {
            if (!this.silent) console.log(`  ⚠ Max retries (${dp.maxRetries}) reached for [${overLimit.join(', ')}] — forcing continue\n`);
            this.callbacks.onDecisionComplete?.(dp.id, { ...decision, action: 'continue', reason: 'max retries reached' });
            results.set(dpKey, {
              taskId: dpKey,
              outputs: [JSON.stringify(decision)],
              output: JSON.stringify({ ...decision, action: 'continue', reason: 'max retries reached' }),
            });
          } else {
            // Increment retry counter and re-queue
            for (const id of decision.retryTaskIds) {
              retryCount.set(id, (retryCount.get(id) ?? 0) + 1);
              const orig = plan.tasks.find((t) => t.id === id);
              if (orig) {
                completed.delete(id);
                results.delete(id);
                pending.set(id, orig);
              }
            }
            const attempts = retryCount.get(decision.retryTaskIds[0]) ?? 1;
            if (!this.silent) console.log(`  ↺ Re-queuing [${decision.retryTaskIds.join(', ')}] — attempt ${attempts}/${dp.maxRetries}\n`);
            this.callbacks.onDecisionComplete?.(dp.id, decision, decision.retryTaskIds);
            // Don't set dpKey — let it be re-evaluated after retry
          }
        } else {
          this.callbacks.onDecisionComplete?.(dp.id, decision);
          results.set(dpKey, {
            taskId: dpKey,
            outputs: [JSON.stringify(decision)],
            output: JSON.stringify(decision),
          });
        }
      }
    }

    return results;
  }

  /**
   * Execute a single task, handling review loops if requiresReview is set.
   */
  private async executeTaskWithReview(
    task: Task,
    plan: Plan,
    results: Map<string, TaskResult>,
    taskRounds: Map<string, TaskRound[]>,
    pending: Map<string, Task>,
    completed: Set<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    const MAX_REVIEW_ROUNDS = 10;

    for (let attempt = 0; attempt < MAX_REVIEW_ROUNDS; attempt++) {
      const rounds = taskRounds.get(task.id) ?? [];
      const currentRound = rounds.length + 1;

      if (currentRound > 1) {
        this.callbacks.onTaskRevision?.(task.id, currentRound);
        if (!this.silent) console.log(`  ↻ [${task.id}] Revision round ${currentRound}`);
      }

      // Build context from upstream dependencies
      const upstreamContext = this.buildContext(task.dependsOn, results);
      const goalPrefix = `Goal: ${plan.goal}`;
      // Read git diff if task.gitDiff is enabled (use workspace as cwd)
      const gitDiffSection = task.gitDiff ? getGitDiff(this.workspace) : '';

      // Build the input with revision context if applicable
      let fullInput: string;
      const agentKeys = Array.isArray(task.agent) ? task.agent : [task.agent];
      const primaryAgent = this.agents.get(agentKeys[0]);
      const useHistory = primaryAgent?.supportsHistory() ?? false;
      let history: import('../providers/base.js').Message[] = [];

      // Helper: assemble parts into final prompt, appending git diff and workspace hint when present
      const workspaceHint = this.workspace && primaryAgent?.isCli()
        ? `## Workspace\n\nYou MUST work in the following directory: ${this.workspace}`
        : '';
      const assemblePrompt = (...parts: string[]) => {
        const sections = [...parts.filter(Boolean)];
        if (workspaceHint) sections.push(workspaceHint);
        const body = sections.join('\n\n---\n\n');
        return gitDiffSection
          ? `${body}\n\n---\n\n## Git Diff\n\n${gitDiffSection}`
          : body;
      };

      if (rounds.length > 0) {
        if (useHistory) {
          // API provider: use real message history
          const compressed = await compressRounds(rounds, primaryAgent!);
          history = compressed.history;
          // Current input is the revision instruction
          fullInput = assemblePrompt(
            goalPrefix,
            upstreamContext,
            task.input,
          );
        } else {
          // CLI provider: embed revision context in the prompt
          const compressed = await compressRounds(rounds, primaryAgent!);
          const revisionContext = compressed.contextText;
          fullInput = assemblePrompt(
            goalPrefix,
            upstreamContext,
            `Previous revision history:\n${revisionContext}`,
            `Based on the above feedback, please revise:\n${task.input}`,
          );
        }
      } else {
        fullInput = assemblePrompt(goalPrefix, upstreamContext, task.input);
      }

      this.callbacks.onTaskStart?.(task.id, task.name, agentKeys);

      // Run all assigned agents in parallel (multi-worker)
      const workerResults = await Promise.all(
        agentKeys.map(async (key, idx) => {
          const agent = this.agents.get(key);
          if (!agent) {
            return { output: '', error: `Unknown agent "${key}"` };
          }
          const label = agentKeys.length > 1 ? `${task.id}[worker${idx + 1}]` : task.id;
          if (!this.silent) console.log(`  ⚙ [${label}] ${task.name} → ${key}`);
          try {
            const output = await agent.chat(fullInput, history, {
              onStreamEvent: (event) => {
                this.callbacks.onTaskProgress?.(task.id, idx, event);
              },
              signal,
            });
            const toolEvents = agent.getLastToolEvents();
            if (!this.silent) console.log(`  ✓ [${label}] ${output.length} chars${toolEvents.length ? ` | ${toolEvents.filter(e => e.type === 'tool_use').length} tool calls` : ''}`);
            this.callbacks.onWorkerComplete?.(task.id, idx, output);
            return { output, toolEvents };
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            if (!this.silent) console.error(`  ✗ [${label}] ${error}`);
            this.callbacks.onWorkerComplete?.(task.id, idx, '', error);
            return { output: '', error, toolEvents: [] };
          }
        }),
      );

      const outputs = workerResults.map((r) => r.output);
      const errors = workerResults.map((r) => r.error).filter(Boolean);
      const combinedOutput = agentKeys.length > 1
        ? outputs.map((o, i) => `[Worker ${i + 1} — ${agentKeys[i]}]\n${o || '(no output)'}`).join('\n\n')
        : outputs[0] ?? '';

      const allToolEvents = workerResults.map((r) => r.toolEvents ?? []);
      const hasToolEvents = allToolEvents.some((te) => te.length > 0);

      const taskResult: TaskResult = {
        taskId: task.id,
        outputs,
        output: combinedOutput,
        ...(errors.length ? { error: errors.join('; ') } : {}),
        ...(hasToolEvents ? { toolEvents: allToolEvents } : {}),
      };
      results.set(task.id, taskResult);
      this.callbacks.onTaskComplete?.(task.id, task.name, taskResult);

      // Check if this task requires human review
      if (task.requiresReview && this.callbacks.onReviewRequired && !taskResult.error) {
        if (!this.silent) console.log(`  ⏸ [${task.id}] Awaiting human review (round ${currentRound})...`);

        const review = await this.callbacks.onReviewRequired(task.id, task.name, combinedOutput, currentRound);
        this.callbacks.onReviewSubmitted?.(task.id, review, currentRound);

        // Record this round
        const round: TaskRound = {
          round: currentRound,
          input: fullInput,
          output: combinedOutput,
          ...(hasToolEvents ? { toolEvents: allToolEvents } : {}),
          finishedAt: new Date().toISOString(),
          review: {
            action: review.action,
            comment: review.comment,
            targetTaskId: review.targetTaskId,
            reviewedAt: new Date().toISOString(),
          },
        };
        const updatedRounds = [...rounds, round];
        taskRounds.set(task.id, updatedRounds);

        if (review.action === 'approve') {
          if (!this.silent) console.log(`  ✓ [${task.id}] Approved — continuing`);
          completed.add(task.id);
          return;
        }

        // Revise — determine target
        const targetId = review.targetTaskId ?? task.id;

        if (targetId !== task.id) {
          // Rollback to upstream task
          if (!this.silent) console.log(`  ↩ [${task.id}] Rolling back to ${targetId}`);
          this.callbacks.onTaskRollback?.(task.id, targetId, review.comment);

          // Clear current task and all downstream
          const downstream = this.findAllDownstream(targetId, plan.tasks);
          for (const id of [targetId, ...downstream]) {
            completed.delete(id);
            results.delete(id);
            const orig = plan.tasks.find((t) => t.id === id);
            if (orig) pending.set(id, orig);
          }

          // Add the review feedback to the target task's rounds
          const targetRounds = taskRounds.get(targetId) ?? [];
          if (targetRounds.length > 0) {
            const lastRound = targetRounds[targetRounds.length - 1];
            if (!lastRound.review) {
              lastRound.review = {
                action: 'revise',
                comment: review.comment,
                targetTaskId: targetId,
                reviewedAt: new Date().toISOString(),
              };
            }
          } else {
            // Target hasn't been tracked yet — create a synthetic round
            const targetResult = results.get(targetId);
            taskRounds.set(targetId, [{
              round: 1,
              input: '',
              output: targetResult?.output ?? '',
              finishedAt: new Date().toISOString(),
              review: {
                action: 'revise',
                comment: review.comment,
                targetTaskId: targetId,
                reviewedAt: new Date().toISOString(),
              },
            }]);
          }
          return; // Exit — the main loop will re-execute the target task
        }

        // Revise current task — loop continues
        if (!this.silent) console.log(`  ↻ [${task.id}] Revising based on feedback`);
        continue;
      }

      // No review required or had an error — mark complete and return
      completed.add(task.id);
      return;
    }

    // Exceeded max review rounds
    if (!this.silent) console.warn(`  ⚠ [${task.id}] Max review rounds (${MAX_REVIEW_ROUNDS}) reached — forcing continue`);
    completed.add(task.id);
  }

  /**
   * Find all task IDs that directly or indirectly depend on the given task ID.
   */
  private findAllDownstream(taskId: string, tasks: Task[]): string[] {
    const downstream = new Set<string>();
    const queue = [taskId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const t of tasks) {
        if (t.dependsOn.includes(current) && !downstream.has(t.id)) {
          downstream.add(t.id);
          queue.push(t.id);
        }
      }
    }
    return [...downstream];
  }

  private buildContext(dependsOn: string[], results: Map<string, TaskResult>): string {
    if (dependsOn.length === 0) return '';
    return dependsOn
      .map((id) => {
        const r = results.get(id);
        return r ? `[Output of ${id}]\n${r.output}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
}

