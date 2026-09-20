// Playwright config for Phase 1 smoke tests.
// Drives the actual built Electron app (smoke.test.ts) and the standalone
// tool daemon (daemon.test.ts) against an in-process fake M3 server.
//
// Phase 4 Wave 3: extends with two projects:
//   - `electron`: headed desktop smoke; gated by LOCALBOT_SMOKE_OK=1
//   - `daemon-smoke`: headless, runs the daemon + fake-m3-server without
//     launching the Electron window. Runs in CI and on dev machines that
//     don't have a display.

import { defineConfig, devices } from '@playwright/test';

const HEADED = process.env.LOCALBOT_SMOKE_OK === '1';

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
    headless: !HEADED,
  },
  projects: [
    // Phase 4 Wave 3: daemon-only smoke that runs without a display. The
    // bot-crud + multi-bot + scheduler-notification tests opt in to this
    // project so CI can prove the architecture without an Electron window.
    // Phase 6 Wave 3 added scheduler-notification.test.ts covering
    // cron happy / error / disabled / delete paths end-to-end.
    // Phase 7 Plan 3 added obsidian-integration.test.ts covering vault.read
    // happy / vault.write inside Agents / vault.write outside Agents refused
    // / vault.search audit minimization.
    // Phase 8 Plan 3 added browser-automation.test.ts covering all 6
    // browser.* tools (navigate / click / type / fill_form / screenshot /
    // evaluate) end-to-end against a tmpfs Node http.createServer fixture
    // + audit minimization assertions for every case (Pitfall 5).
    // Phase 9 Plan 3 added phone-reach.test.ts covering the WS round-trip
    // + cancel + ReachInfoPill + malformed-JSON-drop cases.
    {
      name: 'daemon-smoke',
      testMatch: /.*\.test\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
      },
    },
  ],
});
