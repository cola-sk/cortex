import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import { ConfigFileSchema, AgentConfigSchema, type ConfigFile } from '../config/schema.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
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

// SPA fallback
app.get('/{*path}', (_req, res) => {
  const indexPath = path.join(webDist, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not built. Run: npm run web:build');
  }
});

app.listen(PORT, () => {
  console.log(`\nCortex UI  →  http://localhost:${PORT}`);
  console.log(`Config     →  ${CONFIG_PATH}\n`);
});
