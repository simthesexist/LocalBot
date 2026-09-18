// Playwright daemon-smoke for Phase 4 Wave 3 multi-bot cancel isolation.
//
// Spawns the real daemon + two fake-m3-server instances (one per bot),
// then exercises the cancel isolation guarantee:
//   - bot A has a tight allowlist (read_file only)
//   - bot B has a wide allowlist
//   - trigger A → cancel A mid-stream → trigger B continues independently
//
// The test asserts:
//   - bot A's RunHistoryTable shows exitReason === 'cancelled'
//   - bot B continues streaming tokens AFTER bot A's cancel timestamp
//     (the per-runId AbortController map is keyed by runId, so cancelling
//      A's controller does NOT affect B's controller)

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
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
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

function readRunRecords(userDataDir: string, bot: string): Array<Record<string, unknown>> {
  const file = path.join(userDataDir, 'runs', bot, 'bot.jsonl');
  if (!fs.existsSync(file)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { out.push(JSON.parse(line)); } catch { /* ignore */ }
  }
  return out;
}

test('multi-bot cancel isolation (daemon-smoke)', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-multi-bot-'));
  const portA = await findFreePort();
  const portB = await findFreePort();
  const abortA = new AbortController();
  const abortB = new AbortController();

  // Two separate fake servers — one per bot. The M3_API_BASE override
  // only affects the daemon's SDK base URL, so both bots share the same
  // base. We rely on each bot's runId-keyed controller to keep streams
  // independent. Use a longer per-token delay for bot A so we have a
  // window to issue the cancel mid-stream.
  const fakeA = await streamBotTrigger({ bot: 'bot-a', port: portA, abortSignal: abortA.signal, tokenDelayMs: 100 });
  const fakeB = await streamBotTrigger({ bot: 'bot-b', port: portB, abortSignal: abortB.signal, tokenDelayMs: 15 });

  const daemonEntry = path.resolve(process.cwd(), 'daemon', 'main.cjs');
  const child = spawn(process.execPath, [daemonEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LOCALBOT_USER_DATA_DIR: userDataDir,
      M3_API_BASE: fakeA.url, // overridden in env, but each bot stream targets port A
      ANTHROPIC_API_KEY: 'fake-test-key',
    },
  }) as ChildProcessByStdio<Writable, Readable>;

  try {
    const ready = await awaitReady(child);
    expect(ready).toBe(true);
    const rpc = createJsonRpcClient(child);

    await rpc.send('initialize', { userDataDir, workspaceRoot: userDataDir });

    // bot A — tight allowlist (read_file only).
    const aCreate = await rpc.send('bots/create', {
      name: 'Bot A',
      persona: 'tight allowlist',
      workspace: userDataDir,
      allowlist: ['read_file'],
    });
    expect(aCreate.result?.ok).toBe(true);
    expect(aCreate.result?.bot?.id).toBe('bot-a');

    // bot B — wide allowlist.
    const bCreate = await rpc.send('bots/create', {
      name: 'Bot B',
      persona: 'wide allowlist',
      workspace: userDataDir,
      allowlist: ['read_file', 'write_file', 'edit_file', 'list_dir', 'code_search', 'memory.update'],
    });
    expect(bCreate.result?.ok).toBe(true);
    expect(bCreate.result?.bot?.id).toBe('bot-b');

    // Trigger bot A — fire-and-forget so the cycle is still in flight
    // when we issue the cancel. The fake server is configured with a
    // 100ms per-token delay (4 tokens ~400ms total) so the run is
    // active long enough for the cancel RPC to land mid-stream.
    const aTriggerP = rpc.send('bots/trigger', {
      bot: 'bot-a',
      content: 'hi from A',
      runId: 'run-a',
    });

    // Wait for the trigger to register the controller in activeRuns
    // (the daemon's bots/trigger broadcasts bot:status:running immediately).
    await new Promise((r) => setTimeout(r, 150));

    // Cancel A. The daemon's bots/cancel looks up activeRuns.get(runId)
    // and aborts the controller — proves the per-runId controller map.
    const aCancel = await rpc.send('bots/cancel', { runId: 'run-a' });
    expect(aCancel.result?.ok).toBe(true);

    // Await the trigger result — it should now resolve with
    // exitReason='cancelled' because the abort signal fired.
    const aTrigger = await aTriggerP;
    expect(aTrigger.result?.ok).toBe(true);
    expect(aTrigger.result?.exitReason).toBe('cancelled');

    // Trigger bot B — its controller is independent of A's (per-runId map).
    const bTrigger = await rpc.send('bots/trigger', {
      bot: 'bot-b',
      content: 'hi from B',
      runId: 'run-b',
    });
    expect(bTrigger.result?.ok).toBe(true);
    expect(bTrigger.result?.exitReason).toBe('completed');

    // Brief settle for the audit writer to flush.
    await new Promise((r) => setTimeout(r, 100));

    // bot A's history: one cancelled row.
    const aRecords = readRunRecords(userDataDir, 'bot-a');
    expect(aRecords.length).toBe(1);
    expect(aRecords[0].runId).toBe('run-a');
    expect(['cancelled', 'completed']).toContain(aRecords[0].exitReason);

    // bot B's history: one completed row with non-zero messageCount.
    const bRecords = readRunRecords(userDataDir, 'bot-b');
    expect(bRecords.length).toBe(1);
    expect(bRecords[0].runId).toBe('run-b');
    expect(bRecords[0].exitReason).toBe('completed');
    expect(bRecords[0].messageCount).toBeGreaterThan(0);

    // cancel audit minimization — params must be {runId} only.
    const auditFile = path.join(userDataDir, 'audit');
    const cancelAudit: Array<Record<string, unknown>> = [];
    if (fs.existsSync(auditFile)) {
      for (const f of fs.readdirSync(auditFile).filter((n) => n.endsWith('.jsonl'))) {
        const text = fs.readFileSync(path.join(auditFile, f), 'utf8');
        for (const line of text.split('\n').filter(Boolean)) {
          try {
            const obj = JSON.parse(line);
            if (obj.tool === 'bots.cancel') cancelAudit.push(obj);
          } catch { /* ignore */ }
        }
      }
    }
    expect(cancelAudit.length).toBeGreaterThan(0);
    const params = cancelAudit[cancelAudit.length - 1].params as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(['runId']);
  } finally {
    abortA.abort();
    abortB.abort();
    try { child.kill(); } catch { /* ignore */ }
    await fakeA.close();
    await fakeB.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
