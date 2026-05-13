import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Read ~/.cortex/config.json at Vite startup time (same defaults as appConfig.ts)
function readCortexConfig() {
  const defaults = { server_url: 'http://localhost:47821', app_url: 'http://localhost:47820' };
  try {
    const file = path.join(os.homedir(), '.cortex', 'config.json');
    if (fs.existsSync(file)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf-8')) };
    }
  } catch { /* ignore */ }
  return defaults;
}

const cfg = readCortexConfig();
const appPort   = parseInt(new URL(cfg.app_url).port,    10) || 47820;
const serverUrl = cfg.server_url;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../web-dist',
    emptyOutDir: true,
  },
  server: {
    port: appPort,
    proxy: {
      '/api': {
        target: serverUrl,
        changeOrigin: true,
        // Required for SSE streaming: prevent proxy from buffering responses
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            const ct = proxyRes.headers['content-type'] || '';
            if (ct.includes('text/event-stream')) {
              // Disable any response buffering for SSE
              proxyRes.headers['x-accel-buffering'] = 'no';
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
});
