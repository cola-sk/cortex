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
import type { Plan, TaskResult, ReviewAction, TaskRound } from '../core/plan.js';
import type { ToolEvent } from '../core/events.js';

const app = express();
const appConfig = readAppConfig();
const PORT = Number(process.env.PORT ?? portFromUrl(appConfig.server_url, portFromUrl(DEFAULT_CONFIG.server_url, 47821)));
const CONFIG_PATH = path.resolve(process.env.AGENTS_CONFIG ?? 'agents.yaml');
const PIPELINES_PATH = path.resolve(process.env.PIPELINES_CONFIG ?? 'pipelines.yaml');
const RUNS_DIR = path.resolve(process.env.RUNS_DIR ?? 'runs');

// ---- Run record types ----

interface ReviewRecord {
  action: 'approve' | 'revise';
  comment: string;
  targetTaskId?: string;
  reviewedAt: string;
}

interface RoundRecord {
  round: number;
  output: string;
  toolEvents?: ToolEvent[][];
  finishedAt: string;
  review?: ReviewRecord;
}

interface RunTaskRecord {
  taskId: string;
  taskName: string;
  agents: string[];
  status: 'pending' | 'running' | 'done' | 'error' | 'awaiting_review';
  requiresReview?: boolean;
  currentRound?: number;
  rounds?: RoundRecord[];
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  output?: string;
  outputs?: string[];
  error?: string;
  toolEvents?: ToolEvent[][];
  workerStatus?: ('running' | 'done' | 'error')[];
}

interface RunRecord {
  id: string;
  pipelineId: string;
  pipelineName: string;
  goal: string;
  status: 'running' | 'done' | 'error' | 'awaiting_review';
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

function resolveWorkspacePath(workspace?: string): string {
  if (!workspace) return '';
  if (workspace.startsWith('~')) {
    return path.join(process.env.HOME ?? '', workspace.slice(1));
  }
  return path.resolve(workspace);
}

// ---- Active runs tracking (in-memory for live access) ----
const activeRuns = new Map<string, RunRecord>();
// Per-run SSE subscribers for /api/runs/:id/stream
const runSubscribers = new Map<string, Set<express.Response>>();
// Per-run review resolvers: key = "runId:taskId"
const reviewResolvers = new Map<string, (review: ReviewAction) => void>();

function emitToRunSubscribers(runId: string, type: string, data: unknown): void {
  const subs = runSubscribers.get(runId);
  if (!subs || subs.size === 0) return;
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subs) {
    try { res.write(payload); } catch { subs.delete(res); }
  }
}

// Debounced save for in-progress events (avoid hammering disk)
const savePending = new Map<string, ReturnType<typeof setTimeout>>();
function debouncedSaveRun(run: RunRecord, delay = 2000): void {
  const existing = savePending.get(run.id);
  if (existing) clearTimeout(existing);
  savePending.set(run.id, setTimeout(() => {
    savePending.delete(run.id);
    saveRun(run);
  }, delay));
}

function flushAndSaveRun(run: RunRecord): void {
  const existing = savePending.get(run.id);
  if (existing) clearTimeout(existing);
  savePending.delete(run.id);
  saveRun(run);
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

// ---- Auto-init config files from templates if they don't exist ----

function initConfigIfMissing(configPath: string, exampleName: string): void {
  if (!fs.existsSync(configPath)) {
    const templatePath = path.resolve(exampleName);
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, configPath);
      console.log(`  Created ${path.basename(configPath)} from ${exampleName}`);
    }
  }
}

initConfigIfMissing(CONFIG_PATH, 'agents.example.yaml');
initConfigIfMissing(PIPELINES_PATH, 'pipelines.example.yaml');

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

// GET /api/workspace/validate?path=...
app.get('/api/workspace/validate', (req, res) => {
  const rawPath = req.query['path'];
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    res.status(400).json({ error: 'path query param required' });
    return;
  }
  const resolved = resolveWorkspacePath(rawPath.trim());
  if (!fs.existsSync(resolved)) {
    res.status(400).json({ error: `Path does not exist: ${rawPath}` });
    return;
  }
  if (!fs.statSync(resolved).isDirectory()) {
    res.status(400).json({ error: `Path is not a directory: ${rawPath}` });
    return;
  }
  res.json({ ok: true, resolved });
});

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

// GET /api/runs/:id — full run detail (live in-memory if active, else from disk)
app.get('/api/runs/:id', (req, res) => {
  try {
    const { id } = req.params;
    // Return live in-memory data if this run is active
    const active = activeRuns.get(id);
    if (active) {
      res.json(active);
      return;
    }
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

// GET /api/runs/:id/stream — SSE stream for an active run (subscribe to live events)
app.get('/api/runs/:id/stream', (req, res) => {
  const { id } = req.params;
  const active = activeRuns.get(id);
  if (!active) {
    // Run is not active — return 204 (no content to stream)
    res.status(204).end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Subscribe this response to future events
  if (!runSubscribers.has(id)) runSubscribers.set(id, new Set());
  runSubscribers.get(id)!.add(res);

  res.on('close', () => {
    runSubscribers.get(id)?.delete(res);
  });
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
    const pf = readPipelineFile();
    const pipeline = PipelineConfigSchema.parse(req.body);
    // Validate workspace path if provided
    const wsResolved = resolveWorkspacePath(pipeline.workspace);
    if (pipeline.workspace && !fs.existsSync(wsResolved)) {
      res.status(400).json({ error: `Workspace path does not exist: ${pipeline.workspace}` });
      return;
    }
    // Auto-generate a unique pipeline ID
    let id = `pipe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    let attempts = 0;
    while (pf.pipelines[id]) {
      id = `pipe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      if (++attempts > 10) throw new Error('Failed to generate unique pipeline ID');
    }
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
    // Validate workspace path if provided
    const wsResolvedPut = resolveWorkspacePath(pipeline.workspace);
    if (pipeline.workspace && !fs.existsSync(wsResolvedPut)) {
      res.status(400).json({ error: `Workspace path does not exist: ${pipeline.workspace}` });
      return;
    }
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

// POST /api/runs/:runId/review — submit human review for a paused task
app.post('/api/runs/:runId/review', (req, res) => {
  try {
    const { runId } = req.params;
    const body = req.body as { taskId?: string; action?: string; comment?: string; targetTaskId?: string };

    if (!body.taskId || typeof body.taskId !== 'string') {
      res.status(400).json({ error: 'taskId is required' });
      return;
    }
    if (body.action !== 'approve' && body.action !== 'revise') {
      res.status(400).json({ error: 'action must be "approve" or "revise"' });
      return;
    }
    if (body.action === 'revise' && (!body.comment || !body.comment.trim())) {
      res.status(400).json({ error: 'comment is required when action is "revise"' });
      return;
    }

    const key = `${runId}:${body.taskId}`;
    const resolver = reviewResolvers.get(key);
    if (!resolver) {
      res.status(404).json({ error: `No pending review for run "${runId}" task "${body.taskId}"` });
      return;
    }

    const review: ReviewAction = {
      action: body.action,
      comment: body.comment ?? '',
      targetTaskId: body.targetTaskId,
    };
    resolver(review);
    reviewResolvers.delete(key);
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

  let run: RunRecord | null = null;
  let aborted = false;
  let pipelineFinished = false;
  const abortController = new AbortController();

  const doAbort = () => {
    // Guard: don't abort if pipeline already completed normally
    if (pipelineFinished) return;
    if (!aborted && run && (run.status === 'running' || run.status === 'awaiting_review')) {
      aborted = true;
      abortController.abort();
      run.status = 'error';
      run.finishedAt = new Date().toISOString();
      run.durationMs = Date.now() - new Date(run.startedAt).getTime();
      for (const task of run.tasks) {
        if (task.status === 'running' || task.status === 'pending') {
          task.status = 'error';
          task.error = 'Interrupted';
        }
      }
      saveRun(run);
    }
  };

  // Use res.on('close') instead of req.on('close') — the response stream closing
  // is a more reliable indicator that the client disconnected.
  // Also guard against premature close events by verifying res.writableFinished.
  res.on('close', () => {
    if (!res.writableFinished) {
      // Client disconnected before we finished writing
      doAbort();
    }
  });

  // Forward SIGTERM to running child processes
  const sigtermHandler = () => doAbort();
  process.once('SIGTERM', sigtermHandler);

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
    run = {
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
        ...(t.requiresReview ? { requiresReview: true } : {}),
      })),
    };
    saveRun(run);
    activeRuns.set(runId, run);

    emit('run:started', { runId });
    emitToRunSubscribers(runId, 'run:started', { runId });

    const taskStartTimes = new Map<string, number>();

    const runner = new Runner(agentMap, {
      onTaskStart: (taskId, taskName, agents) => {
        emit('task:start', { taskId, taskName, agents });
        emitToRunSubscribers(runId, 'task:start', { taskId, taskName, agents });
        const task = run!.tasks.find((t) => t.taskId === taskId);
        if (task) {
          task.status = 'running';
          task.startedAt = new Date().toISOString();
          if (agents.length > 1) task.workerStatus = agents.map(() => 'running');
        }
        taskStartTimes.set(taskId, Date.now());
        flushAndSaveRun(run!);
      },
      onTaskProgress: (taskId, workerIndex, event) => {
        emit('task:tool_event', { taskId, workerIndex, event });
        emitToRunSubscribers(runId, 'task:tool_event', { taskId, workerIndex, event });
        const task = run!.tasks.find((t) => t.taskId === taskId);
        if (task) {
          if (!task.toolEvents) task.toolEvents = [];
          // Ensure all slots up to workerIndex are initialized (avoid sparse arrays)
          while (task.toolEvents.length <= workerIndex) task.toolEvents.push([]);
          task.toolEvents[workerIndex].push(event);
        }
        debouncedSaveRun(run!);
      },
      onWorkerComplete: (taskId, workerIndex, output, error) => {
        emit('worker:complete', { taskId, workerIndex, output: output.slice(0, 200), error });
        emitToRunSubscribers(runId, 'worker:complete', { taskId, workerIndex, output: output.slice(0, 200), error });
        const task = run!.tasks.find((t) => t.taskId === taskId);
        if (task) {
          if (!task.workerStatus) task.workerStatus = [];
          while (task.workerStatus.length <= workerIndex) task.workerStatus.push('running');
          task.workerStatus[workerIndex] = error ? 'error' : 'done';
        }
        flushAndSaveRun(run!);
      },
      onTaskComplete: (taskId, taskName, result: TaskResult) => {
        emit('task:complete', { taskId, taskName, output: result.output, outputs: result.outputs, error: result.error });
        emitToRunSubscribers(runId, 'task:complete', { taskId, taskName, output: result.output, outputs: result.outputs, error: result.error });
        const task = run!.tasks.find((t) => t.taskId === taskId);
        if (task) {
          task.status = result.error ? 'error' : 'done';
          task.finishedAt = new Date().toISOString();
          const started = taskStartTimes.get(taskId);
          if (started) task.durationMs = Date.now() - started;
          task.output = result.output;
          if (result.outputs && result.outputs.length > 1) task.outputs = result.outputs;
          task.error = result.error || undefined;
          if (result.toolEvents) task.toolEvents = result.toolEvents;
          run!.toolCallCount = countToolCalls(run!.tasks);
          flushAndSaveRun(run!);
        }
      },
      onDecisionStart: (decisionId, evaluates) => {
        emit('decision:start', { decisionId, evaluates });
        emitToRunSubscribers(runId, 'decision:start', { decisionId, evaluates });
      },
      onDecisionComplete: (decisionId, decision, retrying) => {
        emit('decision:complete', { decisionId, action: decision.action, reason: decision.reason, retrying });
        emitToRunSubscribers(runId, 'decision:complete', { decisionId, action: decision.action, reason: decision.reason, retrying });
      },
      onReviewRequired: (taskId, taskName, output, round) => {
        return new Promise<ReviewAction>((resolve) => {
          const key = `${runId}:${taskId}`;
          reviewResolvers.set(key, resolve);
          // Update run status
          run!.status = 'awaiting_review';
          const task = run!.tasks.find((t) => t.taskId === taskId);
          if (task) {
            task.status = 'awaiting_review';
            task.currentRound = round;
          }
          flushAndSaveRun(run!);
          emit('review:pending', { taskId, taskName, output, round });
          emitToRunSubscribers(runId, 'review:pending', { taskId, taskName, output, round });
        });
      },
      onReviewSubmitted: (taskId, action, round) => {
        run!.status = 'running';
        const task = run!.tasks.find((t) => t.taskId === taskId);
        if (task) {
          if (!task.rounds) task.rounds = [];
          task.rounds.push({
            round,
            output: task.output ?? '',
            toolEvents: task.toolEvents,
            finishedAt: new Date().toISOString(),
            review: {
              action: action.action,
              comment: action.comment,
              targetTaskId: action.targetTaskId,
              reviewedAt: new Date().toISOString(),
            },
          });
          if (action.action === 'approve') {
            task.status = 'done';
          } else {
            task.status = 'pending';
          }
        }
        flushAndSaveRun(run!);
        emit('review:submitted', { taskId, action: action.action, comment: action.comment, targetTaskId: action.targetTaskId, round });
        emitToRunSubscribers(runId, 'review:submitted', { taskId, action: action.action, comment: action.comment, targetTaskId: action.targetTaskId, round });
      },
      onTaskRevision: (taskId, round) => {
        const task = run!.tasks.find((t) => t.taskId === taskId);
        if (task) {
          task.status = 'running';
          task.currentRound = round;
        }
        flushAndSaveRun(run!);
        emit('task:revision', { taskId, round });
        emitToRunSubscribers(runId, 'task:revision', { taskId, round });
      },
      onTaskRollback: (fromTaskId, toTaskId, reason) => {
        // Reset downstream tasks in the run record
        for (const task of run!.tasks) {
          if (task.taskId === toTaskId || task.status === 'done') {
            // Only reset tasks that would need to re-run
          }
        }
        flushAndSaveRun(run!);
        emit('task:rollback', { fromTaskId, toTaskId, reason });
        emitToRunSubscribers(runId, 'task:rollback', { fromTaskId, toTaskId, reason });
      },
    }, false, pipelineCfg.workspace);

    const results = await runner.run(plan, abortController.signal);

    if (!aborted) {
      pipelineFinished = true;
      const hasTaskErrors = run.tasks.some(t => t.status === 'error');
      run.status = hasTaskErrors ? 'error' : 'done';
      run.finishedAt = new Date().toISOString();
      run.durationMs = Date.now() - new Date(runStartedAt).getTime();
      run.toolCallCount = countToolCalls(run.tasks);
      flushAndSaveRun(run);

      const summary: Record<string, { output: string; error?: string }> = {};
      for (const [key, r] of results) {
        if (!key.startsWith('__decision_')) {
          summary[key] = { output: r.output, ...(r.error ? { error: r.error } : {}) };
        }
      }
      emit('complete', { taskCount: plan.tasks.length, results: summary, runId });
      emitToRunSubscribers(runId, 'complete', { taskCount: plan.tasks.length, results: summary, runId });
    }
  } catch (err) {
    if (!aborted) {
      emit('error', { message: (err as Error).message });
      if (run) emitToRunSubscribers(run.id, 'error', { message: (err as Error).message });
      if (run && (run.status === 'running' || run.status === 'awaiting_review')) {
        run.status = 'error';
        run.finishedAt = new Date().toISOString();
        run.durationMs = Date.now() - new Date(run.startedAt).getTime();
        flushAndSaveRun(run);
      }
    }
  } finally {
    process.off('SIGTERM', sigtermHandler);
    if (run) {
      activeRuns.delete(run.id);
      // Clean up any pending review resolvers for this run
      for (const key of reviewResolvers.keys()) {
        if (key.startsWith(`${run.id}:`)) reviewResolvers.delete(key);
      }
      // Close all run subscribers
      const subs = runSubscribers.get(run.id);
      if (subs) {
        for (const sub of subs) { try { sub.end(); } catch {} }
        runSubscribers.delete(run.id);
      }
    }
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

  // Clean up orphaned runs (stuck in 'running' from a previous crash/restart)
  try {
    const runsDir = path.join(process.cwd(), 'runs');
    if (fs.existsSync(runsDir)) {
      for (const file of fs.readdirSync(runsDir).filter((f) => f.endsWith('.json'))) {
        try {
          const fp = path.join(runsDir, file);
          const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
          if (data.status === 'running' || data.status === 'awaiting_review') {
            data.status = 'error';
            data.finishedAt = new Date().toISOString();
            data.durationMs = Date.now() - new Date(data.startedAt).getTime();
            for (const t of data.tasks ?? []) {
              if (t.status === 'running' || t.status === 'pending') {
                t.status = 'error';
                t.error = 'Server restarted during execution';
              }
            }
            fs.writeFileSync(fp, JSON.stringify(data, null, 2));
            console.log(`  ⚠ Fixed orphaned run: ${data.id}`);
          }
        } catch { /* skip corrupt files */ }
      }
    }
  } catch { /* ignore cleanup errors */ }
});
