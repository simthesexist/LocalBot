// Playwright daemon-smoke for the Phase 7 Plan 3 Obsidian Integration
// vertical slice. Drives the full stack from fake M3 vault.* tool_use
// helper -> daemon tools/call -> audit JSONL. UI block rendering is
// verified by VaultReadBlock / VaultWriteBlock / VaultSearchBlock which
// were shipped in Plan 07-02 (those blocks consume the same MessageBlock
// variants this test exercises via the daemon's tools/call handler).
//
// Four cases:
//   1. vault.read happy path — bot reads Projects/foo.md inside the
//      configured vault; audit row carries vault-relative path only.
//   2. vault.write inside Agents/<bot>/ — bot writes a note; file appears
//      on disk; audit row carries {path, bytesWritten}.
//   3. vault.write outside Agents/<bot>/ — refused with
//      code:'write_outside_agents'; no file created; audit row carries
//      outcome:'error'.
//   4. vault.search audit row carries {query, glob, result_count,
//      truncated}.
//
// Prohibitions (per PLAN):
//   - MUST NOT hardcode vault paths — use mkdtemp + LOCALBOT_USER_DATA_DIR.
//   - MUST NOT skip audit minimization assertion — every case asserts
//     vault-relative path only (no absolute path; never rootPath).
//   - MUST NOT depend on a real Obsidian vault.
//
// ─── DEVIATION from PLAN ───────────────────────────────────────────────
// The plan describes an LLM-driven flow (bots/trigger → fake-m3 stream
// → tool_use → daemon tool handler → audit). That requires the daemon's
// `runSendMessageCycle` (daemon/main.cjs:37) to pass `tools` to the
// Anthropic SDK call — currently it does NOT (the `tools` parameter is
// omitted, so the LLM never receives a tool list and never emits a
// tool_use block). Wiring tools through runSendMessageCycle is outside
// Plan 07-03's scope (it's a separate daemon architectural change), so
// this test instead drives the daemon's `tools/call` JSON-RPC method
// directly — the same pattern tests/playwright/daemon-tools.test.ts uses
// for read_file / write_file / edit_file / list_dir. The fake-m3-server
// helpers from Plan 07-03 are still used by the headed Electron E2E
// (and any future LLM-driven test once runSendMessageCycle wires tools),
// so the helpers themselves remain part of this plan's deliverables.
// ───────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { spawn, ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

interface PendingRequest {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

function createJsonRpcClient(child: ChildProcessByStdio<Writable, Readable>) {
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let obj: any;
    try { obj = JSON.parse(line); } catch { return; }
    if (typeof obj.id === 'number' && pending.has(obj.id)) {
      const p = pending.get(obj.id)!;
      pending.delete(obj.id);
      p.resolve(obj);
    }
  });
  return {
    send(method: string, params?: Record<string, unknown>): Promise<any> {
      const id = nextId++;
      const msg = { jsonrpc: '2.0', id, method, params };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify(msg) + '\n');
      });
    },
  };
}

function awaitReady(child: ChildProcessByStdio<Writable, Readable>): Promise<boolean> {
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
      } catch { /* ignore */ }
    };
    rl.on('line', onLine);
    setTimeout(() => {
      rl.removeListener('line', onLine);
      rl.close();
      resolve(false);
    }, 10_000);
  });
}

function readAuditLines(userDataDir: string): Array<Record<string, unknown>> {
  const dir = path.join(userDataDir, 'audit');
  if (!fs.existsSync(dir)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of text.split('\n').filter(Boolean)) {
      try { out.push(JSON.parse(line)); } catch { /* ignore */ }
    }
  }
  return out;
}

interface DaemonContext {
  child: ChildProcessByStdio<Writable, Readable>;
  userDataDir: string;
  vaultRoot: string;
  rpc: ReturnType<typeof createJsonRpcClient>;
}

/**
 * Spawn a daemon against a tmpfs userData dir + tmpfs vault root, populate
 * a sample vault tree, then send initialize + bots/create + bots/update
 * (with per-bot vault config) + a vault.json on disk. Returns the live
 * JSON-RPC client so the caller can drive tools/call directly.
 */
async function spawnVaultDaemon(opts: {
  prefix: string;
  botName: string;
  allowlist: string[];
  globalDeny?: string[];
  vaultAllow?: string[];
  vaultDeny?: string[];
}): Promise<DaemonContext> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `localbot-vault-e2e-${opts.prefix}-`));
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), `localbot-vault-root-${opts.prefix}-`));
  fs.mkdirSync(path.join(vaultRoot, 'Projects'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'Projects', 'foo.md'), 'hello world\n', 'utf8');
  fs.mkdirSync(path.join(vaultRoot, 'Private'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'Private', 'secret.md'), 'classified\n', 'utf8');
  fs.mkdirSync(path.join(vaultRoot, 'Agents', opts.botName), { recursive: true });

  // Pre-populate the global vault config BEFORE spawning the daemon so
  // loadVaultConfig on initialize picks it up.
  fs.writeFileSync(
    path.join(userDataDir, 'vault.json'),
    JSON.stringify({
      rootPath: vaultRoot,
      globalDeny: opts.globalDeny ?? [],
    }),
    'utf8',
  );

  const daemonEntry = path.resolve(process.cwd(), 'daemon', 'main.cjs');
  const child = spawn(process.execPath, [daemonEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LOCALBOT_USER_DATA_DIR: userDataDir,
      ANTHROPIC_API_KEY: 'fake-test-key',
      // M3_API_BASE is required for bots/trigger but NOT for tools/call;
      // use a stub URL so any accidental LLM call would surface as a
      // connection refused in logs (rather than silently falling through).
      M3_API_BASE: 'http://127.0.0.1:1',
    },
  }) as ChildProcessByStdio<Writable, Readable>;

  const ready = await awaitReady(child);
  expect(ready, 'daemon failed to emit {kind:"ready"}').toBe(true);

  const rpc = createJsonRpcClient(child);

  await rpc.send('initialize', {
    client: `localbot-vault-e2e-${opts.prefix}`,
    version: '0.7.0',
    userDataDir,
    workspaceRoot: userDataDir,
    bot: opts.botName,
  });

  await rpc.send('bots/create', {
    name: opts.botName,
    persona: `vault test bot ${opts.botName}`,
    workspace: userDataDir,
    allowlist: opts.allowlist,
  });

  const patch: Record<string, unknown> = {};
  if (opts.vaultAllow !== undefined) patch.vaultAllow = opts.vaultAllow;
  if (opts.vaultDeny !== undefined) patch.vaultDeny = opts.vaultDeny;
  if (Object.keys(patch).length > 0) {
    await rpc.send('bots/update', { bot: opts.botName, patch });
  }
  // Settle the bot config reload + vault config reload.
  await new Promise((r) => setTimeout(r, 80));

  return { child, userDataDir, vaultRoot, rpc };
}

function killDaemon(child: ChildProcessByStdio<Writable, Readable>) {
  try { child.kill(); } catch { /* ignore */ }
}

function cleanup(userDataDir: string, vaultRoot: string) {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(vaultRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

test.describe('Phase 7 Plan 3 obsidian integration E2E (daemon-smoke)', () => {
  test('vault.read happy path: relative path in audit + content reaches the tool handler', async () => {
    const { child, userDataDir, vaultRoot, rpc } = await spawnVaultDaemon({
      prefix: 'read-happy',
      botName: 'alpha',
      allowlist: ['vault.read'],
      vaultAllow: ['Projects/**'],
      globalDeny: ['Private/**'],
    });
    try {
      // Case 1: vault.read returns the file content. The renderer (in the
      // headed Electron app) renders VaultReadBlock with that content; this
      // daemon-smoke verifies the underlying tool handler + audit chain.
      const resp = await rpc.send('tools/call', {
        name: 'vault.read',
        arguments: { path: 'Projects/foo.md' },
        toolCallId: 'tc_vault_read_happy_1',
        bot: 'alpha',
      });
      expect(resp.error, `vault.read failed: ${JSON.stringify(resp)}`).toBeUndefined();
      expect(resp.result.content).toBe('hello world\n');
      expect(resp.result.path).toBe('Projects/foo.md');
      expect(typeof resp.result.bytes).toBe('number');
      expect(resp.result.bytes as number).toBe('hello world\n'.length);

      // Audit flush.
      await new Promise((r) => setTimeout(r, 250));

      // Audit minimization: vault.read row carries vault-relative path only.
      const lines = readAuditLines(userDataDir);
      const vaultReadLine = lines.find(
        (l) => l.tool === 'vault.read' && (l.params as any)?.path === 'Projects/foo.md',
      );
      expect(
        vaultReadLine,
        `expected a vault.read audit row with params.path='Projects/foo.md'\nGot: ${JSON.stringify(lines, null, 2)}`,
      ).toBeTruthy();
      expect(vaultReadLine!.outcome).toBe('ok');
      const params = vaultReadLine!.params as Record<string, unknown>;
      // Audit must carry ONLY the vault-relative path + bytes — never the
      // absolute vault root, never rootPath, never absolute paths.
      expect(Object.keys(params).sort()).toEqual(['bytes', 'path']);
      expect(params.path).toBe('Projects/foo.md');
      expect(typeof params.bytes).toBe('number');
      expect((params.bytes as number)).toBeGreaterThan(0);
      const serialised = JSON.stringify(vaultReadLine);
      expect(serialised).not.toContain(vaultRoot.replace(/\\/g, '\\\\'));
      expect(serialised).not.toContain('rootPath');
    } finally {
      killDaemon(child);
      cleanup(userDataDir, vaultRoot);
    }
  });

  test('vault.write inside Agents/<bot>/ creates the file; audit carries {path, bytesWritten}', async () => {
    const { child, userDataDir, vaultRoot, rpc } = await spawnVaultDaemon({
      prefix: 'write-happy',
      botName: 'alpha',
      allowlist: ['vault.write'],
      vaultAllow: ['**/*'],
    });
    try {
      const resp = await rpc.send('tools/call', {
        name: 'vault.write',
        arguments: { path: 'Agents/alpha/note.md', content: 'test write\n' },
        toolCallId: 'tc_vault_write_happy_1',
        bot: 'alpha',
      });
      expect(resp.error, `vault.write failed: ${JSON.stringify(resp)}`).toBeUndefined();
      expect(resp.result).toMatchObject({ path: 'Agents/alpha/note.md', bytesWritten: 11 });

      // File must exist on disk with the expected content.
      const filePath = path.join(vaultRoot, 'Agents', 'alpha', 'note.md');
      expect(fs.existsSync(filePath), `expected file at ${filePath}`).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe('test write\n');

      // Audit row: outcome ok + {path, bytesWritten}; never absolute.
      await new Promise((r) => setTimeout(r, 250));
      const lines = readAuditLines(userDataDir);
      const writeLine = lines.find(
        (l) => l.tool === 'vault.write' && (l.params as any)?.path === 'Agents/alpha/note.md',
      );
      expect(
        writeLine,
        `expected a vault.write audit row with params.path='Agents/alpha/note.md'\nGot: ${JSON.stringify(lines, null, 2)}`,
      ).toBeTruthy();
      expect(writeLine!.outcome).toBe('ok');
      const params = writeLine!.params as Record<string, unknown>;
      expect(Object.keys(params).sort()).toEqual(['bytesWritten', 'path']);
      expect(params.path).toBe('Agents/alpha/note.md');
      expect(typeof params.bytesWritten).toBe('number');
      expect(params.bytesWritten).toBe('test write\n'.length);
      const serialised = JSON.stringify(writeLine);
      expect(serialised).not.toContain(vaultRoot.replace(/\\/g, '\\\\'));
      expect(serialised).not.toContain('rootPath');
    } finally {
      killDaemon(child);
      cleanup(userDataDir, vaultRoot);
    }
  });

  test('vault.write outside Agents/<bot>/ refused with code:write_outside_agents', async () => {
    const { child, userDataDir, vaultRoot, rpc } = await spawnVaultDaemon({
      prefix: 'write-refused',
      botName: 'alpha',
      allowlist: ['vault.write'],
      vaultAllow: ['**/*'],
    });
    try {
      // The write targets Projects/foo.md — outside Agents/<bot>/ — so
      // the daemon must refuse it with code:write_outside_agents.
      const resp = await rpc.send('tools/call', {
        name: 'vault.write',
        arguments: { path: 'Projects/foo.md', content: 'hijack attempt\n' },
        toolCallId: 'tc_vault_write_refused_1',
        bot: 'alpha',
      });
      expect(resp.error, `vault.write unexpectedly succeeded: ${JSON.stringify(resp)}`).toBeTruthy();
      expect(resp.error.code).toBe('write_outside_agents');

      // The original Projects/foo.md must remain unchanged.
      const filePath = path.join(vaultRoot, 'Projects', 'foo.md');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe('hello world\n');

      // Audit row: outcome error + error.code = write_outside_agents.
      await new Promise((r) => setTimeout(r, 250));
      const lines = readAuditLines(userDataDir);
      const writeLine = lines.find(
        (l) => l.tool === 'vault.write' && (l.params as any)?.path === 'Projects/foo.md',
      );
      expect(
        writeLine,
        `expected a vault.write audit row for Projects/foo.md (refused)\nGot: ${JSON.stringify(lines, null, 2)}`,
      ).toBeTruthy();
      expect(writeLine!.outcome).toBe('error');
      const errObj = writeLine!.error as Record<string, unknown>;
      expect(errObj.code).toBe('write_outside_agents');
    } finally {
      killDaemon(child);
      cleanup(userDataDir, vaultRoot);
    }
  });

  test('vault.search audit row carries {query, glob, result_count, truncated}', async () => {
    const { child, userDataDir, vaultRoot, rpc } = await spawnVaultDaemon({
      prefix: 'search-happy',
      botName: 'alpha',
      allowlist: ['vault.search'],
      vaultAllow: ['Projects/**'],
    });
    try {
      const resp = await rpc.send('tools/call', {
        name: 'vault.search',
        arguments: { pattern: 'hello' },
        toolCallId: 'tc_vault_search_1',
        bot: 'alpha',
      });
      expect(resp.error, `vault.search failed: ${JSON.stringify(resp)}`).toBeUndefined();
      expect(Array.isArray(resp.result.matches)).toBe(true);
      expect(resp.result.count as number).toBeGreaterThanOrEqual(1);
      expect(typeof resp.result.truncated).toBe('boolean');

      // Audit flush.
      await new Promise((r) => setTimeout(r, 400));
      const lines = readAuditLines(userDataDir);
      const searchLine = lines.find(
        (l) => l.tool === 'vault.search' && (l.params as any)?.query === 'hello',
      );
      expect(
        searchLine,
        `expected a vault.search audit row with query='hello'\nGot: ${JSON.stringify(lines, null, 2)}`,
      ).toBeTruthy();
      // Audit must carry exactly the 4-key minimization shape and never
      // include absolute paths or match snippets.
      const params = searchLine!.params as Record<string, unknown>;
      expect(Object.keys(params).sort()).toEqual(['glob', 'query', 'result_count', 'truncated']);
      expect(params.query).toBe('hello');
      // glob may be null when not specified.
      expect(params.glob === null || typeof params.glob === 'string').toBe(true);
      expect(typeof params.result_count).toBe('number');
      expect(params.result_count as number).toBeGreaterThanOrEqual(1);
      expect(typeof params.truncated).toBe('boolean');
      const serialised = JSON.stringify(searchLine);
      expect(serialised).not.toContain(vaultRoot.replace(/\\/g, '\\\\'));
      expect(serialised).not.toContain('hello world'); // never match snippets
    } finally {
      killDaemon(child);
      cleanup(userDataDir, vaultRoot);
    }
  });
});