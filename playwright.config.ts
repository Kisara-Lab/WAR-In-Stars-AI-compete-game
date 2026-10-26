import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
export default defineConfig({
  testDir: 'tests/browser',
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:8790',
    viewport: { width: 1440, height: 1100 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (existsSync(edge) ? edge : undefined) },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node dist/server/index.js',
    url: 'http://127.0.0.1:8790/api/health',
    env: { PORT: '8790', WORKERS: '2', MATCH_DATA: '.data/browser-matches', SESSION_FILE: '.data/browser-session.json' },
    reuseExistingServer: false,
  },
});
