import readline from 'readline';
import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import { PipelineFileSchema } from '../config/pipelineSchema.js';
import { loadConfig } from '../config/loader.js';
import { Agent } from '../core/agent.js';
import { Runner } from '../core/runner.js';

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const R = '\x1b[0m';
const dim   = (s: string) => `\x1b[2m${s}${R}`;
const bold  = (s: string) => `\x1b[1m${s}${R}`;
const cyan  = (s: string) => `\x1b[36m${s}${R}`;
const green = (s: string) => `\x1b[32m${s}${R}`;
const yellow= (s: string) => `\x1b[33m${s}${R}`;
const red   = (s: string) => `\x1b[31m${s}${R}`;
const blue  = (s: string) => `\x1b[34m${s}${R}`;

const hr = (char = '─', w = 54) => dim(char.repeat(w));

// ── Pipeline loader ───────────────────────────────────────────────────────────
function readPipelines(p: string) {
  if (!fs.existsSync(p)) return {};
  const parsed = yaml.load(fs.readFileSync(p, 'utf-8'));
  const r = PipelineFileSchema.safeParse(parsed ?? { pipelines: {} });
  return r.success ? r.data.pipelines : {};
}

// ── Prompt helper ─────────────────────────────────────────────────────────────
function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((res) => rl.question(q, res));
}

// ── Agent validation ──────────────────────────────────────────────────────────
function missingAgents(pipeline: ReturnType<typeof readPipelines>[string], map: Map<string, Agent>) {
  const seen = new Set<string>();
  for (const t of pipeline.tasks) {
    for (const k of Array.isArray(t.agent) ? t.agent : [t.agent]) seen.add(k);
  }
  for (const d of pipeline.decisions) seen.add(d.agent);
  return [...seen].filter((k) => !map.has(k));
}

// ── Run a pipeline (shared by interactive + direct) ───────────────────────────
async function runPipeline(
  agentsPath: string,
  pipelinesPath: string,
  pipelineId: string,
  goal: string,
) {
  // Load agents
  let config;
  try {
    config = loadConfig(agentsPath);
  } catch (e) {
    console.error(`  ${red('✗')} Cannot load agents: ${(e as Error).message}`);
    process.exit(1);
  }

  // Load pipelines
  const pipelines = readPipelines(pipelinesPath);
  const pipeline = pipelines[pipelineId];
  if (!pipeline) {
    console.error(`  ${red('✗')} Pipeline "${pipelineId}" not found in ${pipelinesPath}`);
    process.exit(1);
  }

  // Build agent map
  const agentMap = new Map<string, Agent>();
  for (const [id, cfg] of Object.entries(config!.agents)) {
    agentMap.set(id, new Agent(id, cfg));
  }

  // Validate referenced agents exist
  const missing = missingAgents(pipeline, agentMap);
  if (missing.length > 0) {
    console.error(`  ${red('✗')} Missing agents in ${path.basename(agentsPath)}: ${missing.map(bold).join(', ')}`);
    console.error(`  ${dim('Add these agents to agents.yaml and try again.')}`);
    process.exit(1);
  }

  // Print run header
  console.log('');
  console.log(`  ${hr('═')}`);
  console.log(`  ${green('▶')}  ${bold(pipeline.name)}`);
  console.log(`     Goal: ${goal}`);
  const taskAgents = [...new Set(pipeline.tasks.flatMap((t) => Array.isArray(t.agent) ? t.agent : [t.agent]))];
  console.log(`     Agents: ${taskAgents.map(cyan).join(', ')}`);
  console.log(`  ${hr('═')}`);
  console.log('');

  const plan = { goal, tasks: pipeline.tasks, decisions: pipeline.decisions ?? [] };
  const t0 = Date.now();

  // Track live timers per task so we can cancel & overwrite on completion
  const activeTimers = new Map<string, { interval: NodeJS.Timeout; start: number; prefix: string }>();
  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  function taskLinePrefix(taskName: string, agents: string[]): string {
    return `  ${dim('⟳')}  ${bold(taskName)}  ${dim(agents.join(', '))}`;
  }

  function printTaskStart(taskName: string, agents: string[], taskId: string) {
    const prefix = taskLinePrefix(taskName, agents);
    process.stdout.write(`${prefix} … `);
    const start = Date.now();
    let tick = 0;
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const spin = dim(SPINNER[tick % SPINNER.length]);
      tick++;
      // Rewrite the line in-place using \r
      const cols = process.stdout.columns || 100;
      const line = `${prefix} ${spin} ${dim(`${elapsed}s`)}`;
      // Pad to clear any leftover chars from previous write
      process.stdout.write(`\r${line.padEnd(cols)}`);
    }, 100);
    activeTimers.set(taskId, { interval, start, prefix });
  }

  function printTaskDone(taskName: string, output: string, isError?: boolean, taskId?: string) {
    // Cancel the timer and finalize the line
    const timer = taskId ? activeTimers.get(taskId) : undefined;
    if (timer) {
      clearInterval(timer.interval);
      activeTimers.delete(taskId!);
      const elapsed = ((Date.now() - timer.start) / 1000).toFixed(1);
      const prefix = timer.prefix;
      const cols = process.stdout.columns || 100;
      // Clear the line and write final status
      const final = `${prefix} … ${isError ? red('✗') : green('✓')} ${dim(`(${elapsed}s)`)}`;
      process.stdout.write(`\r${final.padEnd(cols)}\n`);
    } else {
      process.stdout.write(isError ? red('✗\n') : green('✓\n'));
    }

    if (!output) return;

    // Smart display: detect raw JSON blobs and summarize them
    const trimmed = output.trim();
    const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('```json');

    const MAX_LINES = 40;
    const lines = trimmed.split('\n');
    const display = lines.length > MAX_LINES
      ? [...lines.slice(0, MAX_LINES), dim(`  … (${lines.length - MAX_LINES} more lines)`)]
      : lines;

    if (looksLikeJson && lines.length > 15) {
      // Just show a summary for large JSON blobs
      console.log(`     ${dim(`(JSON output, ${lines.length} lines — use web UI to inspect)`)}`);
    } else {
      console.log(`  ${hr('─')}`);
      for (const line of display) {
        console.log(`  ${line}`);
      }
      console.log(`  ${hr('─')}`);
    }
    console.log('');
  }

  function printDecision(decisionId: string, action: string, reason: string, retrying?: string[]) {
    const icon = action === 'retry' ? yellow('↺') : green('→');
    const detail = retrying?.length ? ` [重试: ${retrying.join(', ')}]` : '';
    console.log(`  ${icon}  ${dim('决策')} ${bold(decisionId)}: ${reason}${detail}`);
    console.log('');
  }

  try {
    const runner = new Runner(agentMap, {
      onTaskStart: (taskId, taskName, agents) => {
        printTaskStart(taskName, agents, taskId);
      },
      onTaskComplete: (taskId, taskName, result) => {
        printTaskDone(taskName, result.output || result.error || '', !!result.error, taskId);
      },
      onDecisionStart: (decisionId, evaluates) => {
        const prefix = `  ${dim('⟳')}  ${dim('Quality check')} ${bold(decisionId)} ${dim(`[${evaluates.join(', ')}]`)}`;
        process.stdout.write(`${prefix} … `);
        const start = Date.now();
        let tick = 0;
        const interval = setInterval(() => {
          const elapsed = Math.floor((Date.now() - start) / 1000);
          const spin = dim(SPINNER[tick % SPINNER.length]);
          tick++;
          const cols = process.stdout.columns || 100;
          process.stdout.write(`\r${`${prefix} ${spin} ${dim(`${elapsed}s`)}`.padEnd(cols)}`);
        }, 100);
        activeTimers.set(`decision:${decisionId}`, { interval, start, prefix });
      },
      onDecisionComplete: (decisionId, decision, retrying) => {
        const key = `decision:${decisionId}`;
        const timer = activeTimers.get(key);
        if (timer) {
          clearInterval(timer.interval);
          activeTimers.delete(key);
          const elapsed = ((Date.now() - timer.start) / 1000).toFixed(1);
          const icon = decision.action === 'retry' ? yellow('↺') : green('✓');
          const cols = process.stdout.columns || 100;
          process.stdout.write(`\r${`${timer.prefix} … ${icon} ${dim(`(${elapsed}s)`)}`.padEnd(cols)}\n`);
        } else {
          process.stdout.write(decision.action === 'retry' ? yellow('↺\n') : green('✓\n'));
        }
        printDecision(decisionId, decision.action, decision.reason, retrying);
      },
    });
    const results = await runner.run(plan);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`  ${hr('═')}`);
    console.log(`  ${green('✓')}  All tasks completed in ${elapsed}s`);
    console.log(`  ${hr('═')}`);
    console.log('');
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('');
    console.log(`  ${hr('═')}`);
    console.log(`  ${red('✗')}  Failed after ${elapsed}s: ${(e as Error).message}`);
    console.log(`  ${hr('═')}`);
    console.log('');
    process.exit(1);
  }
}

// ── Interactive picker ────────────────────────────────────────────────────────
export async function runInteractive(agentsPath: string, pipelinesPath: string) {
  // Banner
  console.log('');
  console.log(`  ${blue('◈')}  ${bold('CORTEX')}  — Pipeline Runner`);
  console.log(`  ${hr()}`);

  // Load pipelines
  const pipelines = readPipelines(pipelinesPath);
  const entries = Object.entries(pipelines);

  if (entries.length === 0) {
    console.log(`  ${yellow('!')} No pipelines found in ${pipelinesPath}`);
    console.log(`  ${dim('Create pipelines via the web UI or edit pipelines.yaml directly.')}`);
    console.log(`  ${dim('Start the web UI: cortex server')}`);
    console.log('');
    return;
  }

  console.log(`  ${dim(`${entries.length} pipeline(s) · ${path.basename(agentsPath)}`)}`);
  console.log('');

  // List pipelines
  entries.forEach(([, p], i) => {
    const meta = [
      `${p.tasks.length} task${p.tasks.length !== 1 ? 's' : ''}`,
      ...(p.decisions.length > 0 ? [`${p.decisions.length} decision${p.decisions.length !== 1 ? 's' : ''}`] : []),
    ].join(' · ');
    console.log(`  ${cyan((i + 1).toString().padStart(2))}  ${bold(p.name)}`);
    if (p.description) console.log(`      ${dim(p.description)}`);
    console.log(`      ${dim(meta)}`);
    console.log('');
  });
  console.log(`  ${hr()}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Pipeline selection
  let idx = -1;
  while (idx < 0) {
    const raw = (await ask(rl, `  Select [1-${entries.length}] or ${dim('q')} to quit: `)).trim();
    if (raw === 'q' || raw === 'quit') {
      rl.close();
      console.log('');
      return;
    }
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= entries.length) {
      idx = n - 1;
    } else {
      console.log(`  ${red('!')} Please enter a number between 1 and ${entries.length}`);
    }
  }

  const [pipelineId, pipeline] = entries[idx];
  console.log('');
  console.log(`  Selected: ${bold(pipeline.name)}  ${dim(`(${pipelineId})`)}`);
  console.log('');

  // Goal input
  const defaultGoal = pipeline.description ?? pipeline.name;
  const rawGoal = await ask(
    rl,
    `  Goal ${dim(`[Enter = "${defaultGoal.slice(0, 48)}${defaultGoal.length > 48 ? '…' : ''}"]`)}:\n  › `,
  );
  rl.close();

  const goal = rawGoal.trim() || defaultGoal;
  await runPipeline(agentsPath, pipelinesPath, pipelineId, goal);
}

// ── Direct (non-interactive) run ──────────────────────────────────────────────
export async function runDirect(agentsPath: string, pipelinesPath: string, pipelineId: string, goal: string) {
  await runPipeline(agentsPath, pipelinesPath, pipelineId, goal);
}

// ── List pipelines (for --list flag) ─────────────────────────────────────────
export function listPipelines(pipelinesPath: string) {
  const pipelines = readPipelines(pipelinesPath);
  const entries = Object.entries(pipelines);

  if (entries.length === 0) {
    console.log(`No pipelines in ${pipelinesPath}`);
    return;
  }

  console.log(`\nPipelines (${pipelinesPath}):\n`);
  for (const [id, p] of entries) {
    const meta = `${p.tasks.length} tasks` + (p.decisions.length > 0 ? `, ${p.decisions.length} decisions` : '');
    console.log(`  ${id.padEnd(24)} ${p.name}  ${dim(`[${meta}]`)}`);
    if (p.description) console.log(`  ${' '.repeat(24)} ${dim(p.description)}`);
  }
  console.log('');
}
