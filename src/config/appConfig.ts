import fs from 'fs';
import os from 'os';
import path from 'path';

export interface AppConfig {
  server_url: string;
  app_url: string;
}

export const VALID_KEYS: (keyof AppConfig)[] = ['server_url', 'app_url'];

export const DEFAULT_CONFIG: AppConfig = {
  server_url: 'http://localhost:47821',
  app_url:    'http://localhost:47820',
};

const CONFIG_DIR  = path.join(os.homedir(), '.cortex');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function readAppConfig(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch {
    // ignore — fall back to defaults
  }
  return { ...DEFAULT_CONFIG };
}

export function writeAppConfig(config: AppConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/** Parse the port number out of a full URL string. */
export function portFromUrl(url: string, fallback: number): number {
  try {
    const p = parseInt(new URL(url).port, 10);
    return Number.isFinite(p) && p > 0 ? p : fallback;
  } catch {
    return fallback;
  }
}
