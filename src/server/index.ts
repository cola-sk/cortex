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
import type { Plan } from '../core/plan.js';

const app = express();
const appConfig = readAppConfig();
const PORT = Number(process.env.PORT ?? portFromUrl(appConfig.server_url, portFromUrl(DEFAULT_CONFIG.server_url, 47821)));
const CONFIG_PATH = path.resolve(process.env.AGENTS_CONFIG ?? 'agents.yaml');
const PIPELINES_PATH = path.resolve(process.env.PIPELINES_CONFIG ?? 'pipelines.yaml');

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

    const runner = new Runner(agentMap, {
      onTaskStart: (taskId, taskName, agents) => emit('task:start', { taskId, taskName, agents }),
      onTaskComplete: (taskId, taskName, result) =>
        emit('task:complete', { taskId, taskName, output: result.output, error: result.error }),
      onDecisionStart: (decisionId, evaluates) => emit('decision:start', { decisionId, evaluates }),
      onDecisionComplete: (decisionId, decision, retrying) =>
        emit('decision:complete', { decisionId, action: decision.action, reason: decision.reason, retrying }),
    });

    const results = await runner.run(plan);

    const summary: Record<string, { output: string; error?: string }> = {};
    for (const [key, r] of results) {
      if (!key.startsWith('__decision_')) {
        summary[key] = { output: r.output, ...(r.error ? { error: r.error } : {}) };
      }
    }
    emit('complete', { taskCount: plan.tasks.length, results: summary });
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
