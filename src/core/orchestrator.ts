import { Agent } from './agent.js';
import { PlanSchema, type Plan } from './plan.js';

const ORCHESTRATOR_SYSTEM = `You are a technical planning expert. Given a goal, you break it down into a list of tasks and assign each task to the most appropriate worker agent.

You must respond with a single valid JSON object (no markdown, no extra text) matching this schema:
{
  "goal": "<original goal>",
  "tasks": [
    {
      "id": "task_1",
      "name": "<short name>",
      "agent": "<agent key from available agents>",
      "input": "<detailed instruction for the worker>",
      "dependsOn": []
    }
  ]
}

Rules:
- Tasks run sequentially in the order listed. Use dependsOn to express explicit dependencies.
- The "agent" field must be one of the available agent keys provided in the user message.
- Each task should have a clear, self-contained instruction.
- Do NOT include tasks for yourself (the orchestrator).`;

export class Orchestrator {
  private agent: Agent;

  constructor(agent: Agent) {
    this.agent = agent;
  }

  async plan(goal: string, availableAgents: string[]): Promise<Plan> {
    const userMessage = `Available worker agents: ${availableAgents.join(', ')}

Goal: ${goal}

Produce the execution plan as JSON.`;

    const response = await this.agent.chat(userMessage, [], {
      temperature: 0.2,
    });

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
      throw new Error(`Orchestrator plan failed validation:\n${issues}\n\nRaw response:\n${response}`);
    }

    return result.data;
  }
}

export { ORCHESTRATOR_SYSTEM };
