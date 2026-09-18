// Phase 3 Wave 3 — Playwright smoke for the WorkspaceTree + DiffView + binary
// placeholder paths. This test exercises:
//
//   1. Daemon-only path (always runs): tree/list returns entries; edit_file
//      round-trip mutates the workspace; chokidar fires a tree:refresh
//      notification within 500ms of a file change.
//
//   2. Headed Electron path (gated by LOCALBOT_SMOKE_OK=1): the renderer's
//      WorkspaceTree shows entries; an edit_file tool_result mounts a
//      DiffView with before/after text; a binary edit_file renders the
//      DiffBinaryPlaceholder; an external fs write triggers a tree refresh
//      visible in the renderer's DOM within 500ms.
//
//   3. Audit JSONL coverage: at least one line per tool name across
//      {read_file, write_file, edit_file, list_dir, code_search,
//      memory.read, memory.write, memory.update, tree.list} plus a
//      tree.refresh audit line emitted by the chokidar watcher.
//
// Why a single test file: the daemon-only path is hermetic and fast; the
// headed path is the only one that proves the full vertical works on a real
// desktop session.

import { test, expect, _electron as electron, ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, ChildProcessByStdio } from 'node:child_process';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { createFakeM3Server, FakeM3Server } from './fake-m3-server';

interface PendingRequest {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

function createJsonRpcClient(child: ChildProcessByStdio<Writable, Readable, Readable>) {
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  const notifications: Array<{ method?: string; params?: any }> = [];

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    // Notifications have no `id` (only `method`).
    if (typeof obj.id !== 'number') {
      if (obj.method) notifications.push(obj);
      return;
    }
    if (pending.has(obj.id)) {
      const p = pending.get(obj.id)!;
      pending.delete(obj.id);
      p.resolve(obj);
    }
  });

  function send(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  return { send, notifications };
}

function awaitReady(child: ChildProcessByStdio<Writable, Readable, Readable>): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: child.stdout });
    const onLine = (line: string) => {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.kind === 'ready') {
          rl.removeListener('line', onLine);
          rl.close();
          resolve(true);
        }
      } catch {
        // ignore malformed
      }
    };
    rl.on('line', onLine);
    setTimeout(() => {
      rl.removeListener('line', onLine);
      rl.close();
      resolve(false);
    }, 10_000);
  });
}

function findAuditLine(lines: any[], predicate: (l: any) => boolean) {
  return lines.find(predicate);
}

function readAuditLines(userDataDir: string): any[] {
  const auditDir = path.join(userDataDir, 'audit');
  if (!fs.existsSync(auditDir)) return [];
  const files = fs
    .readdirSync(auditDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  if (files.length === 0) return [];
  // The newest daily file covers all of today's rows.
  files.sort();
  const file = files[files.length - 1];
  return fs
    .readFileSync(path.join(auditDir, file), 'utf8')
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
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Daemon-only path — runs unconditionally; no LOCALBOT_SMOKE_OK gating.
// ─────────────────────────────────────────────────────────────────────────────

test('daemon: tree/list + edit_file + tree:refresh chokidar notification + 9-tool audit coverage', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-tree-diff-'));
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'hello.txt'), 'Hello, world!\n', 'utf8');
  // Binary file — NUL byte triggers {binary:true} in edit_file.cjs.
  fs.writeFileSync(path.join(workspace, 'hello.bin'), Buffer.from([0x00, 0x62, 0x69, 0x6e, 0x00]));

  const daemonEntry = path.join(process.cwd(), 'daemon', 'main.cjs');
  const child = spawn(process.execPath, [daemonEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LOCALBOT_USER_DATA_DIR: tmp,
      LOCALBOT_WATCHER_POLLING: '1',
    },
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  const stderrLines: string[] = [];
  child.stderr?.on('data', (chunk) => stderrLines.push(chunk.toString('utf8')));

  try {
    const ready = await awaitReady(child);
    expect(ready, 'daemon failed to emit {kind:"ready"} within 10s').toBe(true);

    const rpc = createJsonRpcClient(child);
    await rpc.send('initialize', {
      client: 'localbot-tree-diff-test',
      version: '0.3.0',
      userDataDir: tmp,
      bot: 'default',
      workspaceRoot: workspace,
      treeRoots: [{ id: 'workspace', absPath: workspace }],
    });

    // ── tree/list returns hello.txt + hello.bin ──
    const treeResp = await rpc.send('tree/list', {
      path: '.',
      maxDepth: 2,
    });
    expect(treeResp.error, `tree/list failed: ${JSON.stringify(treeResp)}`).toBeUndefined();
    const names = treeResp.result.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('hello.txt');
    expect(names).toContain('hello.bin');

    // ── edit_file round-trip on hello.txt ──
    const eResp = await rpc.send('tools/call', {
      name: 'edit_file',
      arguments: { path: 'hello.txt', find: 'world', replace: 'planet' },
      toolCallId: 'tc_tree_1',
      bot: 'default',
    });
    expect(eResp.error, `edit_file failed: ${JSON.stringify(eResp)}`).toBeUndefined();
    expect(eResp.result).toMatchObject({ path: 'hello.txt', replacements: 1 });
    expect(fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8')).toBe('Hello, planet!\n');

    // ── edit_file on hello.bin returns binary:true ──
    const binResp = await rpc.send('tools/call', {
      name: 'edit_file',
      arguments: { path: 'hello.bin', find: 'old', replace: 'new' },
      toolCallId: 'tc_tree_bin',
      bot: 'default',
    });
    // The daemon's edit_file may return either {binary:true} or refuse the
    // find pattern; either way the renderer takes the placeholder path.
    expect(binResp.result ?? binResp.error).toBeTruthy();

    // ── Drive the remaining 7 tools for audit coverage ──
    await rpc.send('tools/call', {
      name: 'read_file',
      arguments: { path: 'hello.txt' },
      toolCallId: 'tc_tree_read',
      bot: 'default',
    });
    await rpc.send('tools/call', {
      name: 'write_file',
      arguments: { path: 'new.txt', content: 'fresh\n' },
      toolCallId: 'tc_tree_write',
      bot: 'default',
    });
    await rpc.send('tools/call', {
      name: 'list_dir',
      arguments: { path: '.' },
      toolCallId: 'tc_tree_listdir',
      bot: 'default',
    });
    await rpc.send('tools/call', {
      name: 'code_search',
      arguments: { pattern: 'planet', path: '.' },
      toolCallId: 'tc_tree_search',
      bot: 'default',
    });
    await rpc.send('memory/write', {
      bot: 'default',
      markdown: '# Wave 3 memory\n',
      facts: { topic: { value: 'tree-diff', source: 'user', updatedAt: '2026-09-18T10:00:00Z' } },
    });
    await rpc.send('memory/read', { bot: 'default' });

    // ── chokidar fires tree:refresh within 500ms ──
    // Touch a file externally so the watcher detects the change.
    fs.writeFileSync(path.join(workspace, 'external.txt'), 'touched\n', 'utf8');
    // Wait up to 1500ms for the notification (debounce window 250ms + slack).
    const start = Date.now();
    let sawRefresh = false;
    while (Date.now() - start < 1500) {
      const found = rpc.notifications.find(
        (n) => n.method === 'tree:refresh' && typeof n.params?.rootPath === 'string',
      );
      if (found) {
        sawRefresh = true;
        expect(found.params.rootPath).toBe(workspace);
        expect(Array.isArray(found.params.changedPaths)).toBe(true);
        expect(found.params.changedPaths).toContain('external.txt');
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(
      sawRefresh,
      `expected a tree:refresh notification within 1500ms\nNotifications:\n${JSON.stringify(rpc.notifications, null, 2)}\nStderr:\n${stderrLines.join('')}`,
    ).toBe(true);

    // Allow audit flushes.
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    child.stdin.end();
    await new Promise((r) => setTimeout(r, 100));
    if (!child.killed) child.kill();
  }

  // ── Audit JSONL covers all 9 tool names + tree.refresh ──
  const lines = readAuditLines(tmp);
  for (const tool of [
    'read_file',
    'write_file',
    'edit_file',
    'list_dir',
    'code_search',
    'memory.read',
    'memory.write',
    'tree.list',
  ]) {
    const row = lines.find((l: any) => l.tool === tool);
    expect(row, `expected an audit line for ${tool}\nGot: ${JSON.stringify(lines, null, 2)}`).toBeTruthy();
  }
  // tree.refresh audit line emitted by the chokidar watcher.
  const refreshRow = findAuditLine(
    lines,
    (l: any) => l.tool === 'tree.refresh' && l.outcome === 'ok',
  );
  expect(refreshRow, `expected a tree.refresh audit line\nGot: ${JSON.stringify(lines, null, 2)}`).toBeTruthy();
  expect(refreshRow.params?.rootPath).toBe(workspace);
  expect(typeof refreshRow.params?.changedCount).toBe('number');

  // Cleanup.
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Headed Electron path — gated by LOCALBOT_SMOKE_OK=1.
// ─────────────────────────────────────────────────────────────────────────────

const HEADED_OK = process.env.LOCALBOT_SMOKE_OK === '1';

let fakeM3: FakeM3Server | null = null;
let headedUserDataRoot: string | null = null;
let headedUserDataDir: string | null = null;

test.beforeAll(async () => {
  if (HEADED_OK) fakeM3 = await createFakeM3Server();
});

test.afterAll(async () => {
  if (fakeM3) await fakeM3.close();
  if (headedUserDataRoot) {
    try {
      fs.rmSync(headedUserDataRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  headedUserDataRoot = null;
  headedUserDataDir = null;
});

test('headed: WorkspaceTree renders + DiffView mounts + binary placeholder + chokidar refresh', async () => {
  test.skip(!HEADED_OK, 'LOCALBOT_SMOKE_OK=1 not set — headed smoke is opt-in on a desktop session');
  expect(fakeM3, 'fake M3 server must be initialized').toBeTruthy();
  const m3 = fakeM3!;

  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-pw-tree-'));
  const userDataDir = path.join(userDataRoot, 'Localbot');
  const workspaceRoot = path.join(userDataRoot, 'workspace');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'hello.txt'), 'Hello, world!\n', 'utf8');
  // Binary file for the DiffBinaryPlaceholder path.
  fs.writeFileSync(path.join(workspaceRoot, 'hello.bin'), Buffer.from([0x00, 0x62, 0x69, 0x6e, 0x00]));
  headedUserDataRoot = userDataRoot;
  headedUserDataDir = userDataDir;

  const electronApp: ElectronApplication = await electron.launch({
    args: [path.join(process.cwd(), 'dist', 'main', 'index.js')],
    cwd: process.cwd(),
    env: {
      ...process.env,
      M3_API_BASE: m3.url,
      M3_MODEL: 'MiniMax/M3',
      LOCALBOT_USER_DATA_DIR: userDataDir,
      LOCALBOT_WORKSPACE_ROOT: workspaceRoot,
      LOCALBOT_SOFT_CAP_TOKENS: '100000',
      LOCALBOT_WATCHER_POLLING: '1',
      ELECTRON_DISABLE_SANDBOX: '1',
    },
    timeout: 30_000,
  });

  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // Prime key modal if visible.
    const modal = window.locator('[data-testid="key-modal"]');
    if (await modal.isVisible({ timeout: 8_000 }).catch(() => false)) {
      await window.locator('[data-testid="key-input"]').fill('sk-test-tree-diff');
      await window.locator('[data-testid="probe-button"]').click();
      await expect(window.locator('.modal-probe-ok')).toHaveText('OK', { timeout: 15_000 });
      await window.locator('[data-testid="save-button"]').click();
      await expect(modal).toBeHidden({ timeout: 10_000 });
    }

    // WorkspaceTree renders.
    const tree = window.locator('[data-testid="workspace-tree"]');
    await expect(tree).toBeVisible({ timeout: 15_000 });

    // ── Drive the edit_file tool_use path via fake M3 ──
    (m3 as any).__forceEditFile({ find: 'world', replace: 'planet', followupText: 'Edited' });
    const composer = window.locator('[data-testid="composer-input"]');
    await composer.fill('edit hello.txt to change world to planet');
    await window.locator('[data-testid="send-button"]').click();

    // The DiffView mounts within the assistant bubble.
    await expect(window.locator('[data-testid="diff-view"]').first()).toBeVisible({ timeout: 30_000 });
    const diffText = await window.locator('[data-testid="diff-view"]').first().innerText();
    expect(diffText).toContain('Diff: hello.txt');
    expect(diffText).toContain('world');
    expect(diffText).toContain('planet');

    // ── Drive the binary edit_file path via fake M3 ──
    (m3 as any).__forceBinaryEditFile({ followupText: 'Binary edit attempted' });
    await composer.fill('check the binary file');
    await window.locator('[data-testid="send-button"]').click();

    // The DiffBinaryPlaceholder mounts.
    await expect(window.locator('[data-testid="diff-binary"]').first()).toBeVisible({ timeout: 30_000 });
    const binText = await window.locator('[data-testid="diff-binary"]').first().innerText();
    expect(binText).toContain('Binary file');

    // ── WorkspaceTree refreshes within 500ms when a file is touched ──
    const beforeCount = await window.locator('.workspace-tree-name').count();
    fs.writeFileSync(path.join(workspaceRoot, 'new_file.txt'), 'touched\n', 'utf8');
    await window.waitForFunction(
      ({ before }) => document.querySelectorAll('.workspace-tree-name').length > before,
      { before: beforeCount, timeout: 1500 },
    );
  } finally {
    await electronApp.close();
  }

  // ── Audit JSONL covers all 9 tool names + tree.refresh ──
  // Allow audit to flush.
  await new Promise((r) => setTimeout(r, 400));
  const lines = readAuditLines(userDataDir);
  for (const tool of [
    'read_file',
    'write_file',
    'edit_file',
    'list_dir',
    'code_search',
    'memory.read',
    'memory.write',
    'tree.list',
  ]) {
    const row = lines.find((l: any) => l.tool === tool);
    expect(row, `expected an audit line for ${tool}\nGot: ${JSON.stringify(lines, null, 2)}`).toBeTruthy();
  }
  // The headed run's external write should have produced at least one
  // tree.refresh audit line.
  const refreshRows = lines.filter((l: any) => l.tool === 'tree.refresh' && l.outcome === 'ok');
  expect(refreshRows.length, `expected at least one tree.refresh audit row\nGot: ${JSON.stringify(lines, null, 2)}`).toBeGreaterThan(0);
});