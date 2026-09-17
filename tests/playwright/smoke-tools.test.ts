// Playwright smoke for the Phase 2 Wave 3 tool-use pipeline.
//
// Boots the actual built Electron app against a fake M3 server, drives the
// key modal + composer, sends a message that triggers a tool_use, and asserts
// that:
//   1. a `[data-block-kind="tool_use"][data-tool-name="read_file"]` block lands,
//   2. a `[data-block-kind="tool_result"]` block lands with the workspace
//      file's contents visible,
//   3. the audit JSONL line under <userData>/audit contains a `read_file`
//      entry with `tool_use_id` and `outcome:'ok'`.
//
// The test is gated by `LOCALBOT_SMOKE_OK=1` — same opt-in shape as the
// Phase 1 `smoke.test.ts`. Without the env var, the test skips cleanly so
// CI runs don't try to launch a headed Electron window.

import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeM3Server, FakeM3Server } from './fake-m3-server';

const HEADED_OK = process.env.LOCALBOT_SMOKE_OK === '1';
test.skip(!HEADED_OK, 'LOCALBOT_SMOKE_OK=1 not set — smoke is opt-in on a desktop session');

let fakeM3: FakeM3Server | null = null;

test.beforeAll(async () => {
  fakeM3 = await createFakeM3Server();
  // Force every chat request to emit a tool_use. The smoke test sends a
  // single message and expects exactly one tool_use → tool_result round trip.
  (fakeM3 as any).__forceToolUse({
    name: 'read_file',
    input: { path: 'hello.txt' },
    followupText: 'Reading hello.txt now.',
  });
});

test.afterAll(async () => {
  if (fakeM3) await fakeM3.close();
});

test('LLM tool_use → daemon read_file → renderer shows tool_use + tool_result blocks', async () => {
  expect(fakeM3, 'fake M3 server must be initialized').toBeTruthy();
  const m3 = fakeM3!;

  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-smoke-tools-'));
  const userDataDir = path.join(userDataRoot, 'Localbot');
  const workspaceRoot = path.join(userDataRoot, 'workspace');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'hello.txt'), 'Hello from the workspace\n');

  const electronApp = await electron.launch({
    args: [path.join(process.cwd(), 'dist', 'main', 'index.js')],
    cwd: process.cwd(),
    env: {
      ...process.env,
      M3_API_BASE: m3.url,
      M3_MODEL: 'MiniMax/M3',
      LOCALBOT_USER_DATA_DIR: userDataDir,
      LOCALBOT_WORKSPACE_ROOT: workspaceRoot,
      ELECTRON_DISABLE_SANDBOX: '1',
    },
    timeout: 30_000,
  });

  try {
    const win = await electronApp.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // First-launch key modal flow (mirrors smoke.test.ts).
    const keyInput = win.locator('[data-testid="key-input"]');
    if (await keyInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await keyInput.fill('sk-test-fake-key');
      await win.locator('[data-testid="probe-button"]').click();
      // Wait for the OK marker.
      await expect(win.locator('.modal-probe-ok')).toHaveText('OK', { timeout: 15_000 });
      await win.locator('[data-testid="save-button"]').click();
      await expect(win.locator('[data-testid="key-modal"]')).toBeHidden({ timeout: 10_000 });
    }

    // Send a message that triggers the forced tool_use response.
    await win.locator('[data-testid="composer-input"]').fill('please read hello.txt');
    await win.locator('[data-testid="send-button"]').click();

    // The tool_use block lands first.
    await win.waitForSelector(
      '[data-block-kind="tool_use"][data-tool-name="read_file"]',
      { timeout: 20_000 },
    );

    // The tool_result block lands after the daemon returns.
    await win.waitForSelector(
      '[data-block-kind="tool_result"]',
      { timeout: 20_000 },
    );
    const resultText = await win.locator('[data-block-kind="tool_result"]').first().innerText();
    expect(resultText).toContain('Hello from the workspace');

    // Allow the audit stream to flush.
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    await electronApp.close();
  }

  // Audit JSONL assertions.
  const auditDirPath = path.join(userDataDir, 'audit');
  const files = fs.existsSync(auditDirPath)
    ? fs.readdirSync(auditDirPath).filter((f) => f.endsWith('.jsonl'))
    : [];
  expect(files.length, `expected at least one audit jsonl under ${auditDirPath}`).toBeGreaterThan(0);
  const dateFile = files.find((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  expect(dateFile, `expected UTC-day audit file under ${auditDirPath}`).toBeTruthy();

  const lines = fs
    .readFileSync(path.join(auditDirPath, dateFile!), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const readLine = lines.find(
    (l: any) => l.tool === 'read_file' && l.tool_use_id && typeof l.tool_use_id === 'string',
  );
  expect(
    readLine,
    `expected a read_file audit line with tool_use_id\nGot:\n${JSON.stringify(lines, null, 2)}`,
  ).toBeTruthy();
  expect(readLine.outcome).toBe('ok');
  expect(typeof readLine.durationMs).toBe('number');

  // Cleanup tmp user-data root.
  try {
    fs.rmSync(userDataRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
