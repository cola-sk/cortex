import type { Agent } from './agent.js';
import type { Plan, TaskResult } from './plan.js';

export class Runner {
  private agents: Map<string, Agent>;

  constructor(agents: Map<string, Agent>) {
    this.agents = agents;
  }

  /**
   * Execute a plan sequentially, respecting dependsOn ordering.
   * Returns all task results keyed by task id.
   */
  async run(plan: Plan): Promise<Map<string, TaskResult>> {
    const results = new Map<string, TaskResult>();

    console.log(`\n▶ Running plan: "${plan.goal}"`);
    console.log(`  ${plan.tasks.length} task(s) to execute\n`);

    // Topological sort respecting dependsOn
    const sorted = this.topologicalSort(plan);

    for (const task of sorted) {
      const agent = this.agents.get(task.agent);
      if (!agent) {
        throw new Error(
          `Task "${task.id}" references unknown agent "${task.agent}". ` +
            `Available: ${[...this.agents.keys()].join(', ')}`
        );
      }

      // Inject outputs from dependencies into the task input
      const context = this.buildContext(task.dependsOn, results);
      const fullInput = context ? `${context}\n\n---\n\n${task.input}` : task.input;

      console.log(`⚙ [${task.id}] ${task.name} → agent: ${task.agent}`);

      try {
        const output = await agent.chat(fullInput);
        results.set(task.id, { taskId: task.id, output });
        console.log(`✓ [${task.id}] done (${output.length} chars)\n`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`✗ [${task.id}] failed: ${error}\n`);
        results.set(task.id, { taskId: task.id, output: '', error });
        // Continue with remaining tasks rather than aborting the whole run
      }
    }

    return results;
  }

  private buildContext(dependsOn: string[], results: Map<string, TaskResult>): string {
    if (dependsOn.length === 0) return '';
    const parts = dependsOn
      .map((id) => {
        const r = results.get(id);
        return r ? `[Output of ${id}]\n${r.output}` : '';
      })
      .filter(Boolean);
    return parts.join('\n\n');
  }

  private topologicalSort(plan: Plan) {
    const ordered = [...plan.tasks];
    // Stable insertion-sort based on dependsOn — good enough for MVP
    const idIndex = new Map(ordered.map((t, i) => [t.id, i]));
    ordered.sort((a, b) => {
      if (b.dependsOn.includes(a.id)) return -1;
      if (a.dependsOn.includes(b.id)) return 1;
      return (idIndex.get(a.id) ?? 0) - (idIndex.get(b.id) ?? 0);
    });
    return ordered;
  }
}
