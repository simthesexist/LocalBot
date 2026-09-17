// Playwright config for Phase 1 smoke tests.
// Drives the actual built Electron app (smoke.test.ts) and the standalone
// tool daemon (daemon.test.ts) against an in-process fake M3 server.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/playwright',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  // No webServer — each test boots its own dependencies.
});
