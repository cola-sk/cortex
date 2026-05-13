import type { Agent } from './agent.js';
import type { Plan, Task, TaskResult, DecisionResult } from './plan.js';

const DECISION_PREFIX = '__decision_';

export class Runner {
  private agents: Map<string, Agent>;

  constructor(agents: Map<string, Agent>) {
    this.agents = agents;
  }

  /**
   * Execute a plan with:
   *  - True parallel execution for tasks that have no dependency between them
   *  - Multi-worker parallel execution when task.agent is an array
   *  - Decision point evaluation with retry loops
   */
  async run(plan: Plan): Promise<Map<string, TaskResult>> {
    const results = new Map<string, TaskResult>();
    const retryCount = new Map<string, number>();

    const decisionCount = plan.decisions?.length ?? 0;
    console.log(`\n▶ Running plan: "${plan.goal}"`);
    console.log(`  Tasks: ${plan.tasks.length}  Decision points: ${decisionCount}\n`);

    // Mutable pool of tasks still waiting to run
    const pending = new Map<string, Task>(plan.tasks.map((t) => [t.id, t]));
    const completed = new Set<string>();

    // Safety ceiling to prevent infinite retry loops
    const MAX_ITERATIONS = (plan.tasks.length + decisionCount + 1) * 10;
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
        console.error('⚠ No tasks ready to execute — possible unresolvable dependency.');
        break;
      }

      // Remove ready tasks from pending before async work (avoid duplicate execution)
      for (const t of ready) pending.delete(t.id);

      const agentNames = ready.map((t) =>
        Array.isArray(t.agent) ? `[${t.agent.join('+')}]` : t.agent,
      );
      console.log(`⚡ Parallel batch (${ready.length}): ${ready.map((t, i) => `${t.id}→${agentNames[i]}`).join('  ')}`);

      // ---- Execute the ready batch in parallel ----
      await Promise.all(
        ready.map(async (task) => {
          const context = this.buildContext(task.dependsOn, results);
          const fullInput = context ? `${context}\n\n---\n\n${task.input}` : task.input;

          const agentKeys = Array.isArray(task.agent) ? task.agent : [task.agent];

          // Run all assigned agents in parallel (multi-worker)
          const workerResults = await Promise.all(
            agentKeys.map(async (key, idx) => {
              const agent = this.agents.get(key);
              if (!agent) {
                return { output: '', error: `Unknown agent "${key}"` };
              }
              const label = agentKeys.length > 1 ? `${task.id}[worker${idx + 1}]` : task.id;
              console.log(`  ⚙ [${label}] ${task.name} → ${key}`);
              try {
                const output = await agent.chat(fullInput);
                console.log(`  ✓ [${label}] ${output.length} chars`);
                return { output };
              } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                console.error(`  ✗ [${label}] ${error}`);
                return { output: '', error };
              }
            }),
          );

          const outputs = workerResults.map((r) => r.output).filter(Boolean);
          const errors = workerResults.map((r) => r.error).filter(Boolean);
          const combinedOutput = agentKeys.length > 1
            ? outputs.map((o, i) => `[Worker ${i + 1} — ${agentKeys[i]}]\n${o}`).join('\n\n')
            : outputs[0] ?? '';

          results.set(task.id, {
            taskId: task.id,
            outputs,
            output: combinedOutput,
            ...(errors.length ? { error: errors.join('; ') } : {}),
          });
          completed.add(task.id);
        }),
      );

      console.log('');

      // ---- Evaluate decision points whose tasks just completed ----
      for (const dp of plan.decisions ?? []) {
        const dpKey = `${DECISION_PREFIX}${dp.id}`;

        // Skip if already resolved
        if (results.has(dpKey)) continue;

        // Skip if not all evaluated tasks are done
        if (!dp.evaluates.every((id) => completed.has(id))) continue;

        const deciderAgent = this.agents.get(dp.agent);
        if (!deciderAgent) {
          console.warn(`  ⚠ Decider agent "${dp.agent}" not found — skipping decision "${dp.id}"`);
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

        console.log(`🔍 Decision point "${dp.id}" — evaluating: ${dp.evaluates.join(', ')}`);

        let decision: DecisionResult = { action: 'continue', reason: 'default' };
        try {
          const raw = await deciderAgent.chat(deciderPrompt, [], { temperature: 0.1 });
          const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
          decision = JSON.parse(cleaned) as DecisionResult;
        } catch (e) {
          console.warn(`  ⚠ Decision parse failed (${(e as Error).message}) — defaulting to continue`);
        }

        console.log(`  → ${decision.action.toUpperCase()}: ${decision.reason}`);

        if (decision.action === 'retry' && decision.retryTaskIds?.length) {
          // Check if we've exceeded max retries for any of these tasks
          const overLimit = decision.retryTaskIds.filter(
            (id) => (retryCount.get(id) ?? 0) >= dp.maxRetries,
          );

          if (overLimit.length > 0) {
            console.log(`  ⚠ Max retries (${dp.maxRetries}) reached for [${overLimit.join(', ')}] — forcing continue\n`);
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
            console.log(`  ↺ Re-queuing [${decision.retryTaskIds.join(', ')}] — attempt ${attempts}/${dp.maxRetries}\n`);
            // Don't set dpKey — let it be re-evaluated after retry
          }
        } else {
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

