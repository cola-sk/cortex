import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { ConfigFileSchema, type ConfigFile } from './schema.js';

export function loadConfig(configPath: string): ConfigFile {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, 'utf-8');
  const parsed = yaml.load(raw);
  const result = ConfigFileSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config file:\n${issues}`);
  }

  return result.data;
}
