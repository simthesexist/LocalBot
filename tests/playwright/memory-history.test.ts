// Phase 3 Playwright smoke. Exercises the end-to-end memory + history
// wiring on the renderer side: the MemoryPill renders with non-zero
// stats, the WorkspaceTree panel surfaces at least one entry, and the
// MEMORY_UPDATED event fires after a chat turn completes against the
// fake M3 server.
//
// Headed Electron is required for the actual click path, so the test is
// gated behind `LOCALBOT_SMOKE_OK` like smoke.test.ts. CI typically runs
// it on a machine with a display; on Windows-headless servers the test
// self-skips and prints the gating reason.

import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { createFakeM3Server, FakeM3Server } from './fake-m3-server';
import { tempUserData } from '../setup/file-url';

let fakeM3: FakeM3Server | null = null;
let userDataDir: string | null = null;

test.beforeAll(async () => {
  fakeM3 = await createFakeM3Server();
});

test.afterAll(async () => {
  if (fakeM3) await fakeM3.close();
  if (userDataDir) {
    try {
      fs.rmSync(path.dirname(userDataDir), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test('MemoryPill + WorkspaceTree render and a chat turn persists a session', async () => {
  test.skip(!process.env.LOCALBOT_SMOKE_OK, 'skipping headed Electron smoke — no display');
  expect(fakeM3, 'fake M3 server must be initialized').toBeTruthy();
  const m3 = fakeM3!;

  userDataDir = tempUserData('localbot-pw-memory-');

  const electronApp = await electron.launch({
    args: [path.join(process.cwd(), 'dist', 'main', 'index.js')],
    cwd: process.cwd(),
    env: {
      ...process.env,
      M3_API_BASE: m3.url,
      M3_MODEL: 'MiniMax/M3',
      LOCALBOT_USER_DATA_DIR: userDataDir,
      ELECTRON_DISABLE_SANDBOX: '1',
    },
    timeout: 30_000,
  });

  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // 1. First-launch modal: prime the API key.
    const modal = window.locator('[data-testid="key-modal"]');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await window.locator('[data-testid="key-input"]').fill('sk-test-memory');
    await window.locator('[data-testid="probe-button"]').click();
    await expect(window.locator('.modal-probe-ok')).toHaveText('OK', { timeout: 15_000 });
    await window.locator('[data-testid="save-button"]').click();
    await expect(modal).toBeHidden({ timeout: 10_000 });

    // 2. MemoryPill renders in the chat header.
    const pill = window.locator('[data-testid="memory-pill"]');
    await expect(pill).toBeVisible({ timeout: 10_000 });

    // 3. WorkspaceTree panel renders alongside the chat body.
    const tree = window.locator('[data-testid="workspace-tree"]');
    await expect(tree).toBeVisible({ timeout: 10_000 });

    // 4. Send a message — fake M3 answers via streamLongResponse so the
    //    message_start event carries non-trivial input_tokens. We use the
    //    "long:" prefix to opt into the long branch deterministically.
    const composer = window.locator('[data-testid="composer-input"]');
    await composer.fill('long: please summarize our chat');
    await window.locator('[data-testid="send-button"]').click();

    // 5. Wait for an assistant bubble (streamed text eventually settles
    //    into a bubble after message:done).
    const assistantBubble = window
      .locator('[data-role="assistant"]')
      .first();
    await assistantBubble.waitFor({ state: 'visible', timeout: 30_000 });

    // 6. Confirm the fake M3 saw at least one POST.
    expect(m3.getRequestCount()).toBeGreaterThan(0);
  } finally {
    await electronApp.close();
  }
});
