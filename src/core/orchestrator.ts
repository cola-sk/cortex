import { Agent } from './agent.js';
import { PlanSchema, type Plan } from './plan.js';

export const ORCHESTRATOR_SYSTEM = `You are a technical planning expert. Given a goal and a list of available worker agents, you decompose the goal into a structured execution plan.

You must respond with a single valid JSON object (no markdown, no extra text) matching this schema:

{
  "goal": "<original goal>",
  "tasks": [
    {
      "id": "task_1",
      "name": "<short name>",
      "agent": "<single agent key> OR [\"agent_a\", \"agent_b\"] for parallel workers",
      "input": "<detailed instruction for the agent(s)>",
      "dependsOn": []
    }
  ],
  "decisions": [
    {
      "id": "decide_1",
      "name": "<decision point name>",
      "agent": "<decider agent key>",
      "evaluates": ["task_id_1", "task_id_2"],
      "maxRetries": 2
    }
  ]
}

EXECUTION RULES:
- Tasks with no dependency between them are executed IN PARALLEL automatically — design tasks to maximise parallelism
- Use dependsOn[] to express sequential dependencies (task B depends on task A's output)
- "agent" as an array runs MULTIPLE WORKERS simultaneously on the same task — use this when you want diverse or redundant outputs (e.g. ["coder","coder"] for two coders working in parallel)
- decisions[] adds a quality-control checkpoint: after the listed task ids complete, the designated decider agent evaluates outputs and returns { "action": "continue"|"retry", "retryTaskIds": [...], "reason": "..." }
- If a decision returns "retry", the specified tasks are re-queued and re-evaluated (up to maxRetries times)
- Only add a decision point when quality review with potential retry genuinely adds value
- Do NOT create tasks for the orchestrator itself
- Keep task inputs self-contained — include all context the agent needs

COMMON PATTERNS:
- Plan → Execute → Review:
    task_1 (plan, dependsOn:[]), task_2 (execute, dependsOn:[task_1]), task_3 (review, dependsOn:[task_2]), decide_1 evaluates:[task_3] may retry task_2
- Parallel workers then merge:
    task_1a agent:["worker","worker"] runs two workers, task_2 (merge, dependsOn:[task_1a])
- Independent sub-tasks then summarise:
    task_a, task_b (no deps, run in parallel), task_c (summarise, dependsOn:[task_a,task_b])`;

export class Orchestrator {
  private agent: Agent;

  constructor(agent: Agent) {
    this.agent = agent;
  }

  async plan(goal: string, availableAgents: Array<{ id: string; role?: string; description?: string }>): Promise<Plan> {
    const agentList = availableAgents
      .map((a) => {
        const role = a.role ? ` [role: ${a.role}]` : '';
        const desc = a.description ? ` — ${a.description}` : '';
        return `  • ${a.id}${role}${desc}`;
      })
      .join('\n');

    const userMessage =
      `Available worker agents:\n${agentList}\n\n` +
      `Goal: ${goal}\n\n` +
      `Produce the execution plan as JSON.`;

    const response = await this.agent.chat(userMessage, [], { temperature: 0.2 });

    // Strip markdown code fences if present
    const json = response.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error(`Orchestrator returned invalid JSON:\n${response}`);
    }

    const result = PlanSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Orchestrator plan failed validation:\n${issues}\n\nRaw:\n${response}`);
    }

    return result.data;
  }
}

