// Playwright daemon-smoke for the Phase 6 Wave 3 scheduler + notification
// end-to-end vertical.
//
// Drives the full stack from fake M3 cron stream -> daemon
// bots/trigger(trigger='cron') -> audit JSONL -> scheduler.json
// cleanup on bots/delete. Verifies:
//   - Cron happy path: RunRecord.trigger === 'cron'; audit row carries
//     only {runId, trigger, messageCount} (T-P6-19 mitigation).
//   - Cron error path: notification event captured via the audit JSONL
//     (the spawn.ts bridge to main process is exercised by the headed
//     scheduler-notification-headed.test.ts; the daemon-smoke variant
//     just asserts the audit row stamps an error sub-object).
//   - Cron disabled path: bots/update with cronEnabled:false removes
//     the schedule from scheduler.json (no further ticks fire).
//   - Bot delete path: bots/delete cleans scheduler.json.
//
// Pattern mirrors tests/playwright/bot-crud.test.ts (daemon-smoke
// project, headless, no Electron window) so it fits CI without a display.

import { test, expect } from '@playwright/test';
import { spawn, ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { streamCronTrigger, streamCronError } from './fake-m3-server';

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

function readSchedules(userDataDir: string): { schedules: Array<Record<string, unknown>> } {
  const p = path.join(userDataDir, 'scheduler.json');
  if (!fs.existsSync(p)) return { schedules: [] };
  const text = fs.readFileSync(p, 'utf8');
  if (!text.trim().length) return { schedules: [] };
  return JSON.parse(text);
}

test.describe('Phase 6 Wave 3 scheduler + notification E2E (daemon-smoke)', () => {
  test('happy path: cron fire stamps RunRecord.trigger="cron" and audit row with {runId, trigger, messageCount}', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-sched-e2e-happy-'));
    const m3Port = await findFreePort();
    const abortController = new AbortController();
    const fakeM3 = await streamCronTrigger({
      bot: 'cron-happy-bot',
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
      await rpc.send('initialize', {
        client: 'localbot-scheduler-e2e',
        version: '0.1.0',
        userDataDir,
        workspaceRoot: userDataDir,
      });
      await rpc.send('bots/create', {
        name: 'cron-happy-bot',
        persona: 'I am a cron test bot',
        workspace: userDataDir,
        allowlist: ['read_file'],
      });
      await rpc.send('bots/update', {
        bot: 'cron-happy-bot',
        patch: { cron: '*/5 * * * *', cronEnabled: true, notifyOnError: true },
      });
      await new Promise((r) => setTimeout(r, 80));
      // Fire one cron cycle via the JSON-RPC seam (Plan 1).
      const triggerResp = await rpc.send('bots/trigger', {
        bot: 'cron-happy-bot',
        content: 'cron fire content',
        runId: 'run-cron-happy-1',
        trigger: 'cron',
      });
      expect(triggerResp.result?.ok).toBe(true);
      // Allow audit + RunRecord writes to flush.
      await new Promise((r) => setTimeout(r, 600));
      const records = readRunRecords(userDataDir, 'cron-happy-bot');
      expect(records.length, 'RunRecord should be written').toBeGreaterThanOrEqual(1);
      const cron = records.find((r) => r.trigger === 'cron');
      expect(cron, 'RunRecord.trigger should be "cron"').toBeTruthy();
      expect(cron!.runId).toBe('run-cron-happy-1');

      // Audit minimization: exactly {runId, trigger, messageCount}.
      const cronRuns = readAuditLines(userDataDir).filter(
        (l) => l.tool === 'bots.run' && (l.params as any)?.trigger === 'cron' && (l.params as any)?.runId === 'run-cron-happy-1',
      );
      expect(cronRuns.length, 'exactly one bots.run audit row').toBe(1);
      const params = cronRuns[0].params as Record<string, unknown>;
      expect(Object.keys(params).sort()).toEqual(['messageCount', 'runId', 'trigger']);
      expect(params.trigger).toBe('cron');
      expect(typeof params.messageCount).toBe('number');
    } finally {
      abortController.abort();
      try { child.kill(); } catch { /* ignore */ }
      await fakeM3.close();
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('error path: cron error emits notification event + audit row carries error sub-object', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-sched-e2e-err-'));
    const m3Port = await findFreePort();
    const abortController = new AbortController();
    const fakeM3 = await streamCronError({
      bot: 'cron-err-bot',
      port: m3Port,
      abortSignal: abortController.signal,
      errorMessage: 'simulated cron failure for E2E',
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
      await rpc.send('initialize', {
        client: 'localbot-scheduler-e2e-err',
        version: '0.1.0',
        userDataDir,
        workspaceRoot: userDataDir,
      });
      await rpc.send('bots/create', {
        name: 'cron-err-bot',
        persona: '',
        workspace: userDataDir,
        allowlist: [],
      });
      await rpc.send('bots/update', {
        bot: 'cron-err-bot',
        patch: { cron: '*/5 * * * *', cronEnabled: true, notifyOnError: true },
      });
      await new Promise((r) => setTimeout(r, 80));
      const triggerResp = await rpc.send('bots/trigger', {
        bot: 'cron-err-bot',
        content: 'cron fire error path',
        runId: 'run-cron-err-1',
        trigger: 'cron',
      });
      expect(triggerResp.result?.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 600));

      // The audit row for the errored cron fire must carry an `error`
      // sub-object with {code, message}. The 3-key params shape is
      // preserved (T-P6-19 mitigation).
      const errRuns = readAuditLines(userDataDir).filter(
        (l) => l.tool === 'bots.run' && (l.params as any)?.trigger === 'cron' && (l.params as any)?.runId === 'run-cron-err-1',
      );
      expect(errRuns.length, 'cron error audit row should exist').toBeGreaterThanOrEqual(1);
      const errRun = errRuns[0];
      const params = errRun.params as Record<string, unknown>;
      expect(Object.keys(params).sort()).toEqual(['messageCount', 'runId', 'trigger']);
      expect(errRun.error).toBeTruthy();
      const errObj = errRun.error as Record<string, unknown>;
      expect(typeof errObj.code).toBe('string');
      expect(typeof errObj.message).toBe('string');
    } finally {
      abortController.abort();
      try { child.kill(); } catch { /* ignore */ }
      await fakeM3.close();
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('disabled path: cronEnabled=false removes the schedule from scheduler.json', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-sched-e2e-disabled-'));
    const m3Port = await findFreePort();
    const abortController = new AbortController();
    const fakeM3 = await streamCronTrigger({
      bot: 'cron-disabled-bot',
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
      expect(ready).toBe(true);
      const rpc = createJsonRpcClient(child);
      await rpc.send('initialize', {
        client: 'localbot-scheduler-e2e-disabled',
        version: '0.1.0',
        userDataDir,
        workspaceRoot: userDataDir,
      });
      await rpc.send('bots/create', {
        name: 'cron-disabled-bot',
        persona: '',
        workspace: userDataDir,
        allowlist: [],
      });
      // Schedule enabled → scheduler.json gains the entry.
      await rpc.send('bots/update', {
        bot: 'cron-disabled-bot',
        patch: { cron: '*/5 * * * *', cronEnabled: true, notifyOnError: true },
      });
      await new Promise((r) => setTimeout(r, 80));
      let sched = readSchedules(userDataDir);
      const enabled = sched.schedules.find((s) => s.bot === 'cron-disabled-bot');
      expect(enabled).toBeTruthy();
      expect(enabled!.enabled).toBe(true);
      // Disable → persisted entry marked disabled (the croner task is
      // stopped but the row stays so re-enabling doesn't lose state).
      await rpc.send('bots/update', {
        bot: 'cron-disabled-bot',
        patch: { cronEnabled: false },
      });
      await new Promise((r) => setTimeout(r, 80));
      sched = readSchedules(userDataDir);
      const after = sched.schedules.find((s) => s.bot === 'cron-disabled-bot');
      expect(after).toBeTruthy();
      expect(after!.enabled).toBe(false);
    } finally {
      abortController.abort();
      try { child.kill(); } catch { /* ignore */ }
      await fakeM3.close();
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('delete path: bots/delete cleans scheduler.json (schedule entry gone)', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-sched-e2e-delete-'));
    const m3Port = await findFreePort();
    const abortController = new AbortController();
    const fakeM3 = await streamCronTrigger({
      bot: 'cron-delete-bot',
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
      expect(ready).toBe(true);
      const rpc = createJsonRpcClient(child);
      await rpc.send('initialize', {
        client: 'localbot-scheduler-e2e-delete',
        version: '0.1.0',
        userDataDir,
        workspaceRoot: userDataDir,
      });
      await rpc.send('bots/create', {
        name: 'cron-delete-bot',
        persona: '',
        workspace: userDataDir,
        allowlist: [],
      });
      await rpc.send('bots/update', {
        bot: 'cron-delete-bot',
        patch: { cron: '*/5 * * * *', cronEnabled: true, notifyOnError: true },
      });
      await new Promise((r) => setTimeout(r, 80));
      expect(readSchedules(userDataDir).schedules.find((s) => s.bot === 'cron-delete-bot')).toBeTruthy();
      await rpc.send('bots/delete', { bot: 'cron-delete-bot' });
      await new Promise((r) => setTimeout(r, 80));
      const sched = readSchedules(userDataDir);
      expect(sched.schedules.find((s) => s.bot === 'cron-delete-bot')).toBeUndefined();
      expect(fs.existsSync(path.join(userDataDir, 'bots', 'cron-delete-bot'))).toBe(false);
    } finally {
      abortController.abort();
      try { child.kill(); } catch { /* ignore */ }
      await fakeM3.close();
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
