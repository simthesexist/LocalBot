// Playwright Electron smoke test.
//
// Boots the actual built Electron app, points it at an in-process fake M3
// server, completes the first-launch API-key modal, types a message, and
// asserts at least one streamed token is visible in the chat pane.

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

test('first-launch chat streams a token from the fake M3', async () => {
  test.skip(!process.env.LOCALBOT_SMOKE_OK, 'skipping headed Electron smoke — no display');
  expect(fakeM3, 'fake M3 server must be initialized').toBeTruthy();
  const m3 = fakeM3!;

  userDataDir = tempUserData('localbot-pw-smoke-');

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

    // First-launch modal must be visible.
    const modal = window.locator('[data-testid="key-modal"]');
    await expect(modal).toBeVisible({ timeout: 15_000 });

    // Type a fake key and probe.
    const keyInput = window.locator('[data-testid="key-input"]');
    await keyInput.fill('sk-test-1234');
    await window.locator('[data-testid="probe-button"]').click();

    // Probe success indicator: "OK" text.
    await expect(window.locator('.modal-probe-ok')).toHaveText('OK', { timeout: 15_000 });

    // Save the key — modal unmounts.
    await window.locator('[data-testid="save-button"]').click();
    await expect(modal).toBeHidden({ timeout: 10_000 });

    // Type a message and send.
    const composer = window.locator('[data-testid="composer-input"]');
    await composer.fill('say hello');
    await window.locator('[data-testid="send-button"]').click();

    // Wait for an assistant bubble containing "Hello" from the fake server.
    const assistantBubble = window
      .locator('[data-role="assistant"]')
      .filter({ hasText: 'Hello' })
      .first();
    await assistantBubble.waitFor({ state: 'visible', timeout: 30_000 });

    // Confirm the fake M3 actually saw a /v1/messages POST.
    expect(m3.getRequestCount(), 'fake M3 should have received at least one /v1/messages POST').toBeGreaterThan(0);
  } finally {
    await electronApp.close();
  }
});
