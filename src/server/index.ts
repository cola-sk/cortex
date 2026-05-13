import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import { ConfigFileSchema, AgentConfigSchema, type ConfigFile } from '../config/schema.js';
import { PipelineConfigSchema, PipelineFileSchema, type PipelineFile } from '../config/pipelineSchema.js';
import { detectAllTools, detectTool } from '../importers/index.js';
import { readAppConfig, portFromUrl, DEFAULT_CONFIG } from '../config/appConfig.js';
import { Agent } from '../core/agent.js';
import { Runner } from '../core/runner.js';
import type { Plan, TaskResult } from '../core/plan.js';
import type { ToolEvent } from '../core/events.js';

const app = express();
const appConfig = readAppConfig();
const PORT = Number(process.env.PORT ?? portFromUrl(appConfig.server_url, portFromUrl(DEFAULT_CONFIG.server_url, 47821)));
const CONFIG_PATH = path.resolve(process.env.AGENTS_CONFIG ?? 'agents.yaml');
const PIPELINES_PATH = path.resolve(process.env.PIPELINES_CONFIG ?? 'pipelines.yaml');
const RUNS_DIR = path.resolve(process.env.RUNS_DIR ?? 'runs');

// ---- Run record types ----

interface RunTaskRecord {
  taskId: string;
  taskName: string;
  agents: string[];
  status: 'pending' | 'running' | 'done' | 'error';
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  output?: string;
  error?: string;
  toolEvents?: ToolEvent[][];
}

interface RunRecord {
  id: string;
  pipelineId: string;
  pipelineName: string;
  goal: string;
  status: 'running' | 'done' | 'error';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  taskCount: number;
  toolCallCount: number;
  tasks: RunTaskRecord[];
}

function generateRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function ensureRunsDir(): void {
  if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function saveRun(run: RunRecord): void {
  ensureRunsDir();
  fs.writeFileSync(path.join(RUNS_DIR, `${run.id}.json`), JSON.stringify(run, null, 2), 'utf-8');
}

function countToolCalls(tasks: RunTaskRecord[]): number {
  return tasks.reduce((sum, t) => {
    return sum + (t.toolEvents ?? []).flat().filter((e) => e.type === 'tool_use').length;
  }, 0);
}

app.use(cors());
app.use(express.json());

// Serve built frontend in production
const webDist = path.join(process.cwd(), 'web-dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
}

// ---- helpers ----

function readConfig(): ConfigFile {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { agents: {} };
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = yaml.load(raw);
  return ConfigFileSchema.parse(parsed ?? { agents: {} });
}

function writeConfig(config: ConfigFile): void {
  const yaml_str = yaml.dump(config, { indent: 2, lineWidth: -1 });
  fs.writeFileSync(CONFIG_PATH, yaml_str, 'utf-8');
}

function agentList(config: ConfigFile) {
  return Object.entries(config.agents).map(([id, agent]) => ({ id, ...agent }));
}

// ---- API routes ----

// GET /api/agents
app.get('/api/agents', (_req, res) => {
  try {
    res.json(agentList(readConfig()));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/agents
app.post('/api/agents', (req, res) => {
  try {
    const { id, ...agentData } = req.body as { id?: string } & Record<string, unknown>;
    if (!id || typeof id !== 'string' || !/^[a-z0-9_-]+$/.test(id)) {
      res.status(400).json({ error: 'Agent id is required and must be lowercase alphanumeric/dash/underscore' });
      return;
    }
    const config = readConfig();
    if (config.agents[id]) {
      res.status(409).json({ error: `Agent "${id}" already exists` });
      return;
    }
    const agent = AgentConfigSchema.parse(agentData);
    config.agents[id] = agent;
    writeConfig(config);
    res.status(201).json({ id, ...agent });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// PUT /api/agents/:id
app.put('/api/agents/:id', (req, res) => {
  try {
    const { id } = req.params;
    const config = readConfig();
    if (!config.agents[id]) {
      res.status(404).json({ error: `Agent "${id}" not found` });
      return;
    }
    const agent = AgentConfigSchema.parse(req.body);
    config.agents[id] = agent;
    writeConfig(config);
    res.json({ id, ...agent });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// DELETE /api/agents/:id
app.delete('/api/agents/:id', (req, res) => {
  try {
    const { id } = req.params;
    const config = readConfig();
    if (!config.agents[id]) {
      res.status(404).json({ error: `Agent "${id}" not found` });
      return;
    }
    delete config.agents[id];
    writeConfig(config);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---- Importer routes ----

// ---- Runs routes ----

// GET /api/runs — list recent runs (summary, no full output)
app.get('/api/runs', (_req, res) => {
  try {
    ensureRunsDir();
    const files = fs.readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 100);

    const runs = files.flatMap((f) => {
      try {
        const run = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf-8')) as RunRecord;
        // Return summary without full task outputs
        return [{
          id: run.id,
          pipelineId: run.pipelineId,
          pipelineName: run.pipelineName,
          goal: run.goal,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          durationMs: run.durationMs,
          taskCount: run.taskCount,
          toolCallCount: run.toolCallCount,
        }];
      } catch { return []; }
    });

    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/runs/:id — full run detail
app.get('/api/runs/:id', (req, res) => {
  try {
    const { id } = req.params;
    const filePath = path.join(RUNS_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: `Run "${id}" not found` });
      return;
    }
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/importers  — detect all local CLI tools
app.get('/api/importers', (_req, res) => {
  try {
    res.json(detectAllTools());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/importers/:toolId  — import a detected tool as an agent
app.post('/api/importers/:toolId', (req, res) => {
  try {
    const { toolId } = req.params;
    const tool = detectTool(toolId);

    if (!tool) {
      res.status(404).json({ error: `Unknown tool "${toolId}"` });
      return;
    }
    if (!tool.detected || !tool.provider) {
      res.status(422).json({ error: `Tool "${toolId}" detected but could not extract provider config: ${tool.note ?? 'unknown reason'}` });
      return;
    }

    // Agent id = tool.id, overridable via body { agentId }
    const body = req.body as { agentId?: string; system?: string; description?: string };
    const agentId = (body.agentId ?? tool.id).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();

    const config = readConfig();
    if (config.agents[agentId]) {
      res.status(409).json({ error: `Agent "${agentId}" already exists. Delete it first or use a different agentId.` });
      return;
    }

    const agent = AgentConfigSchema.parse({
      description: body.description ?? `Imported from ${tool.name}`,
      system: body.system ?? `You are a helpful AI assistant using ${tool.name}.`,
      provider: tool.provider,
    });

    config.agents[agentId] = agent;
    writeConfig(config);
    res.status(201).json({ id: agentId, ...agent });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---- Pipeline helpers ----

function readPipelineFile(): PipelineFile {
  if (!fs.existsSync(PIPELINES_PATH)) return { pipelines: {} };
  const raw = fs.readFileSync(PIPELINES_PATH, 'utf-8');
  const parsed = yaml.load(raw);
  return PipelineFileSchema.parse(parsed ?? { pipelines: {} });
}

function writePipelineFile(pf: PipelineFile): void {
  fs.writeFileSync(PIPELINES_PATH, yaml.dump(pf, { indent: 2, lineWidth: -1 }), 'utf-8');
}

// GET /api/pipelines
app.get('/api/pipelines', (_req, res) => {
  try {
    const pf = readPipelineFile();
    const list = Object.entries(pf.pipelines).map(([id, p]) => ({ id, ...p }));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/pipelines
app.post('/api/pipelines', (req, res) => {
  try {
    const { id, ...rest } = req.body as { id?: string } & Record<string, unknown>;
    if (!id || typeof id !== 'string' || !/^[a-z0-9_-]+$/.test(id)) {
      res.status(400).json({ error: 'Pipeline id is required (lowercase alphanumeric/dash/underscore)' });
      return;
    }
    const pf = readPipelineFile();
    if (pf.pipelines[id]) {
      res.status(409).json({ error: `Pipeline "${id}" already exists` });
      return;
    }
    const pipeline = PipelineConfigSchema.parse(rest);
    pf.pipelines[id] = pipeline;
    writePipelineFile(pf);
    res.status(201).json({ id, ...pipeline });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// PUT /api/pipelines/:id
app.put('/api/pipelines/:id', (req, res) => {
  try {
    const { id } = req.params;
    const pf = readPipelineFile();
    const pipeline = PipelineConfigSchema.parse(req.body);
    pf.pipelines[id] = pipeline;
    writePipelineFile(pf);
    res.json({ id, ...pipeline });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// DELETE /api/pipelines/:id
app.delete('/api/pipelines/:id', (req, res) => {
  try {
    const { id } = req.params;
    const pf = readPipelineFile();
    if (!pf.pipelines[id]) {
      res.status(404).json({ error: `Pipeline "${id}" not found` });
      return;
    }
    delete pf.pipelines[id];
    writePipelineFile(pf);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/pipelines/:id/run  — SSE stream
app.post('/api/pipelines/:id/run', async (req, res) => {
  const { id } = req.params;
  const { goal } = req.body as { goal?: string };

  if (!goal?.trim()) {
    res.status(400).json({ error: 'goal is required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const pf = readPipelineFile();
    const pipelineCfg = pf.pipelines[id];
    if (!pipelineCfg) {
      emit('error', { message: `Pipeline "${id}" not found` });
      res.end();
      return;
    }

    const agentsCfg = readConfig();
    const agentMap = new Map<string, Agent>();
    for (const [agentId, agentConfig] of Object.entries(agentsCfg.agents)) {
      // Resolve baseAgent: inherit provider from referenced agent
      let resolvedConfig = agentConfig;
      if (agentConfig.baseAgent && !agentConfig.provider) {
        const base = agentsCfg.agents[agentConfig.baseAgent];
        if (base?.provider) {
          resolvedConfig = { ...agentConfig, provider: base.provider };
        } else {
          emit('error', { message: `Agent "${agentId}" references baseAgent "${agentConfig.baseAgent}" which has no provider` });
          res.end();
          return;
        }
      }
      if (!resolvedConfig.provider) {
        emit('error', { message: `Agent "${agentId}" has no provider configured` });
        res.end();
        return;
      }
      agentMap.set(agentId, new Agent(agentId, resolvedConfig as typeof agentConfig & { provider: NonNullable<typeof agentConfig.provider> }));
    }

    const plan: Plan = {
      goal: goal.trim(),
      tasks: pipelineCfg.tasks,
      decisions: pipelineCfg.decisions,
    };

    // ---- Create run record ----
    const runId = generateRunId();
    const runStartedAt = new Date().toISOString();
    const run: RunRecord = {
      id: runId,
      pipelineId: id,
      pipelineName: pipelineCfg.name ?? id,
      goal: goal.trim(),
      status: 'running',
      startedAt: runStartedAt,
      taskCount: pipelineCfg.tasks.length,
      toolCallCount: 0,
      tasks: pipelineCfg.tasks.map((t) => ({
        taskId: t.id,
        taskName: t.name,
        agents: Array.isArray(t.agent) ? t.agent : [t.agent],
        status: 'pending' as const,
      })),
    };

    const taskStartTimes = new Map<string, number>();

    const runner = new Runner(agentMap, {
      onTaskStart: (taskId, taskName, agents) => {
        emit('task:start', { taskId, taskName, agents });
        const task = run.tasks.find((t) => t.taskId === taskId);
        if (task) { task.status = 'running'; task.startedAt = new Date().toISOString(); }
        taskStartTimes.set(taskId, Date.now());
      },
      onTaskComplete: (taskId, taskName, result: TaskResult) => {
        emit('task:complete', { taskId, taskName, output: result.output, error: result.error });
        const task = run.tasks.find((t) => t.taskId === taskId);
        if (task) {
          task.status = result.error ? 'error' : 'done';
          task.finishedAt = new Date().toISOString();
          const started = taskStartTimes.get(taskId);
          if (started) task.durationMs = Date.now() - started;
          task.output = result.output;
          if (result.error) task.error = result.error;
          if (result.toolEvents) task.toolEvents = result.toolEvents;
          run.toolCallCount = countToolCalls(run.tasks);
        }
      },
      onDecisionStart: (decisionId, evaluates) => emit('decision:start', { decisionId, evaluates }),
      onDecisionComplete: (decisionId, decision, retrying) =>
        emit('decision:complete', { decisionId, action: decision.action, reason: decision.reason, retrying }),
    });

    const results = await runner.run(plan);

    run.status = 'done';
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - new Date(runStartedAt).getTime();
    run.toolCallCount = countToolCalls(run.tasks);
    saveRun(run);

    const summary: Record<string, { output: string; error?: string }> = {};
    for (const [key, r] of results) {
      if (!key.startsWith('__decision_')) {
        summary[key] = { output: r.output, ...(r.error ? { error: r.error } : {}) };
      }
    }
    emit('complete', { taskCount: plan.tasks.length, results: summary, runId });
  } catch (err) {
    emit('error', { message: (err as Error).message });
  }

  res.end();
});

// SPA fallback
app.get('/{*path}', (_req, res) => {  const indexPath = path.join(webDist, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not built. Run: npm run web:build');
  }
});

app.listen(PORT, () => {
  console.log(`\nCortex API →  http://localhost:${PORT}`);
  console.log(`Cortex UI  →  ${appConfig.app_url}`);
  console.log(`Config     →  ${CONFIG_PATH}`);
  console.log(`App config →  ~/.cortex/config.json\n`);
});
