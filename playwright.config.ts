import { defineConfig, devices } from '@playwright/test';

// One port per checkout, so parallel lanes never test each other's server. NEBULA_E2E_BUILT=1 serves the production build
// (dist/site, through serve-site.mjs and routes.json's routing) instead of
// the dev server.
const port = Number(process.env.NEBULA_E2E_PORT || 4340);
const built = process.env.NEBULA_E2E_BUILT === '1';
// A deployed copy to test instead of a local server (e2e/app-fixtures.ts).
const remote = process.env.NEBULA_E2E_BASE_URL?.replace(/\/$/, '');

export default defineConfig({
  testDir: 'e2e',
  outputDir: process.env.NEBULA_E2E_OUTPUT || 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: remote || `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // At 1x: Playwright's Linux WebKit keeps every canvas layer in memory at
    // Desktop Safari's 2x, so one page with a canvas took 2-3 GB (Chromium:
    // 0.8 GB) and two pages crashed a 3 GB cap. At 1x two take 2 GB. Visual
    // checks run in Chromium; nothing here depends on pixel density.
    { name: 'webkit', use: { ...devices['Desktop Safari'], deviceScaleFactor: 1 } },
  ],
  webServer: remote ? undefined : {
    command: built ? 'node serve-site.mjs' : `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    env: { PORT: String(port) },
    port,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
