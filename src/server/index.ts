process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import { ConfigFileSchema, AgentConfigSchema, type ConfigFile } from '../config/schema.js';
import { PipelineConfigSchema, PipelineFileSchema, type PipelineFile } from '../config/pipelineSchema.js';
import { detectAllTools, detectTool } from '../importers/index.js';
import { readAppConfig, portFromUrl, DEFAULT_CONFIG } from '../config/appConfig.js';
import { Agent } from '../core/agent.js';
import { Runner } from '../core/runner.js';
import type { RunnerRunOptions } from '../core/runner.js';
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
  agentId?: string;
  reviewedAt: string;
}

type PauseMode = 'review' | 'interrupt';

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
  status: 'pending' | 'running' | 'done' | 'error' | 'awaiting_review' | 'interrupted' | 'terminated' | 'skipped';
  requiresReview?: boolean;
  input?: string;
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
  status: 'running' | 'done' | 'error' | 'awaiting_review' | 'interrupted' | 'terminated';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  taskCount: number;
  toolCallCount: number;
  continuedFromRunId?: string;
  continuationTaskId?: string;
  continuationTaskName?: string;
  continuationType?: 'continue' | 'branch';
  continuationRound?: number;
  tasks: RunTaskRecord[];
}

function toTaskRoundRecords(rounds?: RoundRecord[]): TaskRound[] {
  if (!rounds || rounds.length === 0) return [];
  return rounds.map((round) => ({
    round: round.round,
    input: '',
    output: round.output,
    toolEvents: round.toolEvents,
    finishedAt: round.finishedAt,
    review: round.review
      ? {
        action: round.review.action,
        comment: round.review.comment,
        targetTaskId: round.review.targetTaskId,
        agentId: round.review.agentId,
        reviewedAt: round.review.reviewedAt,
      }
      : undefined,
  }));
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
// Per-run pause mode for human interaction: key = "runId:taskId"
const reviewModes = new Map<string, PauseMode>();
// Per-task active abort controllers: key = "runId:taskId"
const activeTaskAborts = new Map<string, AbortController>();
// Per-run abort controllers: key = "runId"
const activeRunAborts = new Map<string, AbortController>();

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

function markRunAsTerminated(runId: string, reason = 'Terminated by user'): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  if (run.status !== 'running' && run.status !== 'awaiting_review' && run.status !== 'interrupted') return;

  const nowIso = new Date().toISOString();
  run.status = 'terminated';
  run.finishedAt = nowIso;
  run.durationMs = Date.now() - new Date(run.startedAt).getTime();

  for (const task of run.tasks) {
    if (task.status === 'pending') {
      task.status = 'skipped';
      task.error = undefined;
      task.finishedAt = nowIso;
      continue;
    }
    if (task.status === 'running' || task.status === 'awaiting_review' || task.status === 'interrupted') {
      task.status = 'terminated';
      task.error = reason;
      task.finishedAt = nowIso;
      if (task.startedAt) {
        task.durationMs = Date.now() - new Date(task.startedAt).getTime();
      }
    }
  }

  run.toolCallCount = countToolCalls(run.tasks);
  flushAndSaveRun(run);
}

function resolvePendingReviewsForRun(runId: string, comment = 'Run terminated by user'): void {
  for (const [key, resolver] of reviewResolvers) {
    if (!key.startsWith(`${runId}:`)) continue;
    try {
      resolver({ action: 'approve', comment });
    } catch {
      // Ignore resolver errors during forced shutdown.
    }
    reviewResolvers.delete(key);
    reviewModes.delete(key);
  }
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

function markPendingTasksAsSkipped(run: RunRecord): void {
  const nowIso = new Date().toISOString();
  for (const task of run.tasks) {
    if (task.status !== 'pending') continue;
    task.status = 'error';
    task.error = 'Skipped due to previous task failure';
    task.finishedAt = nowIso;
  }
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

// POST /api/models/fetch — fetch available models from base URL (OpenAI/Anthropic compatible)
app.post('/api/models/fetch', async (req, res) => {
  try {
    const { baseURL, apiKey, providerType } = req.body as { baseURL?: string; apiKey?: string; providerType?: string };
    if (!baseURL || typeof baseURL !== 'string' || !baseURL.trim()) {
      res.status(400).json({ error: 'baseURL is required' });
      return;
    }

    const trimmedBaseURL = baseURL.trim();
    const trimmedApiKey = apiKey?.trim() || '';

    if (providerType === 'claude') {
      const client = new Anthropic({
        apiKey: trimmedApiKey || 'no-key',
        baseURL: trimmedBaseURL,
      });
      const list = await client.models.list();
      const models = list.data.map((m) => m.id);
      res.json({ models });
    } else {
      // standard openai and openai-compat
      const client = new OpenAI({
        apiKey: trimmedApiKey || 'no-key',
        baseURL: trimmedBaseURL,
      });
      const list = await client.models.list();
      const models = list.data.map((m) => m.id);
      res.json({ models });
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
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
        let run = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf-8')) as RunRecord;
        const active = activeRuns.get(run.id);
        if (active) {
          run = active;
        }
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
          continuedFromRunId: run.continuedFromRunId,
          continuationTaskId: (run as any).continuationTaskId,
          continuationTaskName: (run as any).continuationTaskName,
          continuationType: (run as any).continuationType,
          continuationRound: (run as any).continuationRound,
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

// DELETE /api/runs/:id — delete a run record from disk and memory
app.delete('/api/runs/:id', (req, res) => {
  try {
    const { id } = req.params;
    activeRuns.delete(id);
    const filePath = path.join(RUNS_DIR, `${id}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.json({ success: true });
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
    const body = req.body as { taskId?: string; action?: string; comment?: string; targetTaskId?: string; agentId?: string };

    if (!body.taskId || typeof body.taskId !== 'string') {
      res.status(400).json({ error: 'taskId is required' });
      return;
    }
    const key = `${runId}:${body.taskId}`;
    const resolver = reviewResolvers.get(key);
    if (!resolver) {
      // The review may already be resolved by a terminate flow or late UI submission.
      // Treat terminal run states as idempotent success instead of surfacing an error.
      const activeRun = activeRuns.get(runId);
      let persistedRun: RunRecord | null = null;
      if (!activeRun) {
        const filePath = path.join(RUNS_DIR, `${runId}.json`);
        if (fs.existsSync(filePath)) {
          try {
            persistedRun = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RunRecord;
          } catch {
            persistedRun = null;
          }
        }
      }
      const terminalStatus = (activeRun ?? persistedRun)?.status;
      if (terminalStatus === 'terminated' || terminalStatus === 'done' || terminalStatus === 'error') {
        res.json({ success: true, mode: 'noop' });
        return;
      }
      res.status(404).json({ error: `No pending review for run "${runId}" task "${body.taskId}"` });
      return;
    }

    const mode = reviewModes.get(key) ?? 'review';
    const selectedAgentId = typeof body.agentId === 'string' && body.agentId.trim() ? body.agentId.trim() : undefined;
    if (selectedAgentId) {
      const cfg = readConfig();
      const targetAgent = cfg.agents[selectedAgentId];
      if (!targetAgent || !targetAgent.role) {
        res.status(400).json({ error: `Agent "${selectedAgentId}" must be a configured role agent` });
        return;
      }
    }
    let review: ReviewAction;
    if (mode === 'interrupt') {
      const comment = body.comment?.trim() ?? '';
      if (!comment) {
        res.status(400).json({ error: 'comment is required to resume an interrupted task' });
        return;
      }
      review = {
        // Interrupted tasks always continue via the revise path for the same task.
        action: 'revise',
        comment,
        targetTaskId: body.taskId,
        agentId: selectedAgentId,
      };
    } else {
      if (body.action !== 'approve' && body.action !== 'revise') {
        res.status(400).json({ error: 'action must be "approve" or "revise"' });
        return;
      }
      if (body.action === 'revise' && (!body.comment || !body.comment.trim())) {
        res.status(400).json({ error: 'comment is required when action is "revise"' });
        return;
      }
      review = {
        action: body.action,
        comment: body.comment ?? '',
        targetTaskId: body.targetTaskId,
        agentId: selectedAgentId,
      };
    }
    resolver(review);
    reviewResolvers.delete(key);
    reviewModes.delete(key);
    res.json({ success: true, mode });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/runs/:runId/continue — retry a failed/interrupted/terminated task from a historical run
app.post('/api/runs/:runId/continue', (req, res) => {
  try {
    const { runId } = req.params;
    const body = req.body as { taskId?: string; comment?: string; agentId?: string };
    const taskId = body.taskId?.trim();
    const comment = body.comment?.trim() || 'Re-run';
    const agentId = body.agentId?.trim();

    if (!taskId) {
      res.status(400).json({ error: 'taskId is required' });
      return;
    }

    const liveRun = activeRuns.get(runId);
    const filePath = path.join(RUNS_DIR, `${runId}.json`);
    const sourceRun = liveRun ?? (fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RunRecord : null);
    if (!sourceRun) {
      res.status(404).json({ error: `Run "${runId}" not found` });
      return;
    }
    if (liveRun && (liveRun.status === 'running' || liveRun.status === 'awaiting_review' || liveRun.status === 'interrupted')) {
      res.status(409).json({ error: 'Run is still active. Use review/interrupt flow for live continuation.' });
      return;
    }

    const pf = readPipelineFile();
    const pipelineCfg = pf.pipelines[sourceRun.pipelineId];
    if (!pipelineCfg) {
      res.status(404).json({ error: `Pipeline "${sourceRun.pipelineId}" not found` });
      return;
    }

    const continuationTask = pipelineCfg.tasks.find((t) => t.id === taskId);
    if (!continuationTask) {
      res.status(400).json({ error: `Task "${taskId}" is not part of pipeline "${sourceRun.pipelineId}"` });
      return;
    }
    const sourceTaskMap = new Map(sourceRun.tasks.map((t) => [t.taskId, t]));
    const sourceTask = sourceTaskMap.get(taskId);
    if (!sourceTask) {
      res.status(400).json({ error: `Task "${taskId}" has no execution record in run "${runId}"` });
      return;
    }
    if (sourceTask.status !== 'error' && sourceTask.status !== 'interrupted' && sourceTask.status !== 'terminated') {
      res.status(400).json({ error: `Task "${taskId}" is not retryable (status: ${sourceTask.status})` });
      return;
    }

    const agentsCfg = readConfig();
    if (agentId) {
      const targetAgent = agentsCfg.agents[agentId];
      if (!targetAgent || !targetAgent.role) {
        res.status(400).json({ error: `Agent "${agentId}" must be a configured role agent` });
        return;
      }
    }

    const agentMap = new Map<string, Agent>();
    for (const [agentKey, agentConfig] of Object.entries(agentsCfg.agents)) {
      let resolvedConfig = agentConfig;
      if (agentConfig.baseAgent && !agentConfig.provider) {
        const base = agentsCfg.agents[agentConfig.baseAgent];
        if (!base?.provider) {
          res.status(400).json({ error: `Agent "${agentKey}" references baseAgent "${agentConfig.baseAgent}" which has no provider` });
          return;
        }
        resolvedConfig = { ...agentConfig, provider: base.provider };
      }
      if (!resolvedConfig.provider) {
        res.status(400).json({ error: `Agent "${agentKey}" has no provider configured` });
        return;
      }
      agentMap.set(agentKey, new Agent(agentKey, resolvedConfig as typeof agentConfig & { provider: NonNullable<typeof agentConfig.provider> }));
    }

    const plan: Plan = {
      goal: sourceRun.goal,
      tasks: pipelineCfg.tasks,
      decisions: pipelineCfg.decisions,
    };

    const nowIso = new Date().toISOString();
    const newRunId = generateRunId();

    const continuationRounds: RoundRecord[] = [...(sourceTask.rounds ?? [])];
    continuationRounds.push({
      round: continuationRounds.length + 1,
      output: sourceTask.output ?? '',
      toolEvents: sourceTask.toolEvents,
      finishedAt: nowIso,
      review: {
        action: 'revise',
        comment,
        targetTaskId: taskId,
        ...(agentId ? { agentId } : {}),
        reviewedAt: nowIso,
      },
    });

    const newRun: RunRecord = {
      id: newRunId,
      pipelineId: sourceRun.pipelineId,
      pipelineName: sourceRun.pipelineName,
      goal: sourceRun.goal,
      status: 'running',
      startedAt: nowIso,
      taskCount: plan.tasks.length,
      toolCallCount: 0,
      continuedFromRunId: sourceRun.continuedFromRunId ?? runId,
      continuationTaskId: taskId,
      continuationTaskName: continuationTask.name,
      continuationType: 'continue',
      continuationRound: continuationRounds.length,
      tasks: plan.tasks.map((task) => {
        const previous = sourceTaskMap.get(task.id);
        const defaultAgents = Array.isArray(task.agent) ? task.agent : [task.agent];
        const assignedAgents = task.id === taskId && agentId ? [agentId] : defaultAgents;

        if (task.id !== taskId && previous?.status === 'done') {
          return {
            ...previous,
            agents: assignedAgents,
            input: task.input,
            gitDiff: task.gitDiff,
          };
        }

        return {
          taskId: task.id,
          taskName: task.name,
          agents: assignedAgents,
          status: 'pending',
          input: task.input,
          gitDiff: task.gitDiff,
          ...(task.requiresReview ? { requiresReview: true } : {}),
          ...(task.id === taskId ? { rounds: continuationRounds } : (previous?.rounds ? { rounds: previous.rounds } : {})),
        };
      }),
    };
    newRun.toolCallCount = countToolCalls(newRun.tasks);

    saveRun(newRun);
    activeRuns.set(newRunId, newRun);
    emitToRunSubscribers(newRunId, 'run:started', { runId: newRunId, continuedFromRunId: runId, taskId });

    const initialResults = new Map<string, TaskResult>();
    const initialCompletedTaskIds: string[] = [];
    for (const task of plan.tasks) {
      if (task.id === taskId) continue;
      const previous = sourceTaskMap.get(task.id);
      if (!previous || previous.status !== 'done') continue;
      initialCompletedTaskIds.push(task.id);
      const output = previous.output ?? '';
      initialResults.set(task.id, {
        taskId: task.id,
        outputs: previous.outputs && previous.outputs.length > 0 ? previous.outputs : [output],
        output,
        ...(previous.toolEvents ? { toolEvents: previous.toolEvents } : {}),
      });
    }

    const initialTaskRounds = new Map<string, TaskRound[]>();
    initialTaskRounds.set(taskId, toTaskRoundRecords(continuationRounds));

    const runOptions: RunnerRunOptions = {
      initialResults,
      initialCompletedTaskIds,
      initialTaskRounds,
      taskAgentOverrides: agentId ? { [taskId]: [agentId] } : undefined,
    };

    const taskStartTimes = new Map<string, number>();
    const abortController = new AbortController();
    activeRunAborts.set(newRunId, abortController);

    void (async () => {
      try {
        const runner = new Runner(agentMap, {
          onTaskStart: (startedTaskId, taskName, agents, taskAbortController, fullInput) => {
            const task = newRun.tasks.find((t) => t.taskId === startedTaskId);
            if (task && fullInput) {
              task.input = fullInput;
            }
            const input = fullInput || task?.input;
            emitToRunSubscribers(newRunId, 'task:start', { taskId: startedTaskId, taskName, agents, input });
            if (task) {
              task.status = 'running';
              task.startedAt = new Date().toISOString();
              task.finishedAt = undefined;
              task.durationMs = undefined;
              task.error = undefined;
              task.output = '';
              task.outputs = undefined;
              task.toolEvents = [];
              task.workerStatus = agents.length > 1 ? agents.map(() => 'running') : undefined;
            }
            taskStartTimes.set(startedTaskId, Date.now());
            if (taskAbortController) {
              activeTaskAborts.set(`${newRunId}:${startedTaskId}`, taskAbortController);
            }
            flushAndSaveRun(newRun);
          },
          onTaskProgress: (progressTaskId, workerIndex, event) => {
            emitToRunSubscribers(newRunId, 'task:tool_event', { taskId: progressTaskId, workerIndex, event });
            const task = newRun.tasks.find((t) => t.taskId === progressTaskId);
            if (task) {
              if (!task.toolEvents) task.toolEvents = [];
              while (task.toolEvents.length <= workerIndex) task.toolEvents.push([]);
              task.toolEvents[workerIndex].push(event);
            }
            debouncedSaveRun(newRun);
          },
          onWorkerComplete: (workerTaskId, workerIndex, output, error) => {
            emitToRunSubscribers(newRunId, 'worker:complete', { taskId: workerTaskId, workerIndex, output: output.slice(0, 200), error });
            const task = newRun.tasks.find((t) => t.taskId === workerTaskId);
            if (task) {
              if (!task.workerStatus) task.workerStatus = [];
              while (task.workerStatus.length <= workerIndex) task.workerStatus.push('running');
              task.workerStatus[workerIndex] = error ? 'error' : 'done';
            }
            flushAndSaveRun(newRun);
          },
          onTaskComplete: (completedTaskId, taskName, result) => {
            activeTaskAborts.delete(`${newRunId}:${completedTaskId}`);
            emitToRunSubscribers(newRunId, 'task:complete', { taskId: completedTaskId, taskName, output: result.output, outputs: result.outputs, error: result.error });
            const task = newRun.tasks.find((t) => t.taskId === completedTaskId);
            if (task) {
              const isRunTerminated = newRun.status === 'terminated';
              const isInterrupted = result.error === 'Interrupted by user';
              if (isRunTerminated) {
                task.status = task.status === 'skipped' ? 'skipped' : 'terminated';
              } else {
                task.status = isInterrupted ? 'interrupted' : (result.error ? 'error' : 'done');
              }
              task.finishedAt = new Date().toISOString();
              const started = taskStartTimes.get(completedTaskId);
              if (started) task.durationMs = Date.now() - started;
              task.output = result.output;
              if (result.outputs && result.outputs.length > 1) task.outputs = result.outputs;
              if (task.status === 'terminated') {
                task.error = task.error || 'Terminated by user';
              } else if (task.status === 'skipped') {
                task.error = undefined;
              } else {
                task.error = result.error || undefined;
              }
              if (result.toolEvents) task.toolEvents = result.toolEvents;
              newRun.toolCallCount = countToolCalls(newRun.tasks);
              flushAndSaveRun(newRun);
            }
          },
          onDecisionStart: (decisionId, evaluates) => {
            emitToRunSubscribers(newRunId, 'decision:start', { decisionId, evaluates });
          },
          onDecisionComplete: (decisionId, decision, retrying) => {
            emitToRunSubscribers(newRunId, 'decision:complete', { decisionId, action: decision.action, reason: decision.reason, retrying });
          },
          onReviewRequired: (reviewTaskId, taskName, output, round) => {
            return new Promise<ReviewAction>((resolve) => {
              const key = `${newRunId}:${reviewTaskId}`;
              const task = newRun.tasks.find((t) => t.taskId === reviewTaskId);
              const mode: PauseMode = task?.error === 'Interrupted by user' ? 'interrupt' : 'review';
              reviewResolvers.set(key, resolve);
              reviewModes.set(key, mode);
              newRun.status = mode === 'interrupt' ? 'interrupted' : 'awaiting_review';
              if (task) {
                task.status = mode === 'interrupt' ? 'interrupted' : 'awaiting_review';
                task.currentRound = round;
              }
              flushAndSaveRun(newRun);
              emitToRunSubscribers(newRunId, 'review:pending', { taskId: reviewTaskId, taskName, output, round, mode });
            });
          },
          onReviewSubmitted: (reviewTaskId, action, round) => {
            if (abortController.signal.aborted && (newRun.status === 'error' || newRun.status === 'terminated')) {
              return;
            }
            const task = newRun.tasks.find((t) => t.taskId === reviewTaskId);
            const mode: PauseMode = task?.status === 'interrupted' ? 'interrupt' : 'review';
            newRun.status = 'running';
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
                  agentId: action.agentId,
                  reviewedAt: new Date().toISOString(),
                },
              });
              if (mode === 'interrupt') {
                task.status = 'running';
                task.error = undefined;
              } else if (action.action === 'approve') {
                task.status = 'done';
              } else {
                task.status = 'pending';
              }
            }
            flushAndSaveRun(newRun);
            emitToRunSubscribers(newRunId, 'review:submitted', { taskId: reviewTaskId, action: action.action, comment: action.comment, targetTaskId: action.targetTaskId, agentId: action.agentId, round, mode });
          },
          onTaskRevision: (revisionTaskId, round) => {
            const task = newRun.tasks.find((t) => t.taskId === revisionTaskId);
            if (task) {
              task.status = 'running';
              task.currentRound = round;
            }
            flushAndSaveRun(newRun);
            emitToRunSubscribers(newRunId, 'task:revision', { taskId: revisionTaskId, round });
          },
          onTaskRollback: (fromTaskId, toTaskId, reason) => {
            flushAndSaveRun(newRun);
            emitToRunSubscribers(newRunId, 'task:rollback', { fromTaskId, toTaskId, reason });
          },
        }, false, pipelineCfg.workspace);

        const results = await runner.runWithOptions(plan, abortController.signal, runOptions);
        const isTerminated = newRun.status === 'terminated';
        const hasTaskErrors = newRun.tasks.some((t) => t.status === 'error');
        if (!isTerminated && hasTaskErrors) {
          markPendingTasksAsSkipped(newRun);
        }
        newRun.status = isTerminated ? 'terminated' : (hasTaskErrors ? 'error' : 'done');
        newRun.finishedAt = new Date().toISOString();
        newRun.durationMs = Date.now() - new Date(nowIso).getTime();
        newRun.toolCallCount = countToolCalls(newRun.tasks);
        flushAndSaveRun(newRun);

        if (isTerminated) {
          emitToRunSubscribers(newRunId, 'error', { message: 'Run terminated by user' });
        } else if (hasTaskErrors) {
          emitToRunSubscribers(newRunId, 'error', { message: 'Run terminated with errors' });
        } else {
          const summary: Record<string, { output: string; error?: string }> = {};
          for (const [key, result] of results) {
            if (!key.startsWith('__decision_')) {
              summary[key] = { output: result.output, ...(result.error ? { error: result.error } : {}) };
            }
          }
          emitToRunSubscribers(newRunId, 'complete', { taskCount: plan.tasks.length, results: summary, runId: newRunId });
        }
      } catch (err) {
        emitToRunSubscribers(newRunId, 'error', { message: (err as Error).message });
        if (newRun.status === 'running' || newRun.status === 'awaiting_review' || newRun.status === 'interrupted') {
          newRun.status = 'error';
          newRun.finishedAt = new Date().toISOString();
          newRun.durationMs = Date.now() - new Date(newRun.startedAt).getTime();
          flushAndSaveRun(newRun);
        }
      } finally {
        activeRunAborts.delete(newRunId);
        activeRuns.delete(newRunId);
        for (const key of reviewResolvers.keys()) {
          if (key.startsWith(`${newRunId}:`)) reviewResolvers.delete(key);
        }
        for (const key of reviewModes.keys()) {
          if (key.startsWith(`${newRunId}:`)) reviewModes.delete(key);
        }
        for (const key of activeTaskAborts.keys()) {
          if (key.startsWith(`${newRunId}:`)) activeTaskAborts.delete(key);
        }
        const subs = runSubscribers.get(newRunId);
        if (subs) {
          for (const sub of subs) { try { sub.end(); } catch {} }
          runSubscribers.delete(newRunId);
        }
      }
    })();

    res.json({ success: true, runId: newRunId, continuedFromRunId: runId, taskId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/runs/:runId/branch — branch a successful task from a historical run
app.post('/api/runs/:runId/branch', (req, res) => {
  try {
    const { runId } = req.params;
    const body = req.body as { taskId?: string; comment?: string; agentId?: string };
    const taskId = body.taskId?.trim();
    const comment = body.comment?.trim() || '';
    const agentId = body.agentId?.trim();

    if (!taskId) {
      res.status(400).json({ error: 'taskId is required' });
      return;
    }

    const liveRun = activeRuns.get(runId);
    const filePath = path.join(RUNS_DIR, `${runId}.json`);
    const sourceRun = liveRun ?? (fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RunRecord : null);
    if (!sourceRun) {
      res.status(404).json({ error: `Run "${runId}" not found` });
      return;
    }
    if (liveRun && (liveRun.status === 'running' || liveRun.status === 'awaiting_review' || liveRun.status === 'interrupted')) {
      res.status(409).json({ error: 'Run is still active. Use review/interrupt flow for live continuation.' });
      return;
    }

    const pf = readPipelineFile();
    const pipelineCfg = pf.pipelines[sourceRun.pipelineId];
    if (!pipelineCfg) {
      res.status(404).json({ error: `Pipeline "${sourceRun.pipelineId}" not found` });
      return;
    }

    const continuationTask = pipelineCfg.tasks.find((t) => t.id === taskId);
    if (!continuationTask) {
      res.status(400).json({ error: `Task "${taskId}" is not part of pipeline "${sourceRun.pipelineId}"` });
      return;
    }
    const sourceTaskMap = new Map(sourceRun.tasks.map((t) => [t.taskId, t]));
    const sourceTask = sourceTaskMap.get(taskId);
    if (!sourceTask) {
      res.status(400).json({ error: `Task "${taskId}" has no execution record in run "${runId}"` });
      return;
    }
    if (sourceTask.status !== 'done') {
      res.status(400).json({ error: `Task "${taskId}" must be successfully completed to branch (current status: ${sourceTask.status})` });
      return;
    }

    const agentsCfg = readConfig();
    if (agentId) {
      const targetAgent = agentsCfg.agents[agentId];
      if (!targetAgent || !targetAgent.role) {
        res.status(400).json({ error: `Agent "${agentId}" must be a configured role agent` });
        return;
      }
    }

    const agentMap = new Map<string, Agent>();
    for (const [agentKey, agentConfig] of Object.entries(agentsCfg.agents)) {
      let resolvedConfig = agentConfig;
      if (agentConfig.baseAgent && !agentConfig.provider) {
        const base = agentsCfg.agents[agentConfig.baseAgent];
        if (!base?.provider) {
          res.status(400).json({ error: `Agent "${agentKey}" references baseAgent "${agentConfig.baseAgent}" which has no provider` });
          return;
        }
        resolvedConfig = { ...agentConfig, provider: base.provider };
      }
      if (!resolvedConfig.provider) {
        res.status(400).json({ error: `Agent "${agentKey}" has no provider configured` });
        return;
      }
      agentMap.set(agentKey, new Agent(agentKey, resolvedConfig as typeof agentConfig & { provider: NonNullable<typeof agentConfig.provider> }));
    }

    const plan: Plan = {
      goal: sourceRun.goal,
      tasks: pipelineCfg.tasks,
      decisions: pipelineCfg.decisions,
    };

    // Calculate direct and indirect downstream tasks of the branched taskId
    const downstreamTaskIds = new Set<string>();
    const queue = [taskId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const t of pipelineCfg.tasks) {
        if (t.dependsOn.includes(current) && !downstreamTaskIds.has(t.id)) {
          downstreamTaskIds.add(t.id);
          queue.push(t.id);
        }
      }
    }

    const nowIso = new Date().toISOString();
    const newRunId = generateRunId();

    const continuationRounds: RoundRecord[] = [...(sourceTask.rounds ?? [])];
    if (comment) {
      continuationRounds.push({
        round: continuationRounds.length + 1,
        output: sourceTask.output ?? '',
        toolEvents: sourceTask.toolEvents,
        finishedAt: nowIso,
        review: {
          action: 'revise',
          comment,
          targetTaskId: taskId,
          ...(agentId ? { agentId } : {}),
          reviewedAt: nowIso,
        },
      });
    }

    const newRun: RunRecord = {
      id: newRunId,
      pipelineId: sourceRun.pipelineId,
      pipelineName: sourceRun.pipelineName,
      goal: sourceRun.goal,
      status: 'running',
      startedAt: nowIso,
      taskCount: plan.tasks.length,
      toolCallCount: 0,
      continuedFromRunId: sourceRun.continuedFromRunId ?? runId,
      continuationTaskId: taskId,
      continuationTaskName: continuationTask.name,
      continuationType: 'branch',
      continuationRound: comment ? continuationRounds.length : 1,
      tasks: plan.tasks.map((task) => {
        const previous = sourceTaskMap.get(task.id);
        const defaultAgents = Array.isArray(task.agent) ? task.agent : [task.agent];
        const assignedAgents = task.id === taskId && agentId ? [agentId] : defaultAgents;

        if (task.id !== taskId && !downstreamTaskIds.has(task.id) && previous?.status === 'done') {
          return {
            ...previous,
            agents: defaultAgents,
            input: task.input,
            gitDiff: task.gitDiff,
          };
        }

        return {
          taskId: task.id,
          taskName: task.name,
          agents: assignedAgents,
          status: 'pending',
          input: task.input,
          gitDiff: task.gitDiff,
          ...(task.requiresReview ? { requiresReview: true } : {}),
          ...(task.id === taskId && comment ? { rounds: continuationRounds } : {}),
        };
      }),
    };
    newRun.toolCallCount = countToolCalls(newRun.tasks);

    saveRun(newRun);
    activeRuns.set(newRunId, newRun);
    emitToRunSubscribers(newRunId, 'run:started', { runId: newRunId, continuedFromRunId: runId, taskId });

    const initialResults = new Map<string, TaskResult>();
    const initialCompletedTaskIds: string[] = [];
    for (const task of plan.tasks) {
      if (task.id === taskId || downstreamTaskIds.has(task.id)) continue;
      const previous = sourceTaskMap.get(task.id);
      if (!previous || previous.status !== 'done') continue;
      initialCompletedTaskIds.push(task.id);
      const output = previous.output ?? '';
      initialResults.set(task.id, {
        taskId: task.id,
        outputs: previous.outputs && previous.outputs.length > 0 ? previous.outputs : [output],
        output,
        ...(previous.toolEvents ? { toolEvents: previous.toolEvents } : {}),
      });
    }

    const initialTaskRounds = new Map<string, TaskRound[]>();
    if (comment) {
      initialTaskRounds.set(taskId, toTaskRoundRecords(continuationRounds));
    }

    const runOptions: RunnerRunOptions = {
      initialResults,
      initialCompletedTaskIds,
      initialTaskRounds,
      taskAgentOverrides: agentId ? { [taskId]: [agentId] } : undefined,
    };

    const taskStartTimes = new Map<string, number>();
    const abortController = new AbortController();
    activeRunAborts.set(newRunId, abortController);

    void (async () => {
      try {
        const runner = new Runner(agentMap, {
          onTaskStart: (startedTaskId, taskName, agents, taskAbortController, fullInput) => {
            const task = newRun.tasks.find((t) => t.taskId === startedTaskId);
            if (task && fullInput) {
              task.input = fullInput;
            }
            const input = fullInput || task?.input;
            emitToRunSubscribers(newRunId, 'task:start', { taskId: startedTaskId, taskName, agents, input });
            if (task) {
              task.status = 'running';
              task.startedAt = new Date().toISOString();
              task.finishedAt = undefined;
              task.durationMs = undefined;
              task.error = undefined;
              task.output = '';
              task.outputs = undefined;
              task.toolEvents = [];
              task.workerStatus = agents.length > 1 ? agents.map(() => 'running') : undefined;
            }
            taskStartTimes.set(startedTaskId, Date.now());
            if (taskAbortController) {
              activeTaskAborts.set(`${newRunId}:${startedTaskId}`, taskAbortController);
            }
            flushAndSaveRun(newRun);
          },
          onTaskProgress: (progressTaskId, workerIndex, event) => {
            emitToRunSubscribers(newRunId, 'task:tool_event', { taskId: progressTaskId, workerIndex, event });
            const task = newRun.tasks.find((t) => t.taskId === progressTaskId);
            if (task) {
              if (!task.toolEvents) task.toolEvents = [];
              while (task.toolEvents.length <= workerIndex) task.toolEvents.push([]);
              task.toolEvents[workerIndex].push(event);
            }
            debouncedSaveRun(newRun);
          },
          onWorkerComplete: (workerTaskId, workerIndex, output, error) => {
            emitToRunSubscribers(newRunId, 'worker:complete', { taskId: workerTaskId, workerIndex, output: output.slice(0, 200), error });
            const task = newRun.tasks.find((t) => t.taskId === workerTaskId);
            if (task) {
              if (!task.workerStatus) task.workerStatus = [];
              while (task.workerStatus.length <= workerIndex) task.workerStatus.push('running');
              task.workerStatus[workerIndex] = error ? 'error' : 'done';
            }
            flushAndSaveRun(newRun);
          },
          onTaskComplete: (completedTaskId, taskName, result) => {
            activeTaskAborts.delete(`${newRunId}:${completedTaskId}`);
            emitToRunSubscribers(newRunId, 'task:complete', { taskId: completedTaskId, taskName, output: result.output, outputs: result.outputs, error: result.error });
            const task = newRun.tasks.find((t) => t.taskId === completedTaskId);
            if (task) {
              const isRunTerminated = newRun.status === 'terminated';
              const isInterrupted = result.error === 'Interrupted by user';
              if (isRunTerminated) {
                task.status = task.status === 'skipped' ? 'skipped' : 'terminated';
              } else {
                task.status = isInterrupted ? 'interrupted' : (result.error ? 'error' : 'done');
              }
              task.finishedAt = new Date().toISOString();
              const started = taskStartTimes.get(completedTaskId);
              if (started) task.durationMs = Date.now() - started;
              task.output = result.output;
              if (result.outputs && result.outputs.length > 1) task.outputs = result.outputs;
              if (task.status === 'terminated') {
                task.error = task.error || 'Terminated by user';
              } else if (task.status === 'skipped') {
                task.error = undefined;
              } else {
                task.error = result.error || undefined;
              }
              if (result.toolEvents) task.toolEvents = result.toolEvents;
              newRun.toolCallCount = countToolCalls(newRun.tasks);
              flushAndSaveRun(newRun);
            }
          },
          onDecisionStart: (decisionId, evaluates) => {
            emitToRunSubscribers(newRunId, 'decision:start', { decisionId, evaluates });
          },
          onDecisionComplete: (decisionId, decision, retrying) => {
            emitToRunSubscribers(newRunId, 'decision:complete', { decisionId, action: decision.action, reason: decision.reason, retrying });
          },
          onReviewRequired: (reviewTaskId, taskName, output, round) => {
            return new Promise<ReviewAction>((resolve) => {
              const key = `${newRunId}:${reviewTaskId}`;
              const task = newRun.tasks.find((t) => t.taskId === reviewTaskId);
              const mode: PauseMode = task?.error === 'Interrupted by user' ? 'interrupt' : 'review';
              reviewResolvers.set(key, resolve);
              reviewModes.set(key, mode);
              newRun.status = mode === 'interrupt' ? 'interrupted' : 'awaiting_review';
              if (task) {
                task.status = mode === 'interrupt' ? 'interrupted' : 'awaiting_review';
                task.currentRound = round;
              }
              flushAndSaveRun(newRun);
              emitToRunSubscribers(newRunId, 'review:pending', { taskId: reviewTaskId, taskName, output, round, mode });
            });
          },
          onReviewSubmitted: (reviewTaskId, action, round) => {
            if (abortController.signal.aborted && (newRun.status === 'error' || newRun.status === 'terminated')) {
              return;
            }
            const task = newRun.tasks.find((t) => t.taskId === reviewTaskId);
            const mode: PauseMode = task?.status === 'interrupted' ? 'interrupt' : 'review';
            newRun.status = 'running';
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
                  agentId: action.agentId,
                  reviewedAt: new Date().toISOString(),
                },
              });
              if (mode === 'interrupt') {
                task.status = 'running';
                task.error = undefined;
              } else if (action.action === 'approve') {
                task.status = 'done';
              } else {
                task.status = 'pending';
              }
            }
            flushAndSaveRun(newRun);
            emitToRunSubscribers(newRunId, 'review:submitted', { taskId: reviewTaskId, action: action.action, comment: action.comment, targetTaskId: action.targetTaskId, agentId: action.agentId, round, mode });
          },
          onTaskRevision: (revisionTaskId, round) => {
            const task = newRun.tasks.find((t) => t.taskId === revisionTaskId);
            if (task) {
              task.status = 'running';
              task.currentRound = round;
            }
            flushAndSaveRun(newRun);
            emitToRunSubscribers(newRunId, 'task:revision', { taskId: revisionTaskId, round });
          },
          onTaskRollback: (fromTaskId, toTaskId, reason) => {
            flushAndSaveRun(newRun);
            emitToRunSubscribers(newRunId, 'task:rollback', { fromTaskId, toTaskId, reason });
          },
        }, false, pipelineCfg.workspace);

        const results = await runner.runWithOptions(plan, abortController.signal, runOptions);
        const isTerminated = newRun.status === 'terminated';
        const hasTaskErrors = newRun.tasks.some((t) => t.status === 'error');
        if (!isTerminated && hasTaskErrors) {
          markPendingTasksAsSkipped(newRun);
        }
        newRun.status = isTerminated ? 'terminated' : (hasTaskErrors ? 'error' : 'done');
        newRun.finishedAt = new Date().toISOString();
        newRun.durationMs = Date.now() - new Date(nowIso).getTime();
        newRun.toolCallCount = countToolCalls(newRun.tasks);
        flushAndSaveRun(newRun);

        if (isTerminated) {
          emitToRunSubscribers(newRunId, 'error', { message: 'Run terminated by user' });
        } else if (hasTaskErrors) {
          emitToRunSubscribers(newRunId, 'error', { message: 'Run terminated with errors' });
        } else {
          const summary: Record<string, { output: string; error?: string }> = {};
          for (const [key, result] of results) {
            if (!key.startsWith('__decision_')) {
              summary[key] = { output: result.output, ...(result.error ? { error: result.error } : {}) };
            }
          }
          emitToRunSubscribers(newRunId, 'complete', { taskCount: plan.tasks.length, results: summary, runId: newRunId });
        }
      } catch (err) {
        emitToRunSubscribers(newRunId, 'error', { message: (err as Error).message });
        if (newRun.status === 'running' || newRun.status === 'awaiting_review' || newRun.status === 'interrupted') {
          newRun.status = 'error';
          newRun.finishedAt = new Date().toISOString();
          newRun.durationMs = Date.now() - new Date(newRun.startedAt).getTime();
          flushAndSaveRun(newRun);
        }
      } finally {
        activeRunAborts.delete(newRunId);
        activeRuns.delete(newRunId);
        for (const key of reviewResolvers.keys()) {
          if (key.startsWith(`${newRunId}:`)) reviewResolvers.delete(key);
        }
        for (const key of reviewModes.keys()) {
          if (key.startsWith(`${newRunId}:`)) reviewModes.delete(key);
        }
        for (const key of activeTaskAborts.keys()) {
          if (key.startsWith(`${newRunId}:`)) activeTaskAborts.delete(key);
        }
        const subs = runSubscribers.get(newRunId);
        if (subs) {
          for (const sub of subs) { try { sub.end(); } catch {} }
          runSubscribers.delete(newRunId);
        }
      }
    })();

    res.json({ success: true, runId: newRunId, continuedFromRunId: runId, taskId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/runs/:runId/tasks/:taskId/interrupt — terminate the entire live run
app.post('/api/runs/:runId/tasks/:taskId/interrupt', (req, res) => {
  try {
    const { runId } = req.params;
    const activeRun = activeRuns.get(runId);
    const controller = activeRunAborts.get(runId);
    if (!activeRun) {
      const filePath = path.join(RUNS_DIR, `${runId}.json`);
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: `Run "${runId}" not found` });
        return;
      }
      const persistedRun = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RunRecord;
      if (persistedRun.status === 'terminated' || persistedRun.status === 'done' || persistedRun.status === 'error') {
        res.json({ success: true, terminated: persistedRun.status === 'terminated', alreadyFinished: true, status: persistedRun.status });
        return;
      }
      res.status(404).json({ error: `Run "${runId}" is not currently active or cannot be terminated` });
      return;
    }
    if (activeRun.status !== 'running' && activeRun.status !== 'awaiting_review' && activeRun.status !== 'interrupted') {
      res.json({ success: true, terminated: activeRun.status === 'terminated', alreadyFinished: true, status: activeRun.status });
      return;
    }
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    for (const [key, taskAbortController] of activeTaskAborts) {
      if (key.startsWith(`${runId}:`)) {
        taskAbortController.abort();
      }
    }
    markRunAsTerminated(runId);
    resolvePendingReviewsForRun(runId, 'Run terminated by user');
    emitToRunSubscribers(runId, 'error', { message: 'Run terminated by user' });
    res.json({ success: true, terminated: true });
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
    if (!res.destroyed && !res.writableEnded) {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Ignore write failures to closed client sockets
      }
    }
  };

  let run: RunRecord | null = null;
  let aborted = false;
  let pipelineFinished = false;
  const abortController = new AbortController();

  const doAbort = () => {
    // Guard: don't abort if pipeline already completed normally
    if (pipelineFinished) return;
    if (!aborted && run && (run.status === 'running' || run.status === 'awaiting_review' || run.status === 'interrupted')) {
      aborted = true;
      abortController.abort();
      markRunAsTerminated(run.id, 'Interrupted');
      resolvePendingReviewsForRun(run.id, 'Run interrupted');
      emitToRunSubscribers(run.id, 'error', { message: 'Run interrupted' });
    }
  };

  // When the client disconnects (e.g. page refresh or closed tab),
  // we do NOT abort the running pipeline. The execution will continue in the background
  // and the client can seamlessly reconnect to its stream when the page loads.
  res.on('close', () => {
    // No-op: Do not abort the background run.
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
        input: t.input,
        gitDiff: t.gitDiff,
        ...(t.requiresReview ? { requiresReview: true } : {}),
      })),
    };
    saveRun(run);
    activeRuns.set(runId, run);
    activeRunAborts.set(runId, abortController);

    emit('run:started', { runId });
    emitToRunSubscribers(runId, 'run:started', { runId });

    const taskStartTimes = new Map<string, number>();

    const runner = new Runner(agentMap, {
      onTaskStart: (taskId, taskName, agents, abortController, fullInput) => {
        const task = run!.tasks.find((t) => t.taskId === taskId);
        if (task && fullInput) {
          task.input = fullInput;
        }
        const input = fullInput || task?.input;
        emit('task:start', { taskId, taskName, agents, input });
        emitToRunSubscribers(runId, 'task:start', { taskId, taskName, agents, input });
        if (task) {
          task.status = 'running';
          task.startedAt = new Date().toISOString();
          if (agents.length > 1) task.workerStatus = agents.map(() => 'running');
        }
        taskStartTimes.set(taskId, Date.now());
        if (abortController) {
          activeTaskAborts.set(`${runId}:${taskId}`, abortController);
        }
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
        activeTaskAborts.delete(`${runId}:${taskId}`);
        emit('task:complete', { taskId, taskName, output: result.output, outputs: result.outputs, error: result.error });
        emitToRunSubscribers(runId, 'task:complete', { taskId, taskName, output: result.output, outputs: result.outputs, error: result.error });
        const task = run!.tasks.find((t) => t.taskId === taskId);
        if (task) {
          const isRunTerminated = run!.status === 'terminated';
          const isInterrupted = result.error === 'Interrupted by user';
          if (isRunTerminated) {
            task.status = task.status === 'skipped' ? 'skipped' : 'terminated';
          } else {
            task.status = isInterrupted ? 'interrupted' : (result.error ? 'error' : 'done');
          }
          task.finishedAt = new Date().toISOString();
          const started = taskStartTimes.get(taskId);
          if (started) task.durationMs = Date.now() - started;
          task.output = result.output;
          if (result.outputs && result.outputs.length > 1) task.outputs = result.outputs;
          if (task.status === 'terminated') {
            task.error = task.error || 'Terminated by user';
          } else if (task.status === 'skipped') {
            task.error = undefined;
          } else {
            task.error = result.error || undefined;
          }
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
          const task = run!.tasks.find((t) => t.taskId === taskId);
          const mode: PauseMode = task?.error === 'Interrupted by user' ? 'interrupt' : 'review';
          reviewResolvers.set(key, resolve);
          reviewModes.set(key, mode);
          // Update run status
          run!.status = mode === 'interrupt' ? 'interrupted' : 'awaiting_review';
          if (task) {
            task.status = mode === 'interrupt' ? 'interrupted' : 'awaiting_review';
            task.currentRound = round;
          }
          flushAndSaveRun(run!);
          emit('review:pending', { taskId, taskName, output, round, mode });
          emitToRunSubscribers(runId, 'review:pending', { taskId, taskName, output, round, mode });
        });
      },
      onReviewSubmitted: (taskId, action, round) => {
        if (abortController.signal.aborted && (run!.status === 'error' || run!.status === 'terminated')) {
          return;
        }
        const task = run!.tasks.find((t) => t.taskId === taskId);
        const mode: PauseMode = task?.status === 'interrupted' ? 'interrupt' : 'review';
        run!.status = 'running';
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
                agentId: action.agentId,
                reviewedAt: new Date().toISOString(),
              },
            });
          if (mode === 'interrupt') {
            task.status = 'running';
            task.error = undefined;
          } else if (action.action === 'approve') {
            task.status = 'done';
          } else {
            task.status = 'pending';
          }
        }
        flushAndSaveRun(run!);
        emit('review:submitted', { taskId, action: action.action, comment: action.comment, targetTaskId: action.targetTaskId, agentId: action.agentId, round, mode });
        emitToRunSubscribers(runId, 'review:submitted', { taskId, action: action.action, comment: action.comment, targetTaskId: action.targetTaskId, agentId: action.agentId, round, mode });
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
      const isTerminated = run.status === 'terminated';
      const hasTaskErrors = run.tasks.some(t => t.status === 'error');
      if (!isTerminated && hasTaskErrors) {
        markPendingTasksAsSkipped(run);
      }
      run.status = isTerminated ? 'terminated' : (hasTaskErrors ? 'error' : 'done');
      run.finishedAt = new Date().toISOString();
      run.durationMs = Date.now() - new Date(runStartedAt).getTime();
      run.toolCallCount = countToolCalls(run.tasks);
      flushAndSaveRun(run);

      if (isTerminated) {
        emit('error', { message: 'Run terminated by user' });
        emitToRunSubscribers(runId, 'error', { message: 'Run terminated by user' });
      } else if (hasTaskErrors) {
        emit('error', { message: 'Run terminated with errors' });
        emitToRunSubscribers(runId, 'error', { message: 'Run terminated with errors' });
      } else {
        const summary: Record<string, { output: string; error?: string }> = {};
        for (const [key, r] of results) {
          if (!key.startsWith('__decision_')) {
            summary[key] = { output: r.output, ...(r.error ? { error: r.error } : {}) };
          }
        }
        emit('complete', { taskCount: plan.tasks.length, results: summary, runId });
        emitToRunSubscribers(runId, 'complete', { taskCount: plan.tasks.length, results: summary, runId });
      }
    }
  } catch (err) {
    if (!aborted) {
      emit('error', { message: (err as Error).message });
      if (run) emitToRunSubscribers(run.id, 'error', { message: (err as Error).message });
      if (run && (run.status === 'running' || run.status === 'awaiting_review' || run.status === 'interrupted')) {
        run.status = 'error';
        run.finishedAt = new Date().toISOString();
        run.durationMs = Date.now() - new Date(run.startedAt).getTime();
        flushAndSaveRun(run);
      }
    }
  } finally {
    process.off('SIGTERM', sigtermHandler);
    if (run) {
      activeRunAborts.delete(run.id);
      activeRuns.delete(run.id);
      // Clean up any pending review resolvers for this run
      for (const key of reviewResolvers.keys()) {
        if (key.startsWith(`${run.id}:`)) reviewResolvers.delete(key);
      }
      for (const key of reviewModes.keys()) {
        if (key.startsWith(`${run.id}:`)) reviewModes.delete(key);
      }
      // Clean up any active task abort controllers for this run
      for (const key of activeTaskAborts.keys()) {
        if (key.startsWith(`${run.id}:`)) activeTaskAborts.delete(key);
      }
      // Close all run subscribers
      const subs = runSubscribers.get(run.id);
      if (subs) {
        for (const sub of subs) { try { sub.end(); } catch {} }
        runSubscribers.delete(run.id);
      }
    }
  }

  if (!res.destroyed && !res.writableEnded) {
    res.end();
  }
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
          if (data.status === 'running' || data.status === 'awaiting_review' || data.status === 'interrupted') {
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
