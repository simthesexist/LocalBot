// Playwright daemon-smoke for the Phase 4 bot CRUD + trigger vertical.
//
// Spawns the real daemon via process.execPath + an in-process fake M3
// server (`streamBotTrigger`), exercises the full bot lifecycle:
//   bots/create → bots/trigger (canned token stream) → run history
//   append → bots/update (audit minimization) → bots/delete.
//
// Runs in `daemon-smoke` project (headless, no Electron window) so it
// fits in CI without a display. Headed gating is inherited from
// `playwright.config.ts` (LOCALBOT_SMOKE_OK=1 → headless:false).

import { test, expect } from '@playwright/test';
import { spawn, ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { streamBotTrigger } from './fake-m3-server';

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

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = require('node:net').createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const port = (srv.address() as any).port;
      srv.close(() => resolve(port));
    });
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

function readRunRecords(userDataDir: string, bot: string): Array<Record<string, unknown>> {
  const file = path.join(userDataDir, 'runs', bot, 'bot.jsonl');
  if (!fs.existsSync(file)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { out.push(JSON.parse(line)); } catch { /* ignore */ }
  }
  return out;
}

test('bot CRUD + trigger + run history vertical (daemon-smoke)', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-bot-crud-'));
  const m3Port = await findFreePort();
  const abortController = new AbortController();

  const fakeM3 = await streamBotTrigger({
    bot: 'test-bot-1',
    port: m3Port,
    abortSignal: abortController.signal,
  });

  const daemonEntry = path.resolve(process.cwd(), 'daemon', 'main.cjs');
  const child = spawn(process.execPath, [daemonEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LOCALBOT_USER_DATA_DIR: userDataDir,
      M3_API_BASE: fakeM3.url,
      ANTHROPIC_API_KEY: 'fake-test-key',
    },
  }) as ChildProcessByStdio<Writable, Readable>;

  try {
    const ready = await awaitReady(child);
    expect(ready, 'daemon failed to emit {kind:"ready"} within 10s').toBe(true);
    const rpc = createJsonRpcClient(child);

    // initialize — wire workspaceRoot + userDataDir + M3_API_BASE.
    await rpc.send('initialize', {
      client: 'localbot-bot-crud-test',
      version: '0.1.0',
      userDataDir,
      workspaceRoot: userDataDir,
    });

    // 1. bots/create — type-safe create with persona + allowlist.
    const createResp = await rpc.send('bots/create', {
      name: 'Test Bot 1',
      persona: 'I am a test bot',
      workspace: userDataDir,
      allowlist: ['read_file', 'write_file', 'edit_file', 'list_dir'],
    });
    expect(createResp.result?.ok).toBe(true);
    expect(createResp.result?.bot?.id).toBe('test-bot-1');

    // 2. bots/list — assert the sidebar would show the row.
    const listResp = await rpc.send('bots/list', {});
    const ids = (listResp.result?.bots ?? []).map((b: any) => b.id);
    expect(ids).toContain('test-bot-1');

    // 3+4+5+6+7. bots/trigger — fire a manual run; fake server emits 4
    // tokens spaced ~25ms apart, then {event:'done'}. The daemon's
    // runSendMessageCycle writes one RunRecord on completion.
    const triggerResp = await rpc.send('bots/trigger', {
      bot: 'test-bot-1',
      content: 'hello',
      runId: 'run-test-1',
    });
    expect(triggerResp.result?.ok).toBe(true);
    expect(triggerResp.result?.runId).toBe('run-test-1');
    expect(['completed', 'cancelled']).toContain(triggerResp.result?.exitReason);

    // 8. Wait briefly for the audit + run JSONL writes to flush.
    await new Promise((r) => setTimeout(r, 250));

    // Run history should now have one row for test-bot-1.
    const records = readRunRecords(userDataDir, 'test-bot-1');
    expect(records.length).toBe(1);
    expect(records[0].runId).toBe('run-test-1');
    expect(records[0].trigger).toBe('manual');

    // 9. bots/update — verify audit minimization: only {changedKeys}
    // (no persona content leaks).
    const updateResp = await rpc.send('bots/update', {
      bot: 'test-bot-1',
      patch: { persona: 'updated persona', allowlist: ['read_file'] },
    });
    expect(updateResp.result?.ok).toBe(true);
    expect(updateResp.result?.bot?.persona).toBe('updated persona');

    const updateAudit = readAuditLines(userDataDir).filter(
      (l) => l.tool === 'bots.update' && l.outcome === 'ok',
    );
    expect(updateAudit.length).toBeGreaterThan(0);
    const lastUpdate = updateAudit[updateAudit.length - 1];
    expect((lastUpdate.params as any).changedKeys.sort()).toEqual(['allowlist', 'persona']);
    expect((lastUpdate.params as any).persona).toBeUndefined();
    expect((lastUpdate.params as any).workspace).toBeUndefined();

    // 10. bots/create audit must minimize to {id, name} only.
    const createAudit = readAuditLines(userDataDir).filter(
      (l) => l.tool === 'bots.create' && l.outcome === 'ok',
    );
    expect(createAudit.length).toBe(1);
    const createParams = createAudit[0].params as any;
    expect(createParams.id).toBe('test-bot-1');
    expect(createParams.name).toBe('Test Bot 1');
    expect(createParams.persona).toBeUndefined();
    expect(createParams.personaBytes).toBeUndefined();
    expect(createParams.allowlist).toBeUndefined();

    // 11. bots/delete — remove the bot.
    const deleteResp = await rpc.send('bots/delete', { bot: 'test-bot-1' });
    expect(deleteResp.result?.ok).toBe(true);

    const afterDeleteList = await rpc.send('bots/list', {});
    const idsAfter = (afterDeleteList.result?.bots ?? []).map((b: any) => b.id);
    expect(idsAfter).not.toContain('test-bot-1');
  } finally {
    abortController.abort();
    try { child.kill(); } catch { /* ignore */ }
    await fakeM3.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
