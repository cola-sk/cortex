#!/usr/bin/env node
import path from 'path';
import { loadConfig } from './config/loader.js';
import { Agent } from './core/agent.js';
import { Orchestrator, ORCHESTRATOR_SYSTEM } from './core/orchestrator.js';
import { Runner } from './core/runner.js';
import type { AgentConfig } from './config/schema.js';
import { readAppConfig, writeAppConfig, VALID_KEYS, DEFAULT_CONFIG } from './config/appConfig.js';
import { runInteractive, runDirect, listPipelines } from './cli/interactive.js';

// ---- config subcommand ----

function handleConfigCommand(args: string[]): void {
  const cfg = readAppConfig();
  const sub = args[0];

  if (sub === 'set') {
    const [, key, value] = args;
    if (!key || !value) {
      console.error('Usage: cortex config set <key> <value>');
      console.error(`  Keys: ${VALID_KEYS.join(', ')}`);
      process.exit(1);
    }
    if (!(VALID_KEYS as string[]).includes(key)) {
      console.error(`Unknown config key: "${key}". Valid keys: ${VALID_KEYS.join(', ')}`);
      process.exit(1);
    }
    (cfg as unknown as Record<string, string>)[key] = value;
    writeAppConfig(cfg);
    console.log(`✓ ${key} = ${value}`);
    return;
  }

  if (sub === 'get') {
    const key = args[1];
    if (key) {
      if (!(VALID_KEYS as string[]).includes(key)) {
        console.error(`Unknown config key: "${key}". Valid keys: ${VALID_KEYS.join(', ')}`);
        process.exit(1);
      }
      console.log(`${key} = ${(cfg as unknown as Record<string, string>)[key]}`);
    } else {
      for (const k of VALID_KEYS) {
        console.log(`${k} = ${cfg[k]}`);
      }
    }
    return;
  }

  if (sub === 'reset') {
    writeAppConfig({ ...DEFAULT_CONFIG });
    console.log('✓ Config reset to defaults');
    return;
  }

  console.error('Usage:');
  console.error('  cortex config set <key> <value>   Set a config value');
  console.error('  cortex config get [key]            Show config value(s)');
  console.error('  cortex config reset                Reset to defaults');
  console.error(`\nKeys: ${VALID_KEYS.join(', ')}`);
  process.exit(1);
}

// ---- main ----

async function main() {
  const args = process.argv.slice(2);

  const agentsPath  = path.resolve(process.env.AGENTS_CONFIG    ?? 'agents.yaml');
  const pipelinesPath = path.resolve(process.env.PIPELINES_CONFIG ?? 'pipelines.yaml');

  // ── cortex config ... ─────────────────────────────────────────────────────
  if (args[0] === 'config') {
    handleConfigCommand(args.slice(1));
    return;
  }

  // ── cortex run [pipeline-id] ["goal"] ────────────────────────────────────
  if (args[0] === 'run' || args.length === 0) {
    const subArgs = args.slice(args[0] === 'run' ? 1 : 0);

    if (subArgs.length === 0) {
      // No pipeline id → interactive picker
      await runInteractive(agentsPath, pipelinesPath);
      return;
    }

    if (subArgs[0] === '--list' || subArgs[0] === '-l') {
      listPipelines(pipelinesPath);
      return;
    }

    const [pipelineId, goal] = subArgs;
    if (!goal) {
      console.error('Usage: cortex run <pipeline-id> "<goal>"');
      process.exit(1);
    }
    await runDirect(agentsPath, pipelinesPath, pipelineId, goal);
    return;
  }

  // ── Legacy: cortex <config.yaml> "<goal>" [orchestrator-key] ─────────────
  if (args.length < 2) {
    printHelp();
    process.exit(1);
  }

  const [configPath, goal, orchestratorKey = 'orchestrator'] = args;

  // Load config
  const config = loadConfig(path.resolve(configPath));

  // Instantiate all agents (resolve baseAgent references)
  const agentMap = new Map<string, Agent>();
  for (const [id, agentConfig] of Object.entries(config.agents)) {
    let resolved = agentConfig;
    if (agentConfig.baseAgent && !agentConfig.provider) {
      const base = config.agents[agentConfig.baseAgent];
      if (base?.provider) resolved = { ...agentConfig, provider: base.provider };
    }
    if (resolved.provider) agentMap.set(id, new Agent(id, resolved as typeof agentConfig & { provider: NonNullable<typeof agentConfig.provider> }));
  }

  // Resolve orchestrator
  let orchestratorAgent: Agent;
  if (agentMap.has(orchestratorKey)) {
    orchestratorAgent = agentMap.get(orchestratorKey)!;
  } else {
    const firstEntry = Object.entries(config.agents)[0];
    if (!firstEntry) throw new Error('No agents defined in config');
    // Resolve provider for fallback (may need to follow baseAgent)
    let fallbackProvider = firstEntry[1].provider;
    if (!fallbackProvider && firstEntry[1].baseAgent) {
      fallbackProvider = config.agents[firstEntry[1].baseAgent]?.provider;
    }
    if (!fallbackProvider) throw new Error('Could not resolve a provider for fallback orchestrator');
    const fallbackConfig = { system: ORCHESTRATOR_SYSTEM, provider: fallbackProvider } as AgentConfig & { provider: NonNullable<AgentConfig['provider']> };
    orchestratorAgent = new Agent(orchestratorKey, fallbackConfig);
    console.log(`ℹ No "${orchestratorKey}" agent found, using "${firstEntry[0]}"'s provider.\n`);
  }

  // Worker agents = everyone except the orchestrator
  const workerEntries = Object.entries(config.agents)
    .filter(([k]) => k !== orchestratorKey)
    .map(([id, cfg]) => ({ id, role: cfg.role, description: cfg.description }));

  if (workerEntries.length === 0) {
    throw new Error('No worker agents found. Add at least one non-orchestrator agent in agents.yaml.');
  }

  console.log('Cortex starting…');
  console.log(`  Orchestrator : ${orchestratorKey}`);
  console.log(`  Workers      : ${workerEntries.map((w) => `${w.id}${w.role ? `[${w.role}]` : ''}`).join(', ')}`);
  console.log(`  Goal         : ${goal}\n`);

  // Plan
  const orchestrator = new Orchestrator(orchestratorAgent);
  const plan = await orchestrator.plan(goal, workerEntries);

  console.log('📋 Plan generated:');
  for (const task of plan.tasks) {
    const agents = Array.isArray(task.agent) ? task.agent.join('+') : task.agent;
    const deps = task.dependsOn.length ? ` (after: ${task.dependsOn.join(', ')})` : '';
    console.log(`  ${task.id}: [${agents}] ${task.name}${deps}`);
  }
  if (plan.decisions.length) {
    console.log('  Decision points:');
    for (const dp of plan.decisions) {
      console.log(`  ⬡ ${dp.id}: ${dp.agent} evaluates [${dp.evaluates.join(', ')}] maxRetries=${dp.maxRetries}`);
    }
  }
  console.log('');

  // Execute
  const runner = new Runner(agentMap);
  const results = await runner.run(plan);

  // Summary (skip internal decision keys)
  console.log('\n═══════════════════════════════════════════');
  console.log('RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════\n');

  for (const [id, result] of results) {
    if (id.startsWith('__decision_')) continue;
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

function printHelp() {
  console.log('');
  console.log('  cortex                                  Interactive pipeline picker');
  console.log('  cortex run                              Interactive pipeline picker');
  console.log('  cortex run <pipeline-id> "<goal>"       Run pipeline directly');
  console.log('  cortex run --list                       List available pipelines');
  console.log('  cortex config set <key> <value>         Set config value');
  console.log('  cortex config get [key]                 Show config value(s)');
  console.log('  cortex config reset                     Reset config to defaults');
  console.log('  cortex <agents.yaml> "<goal>"           Legacy: plan & run via orchestrator');
  console.log('');
}
