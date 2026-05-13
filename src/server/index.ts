import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import { ConfigFileSchema, AgentConfigSchema, type ConfigFile } from '../config/schema.js';
import { detectAllTools, detectTool } from '../importers/index.js';
import { readAppConfig, portFromUrl, DEFAULT_CONFIG } from '../config/appConfig.js';

const app = express();
const appConfig = readAppConfig();
const PORT = Number(process.env.PORT ?? portFromUrl(appConfig.server_url, portFromUrl(DEFAULT_CONFIG.server_url, 47821)));
const CONFIG_PATH = path.resolve(process.env.AGENTS_CONFIG ?? 'agents.yaml');

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
  fs.writeFileSync(CONFIG_PATH, yaml.dump(config, { indent: 2, lineWidth: -1 }), 'utf-8');
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
