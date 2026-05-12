#!/usr/bin/env node
import path from 'path';
import { loadConfig } from './config/loader.js';
import { Agent } from './core/agent.js';
import { Orchestrator, ORCHESTRATOR_SYSTEM } from './core/orchestrator.js';
import { Runner } from './core/runner.js';
import type { AgentConfig } from './config/schema.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: cortex <config.yaml> "<goal>" [orchestrator-agent-key]');
    process.exit(1);
  }

  const [configPath, goal, orchestratorKey = 'orchestrator'] = args;

  // Load config
  const config = loadConfig(path.resolve(configPath));

  // Instantiate all agents
  const agentMap = new Map<string, Agent>();
  for (const [id, agentConfig] of Object.entries(config.agents)) {
    agentMap.set(id, new Agent(id, agentConfig));
  }

  // Resolve orchestrator agent (may be defined in yaml, or use default system prompt)
  let orchestratorAgent: Agent;
  if (agentMap.has(orchestratorKey)) {
    orchestratorAgent = agentMap.get(orchestratorKey)!;
  } else {
    // Fallback: auto-create orchestrator using the same provider as the first defined agent
    const firstEntry = Object.entries(config.agents)[0];
    if (!firstEntry) {
      throw new Error('No agents defined in config');
    }
    const fallbackConfig: AgentConfig = {
      system: ORCHESTRATOR_SYSTEM,
      provider: firstEntry[1].provider,
    };
    orchestratorAgent = new Agent(orchestratorKey, fallbackConfig);
    console.log(`ℹ No "${orchestratorKey}" agent found, using "${firstEntry[0]}"'s provider for orchestration.\n`);
  }

  // Worker agents = everything except the orchestrator key
  const workerKeys = [...agentMap.keys()].filter((k) => k !== orchestratorKey);

  if (workerKeys.length === 0) {
    throw new Error('No worker agents found. Add at least one agent besides the orchestrator in agents.yaml.');
  }

  console.log(`Cortex starting…`);
  console.log(`  Orchestrator : ${orchestratorKey}`);
  console.log(`  Workers      : ${workerKeys.join(', ')}`);
  console.log(`  Goal         : ${goal}\n`);

  // Plan
  const orchestrator = new Orchestrator(orchestratorAgent);
  const plan = await orchestrator.plan(goal, workerKeys);

  console.log('📋 Plan generated:');
  for (const task of plan.tasks) {
    const deps = task.dependsOn.length ? ` (after: ${task.dependsOn.join(', ')})` : '';
    console.log(`  ${task.id}: [${task.agent}] ${task.name}${deps}`);
  }
  console.log('');

  // Execute
  const runner = new Runner(agentMap);
  const results = await runner.run(plan);

  // Summary
  console.log('\n═══════════════════════════════════════════');
  console.log('RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════\n');

  for (const [id, result] of results) {
    if (result.error) {
      console.log(`✗ ${id}: ERROR — ${result.error}`);
    } else {
      console.log(`✓ ${id}:\n${result.output}\n`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
