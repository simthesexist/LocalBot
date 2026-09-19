// Unit tests for the bots/update + bots/delete -> scheduler.json
// atomicity. Run with: npm test.
//
// Phase 6 Wave 1: spawns a real daemon subprocess and exercises the
// bots/update JSON-RPC path. Asserts that config.json AND scheduler.json
// are written in lock-step — invalid patches leave scheduler.json alone.
//
// Mirrors the spawn boilerplate from tests/unit/bot_crud.test.ts but with
// a fresh readline interface for each test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const childProcess = require_('node:child_process') as typeof import('node:child_process');
const readlineMod = require_('node:readline') as typeof import('node:readline');

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-bots-update-atomic-'));
}

interface DaemonHandle {
  send: (method: string, params?: Record<string, unknown>) => Promise<{
    jsonrpc: string;
    id: number;
    result?: unknown;
    error?: { code: string | number; message: string };
  }>;
  stop: () => Promise<void>;
  ready: () => Promise<void>;
}

function startDaemon(userDataDir: string): DaemonHandle {
  const daemonEntry = path.resolve(process.cwd(), 'daemon', 'main.cjs');
  const child = childProcess.spawn(process.execPath, [daemonEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LOCALBOT_USER_DATA_DIR: userDataDir },
  });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const rl = readlineMod.createInterface({ input: child.stdout! });
  let nextId = 1;
  let readyResolve: () => void = () => {};
  const readyP = new Promise<void>((res) => { readyResolve = res; });
  rl.on('line', (line: string) => {
    try {
      const obj = JSON.parse(line);
      if (obj && obj.kind === 'ready') {
        readyResolve();
        return;
      }
      if (typeof obj.id === 'number' && pending.has(obj.id)) {
        pending.get(obj.id)!.resolve(obj);
        pending.delete(obj.id);
      }
    } catch { /* ignore */ }
  });
  function send(method: string, params?: Record<string, unknown>) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  return {
    send,
    stop: async () => { try { child.kill(); } catch { /* ignore */ } },
    ready: () => readyP,
  };
}

function readSchedules(userDataDir: string): { schedules: Array<Record<string, unknown>> } {
  const p = path.join(userDataDir, 'scheduler.json');
  if (!fs.existsSync(p)) return { schedules: [] };
  const text = fs.readFileSync(p, 'utf8');
  if (!text.trim().length) return { schedules: [] };
  return JSON.parse(text);
}

function readAudit(userDataDir: string): Array<Record<string, unknown>> {
  const auditDir = path.join(userDataDir, 'audit');
  if (!fs.existsSync(auditDir)) return [];
  const files = fs.readdirSync(auditDir).filter((f) => f.endsWith('.jsonl'));
  const out: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(auditDir, f), 'utf8');
    for (const line of text.split('\n').filter(Boolean)) {
      try { out.push(JSON.parse(line)); } catch { /* ignore */ }
    }
  }
  return out;
}

let userDataDir = '';
let daemon: DaemonHandle | null = null;
beforeEach(() => {
  userDataDir = mkTmp();
});
afterEach(async () => {
  if (daemon) {
    await daemon.stop();
    daemon = null;
  }
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('bots/update atomicity (config.json + scheduler.json)', () => {
  it('writes BOTH config.json and scheduler.json on a successful update with cron + cronEnabled', async () => {
    daemon = startDaemon(userDataDir);
    await daemon.ready();
    await daemon.send('initialize', { userDataDir });
    await daemon.send('bots/create', { name: 'atomic-bot', allowlist: [] });
    const upd = await daemon.send('bots/update', {
      bot: 'atomic-bot',
      patch: {
        cron: '*/5 * * * *',
        cronEnabled: true,
        notifyOnError: true,
        scheduledPrompt: 'check inbox',
      },
    });
    expect(upd.error).toBeUndefined();
    // Allow the async persistQueue to flush.
    await new Promise((r) => setTimeout(r, 50));
    const cfgPath = path.join(userDataDir, 'bots', 'atomic-bot', 'config.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'scheduler.json'))).toBe(true);
    const sched = readSchedules(userDataDir);
    const entry = sched.schedules.find((s) => s.bot === 'atomic-bot');
    expect(entry).toBeTruthy();
    expect(entry!.cron).toBe('*/5 * * * *');
    expect(entry!.enabled).toBe(true);
    expect(entry!.notifyOnError).toBe(true);
  });

  it('bots/update with cron:bad rejects with invalid_cron; scheduler.json does NOT gain the entry', async () => {
    daemon = startDaemon(userDataDir);
    await daemon.ready();
    await daemon.send('initialize', { userDataDir });
    await daemon.send('bots/create', { name: 'bad-cron-bot', allowlist: [] });
    // Establish baseline: confirm scheduler.json does not exist yet.
    const schedPath = path.join(userDataDir, 'scheduler.json');
    expect(fs.existsSync(schedPath)).toBe(false);
    const upd = await daemon.send('bots/update', {
      bot: 'bad-cron-bot',
      patch: { cron: 'bad cron', cronEnabled: true, notifyOnError: true },
    });
    expect(upd.error).toBeTruthy();
    expect(upd.error!.code).toBe('invalid_cron');
    // scheduler.json still does not exist — writeConfigPatch threw first.
    expect(fs.existsSync(schedPath)).toBe(false);
  });

  it('bots/update with notifyOnError:string rejects with invalid_config; scheduler.json unchanged', async () => {
    daemon = startDaemon(userDataDir);
    await daemon.ready();
    await daemon.send('initialize', { userDataDir });
    await daemon.send('bots/create', { name: 'bad-type-bot', allowlist: [] });
    const upd = await daemon.send('bots/update', {
      bot: 'bad-type-bot',
      patch: { cron: '*/5 * * * *', cronEnabled: true, notifyOnError: 'true' },
    });
    expect(upd.error).toBeTruthy();
    expect(upd.error!.code).toBe('invalid_config');
    expect(fs.existsSync(path.join(userDataDir, 'scheduler.json'))).toBe(false);
  });

  it('bots/update with cronEnabled:false removes the schedule from scheduler.json', async () => {
    daemon = startDaemon(userDataDir);
    await daemon.ready();
    await daemon.send('initialize', { userDataDir });
    await daemon.send('bots/create', { name: 'toggle-bot', allowlist: [] });
    await daemon.send('bots/update', {
      bot: 'toggle-bot',
      patch: { cron: '*/5 * * * *', cronEnabled: true, notifyOnError: true },
    });
    await new Promise((r) => setTimeout(r, 50));
    let sched = readSchedules(userDataDir);
    expect(sched.schedules.find((s) => s.bot === 'toggle-bot')).toBeTruthy();
    // Now disable.
    await daemon.send('bots/update', {
      bot: 'toggle-bot',
      patch: { cronEnabled: false },
    });
    await new Promise((r) => setTimeout(r, 50));
    sched = readSchedules(userDataDir);
    const entry = sched.schedules.find((s) => s.bot === 'toggle-bot');
    expect(entry).toBeTruthy(); // still in the persisted state
    expect(entry!.enabled).toBe(false); // but marked disabled
  });

  it('bots/delete removes the schedule from scheduler.json and the rehydrated load does not include it', async () => {
    daemon = startDaemon(userDataDir);
    await daemon.ready();
    await daemon.send('initialize', { userDataDir });
    await daemon.send('bots/create', { name: 'doomed-bot', allowlist: [] });
    await daemon.send('bots/update', {
      bot: 'doomed-bot',
      patch: { cron: '*/5 * * * *', cronEnabled: true, notifyOnError: true },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(readSchedules(userDataDir).schedules.find((s) => s.bot === 'doomed-bot')).toBeTruthy();
    // Now delete the bot — schedule must be removed from scheduler.json.
    await daemon.send('bots/delete', { bot: 'doomed-bot' });
    await new Promise((r) => setTimeout(r, 50));
    const schedAfterDelete = readSchedules(userDataDir);
    expect(schedAfterDelete.schedules.find((s) => s.bot === 'doomed-bot')).toBeUndefined();
    // The bot config directory must also be gone.
    expect(fs.existsSync(path.join(userDataDir, 'bots', 'doomed-bot'))).toBe(false);
  });

  it('bots/update with NO schedule-related keys still writes config.json; audit line has changedKeys only', async () => {
    daemon = startDaemon(userDataDir);
    await daemon.ready();
    await daemon.send('initialize', { userDataDir });
    await daemon.send('bots/create', { name: 'audit-bot', allowlist: ['read_file'] });
    await daemon.send('bots/update', {
      bot: 'audit-bot',
      patch: { name: 'Renamed Audit Bot' },
    });
    await new Promise((r) => setTimeout(r, 100));
    // Audit minimization: changedKeys only, no patch contents.
    const lines = readAudit(userDataDir).filter((l) => l.tool === 'bots.update' && l.outcome === 'ok');
    expect(lines.length).toBeGreaterThan(0);
    const params = lines[lines.length - 1].params as Record<string, unknown>;
    expect(params.changedKeys).toEqual(['name']);
    expect(params.name).toBeUndefined();
    expect(params.cron).toBeUndefined();
  });
});