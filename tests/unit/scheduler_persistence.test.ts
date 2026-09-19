// Unit tests for scheduler.json persistence. Run with: npm test.
//
// Phase 6 Wave 1: covers AGENT-09 scheduler.json atomic write + reload
// invariants. Each test uses a fresh mkdtemp workspace and resets the
// in-memory scheduler state via __resetForTest__.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const scheduler = require_('../../daemon/scheduler/index.cjs') as {
  loadScheduler: (userDataDir: string, ctx: unknown) => Promise<void>;
  upsertSchedule: (userDataDir: string, bot: string, cron: string, opts: Record<string, unknown>, ctx: unknown) => Promise<void>;
  removeSchedule: (userDataDir: string, bot: string) => void;
  __inspectSchedulerForTest__: () => {
    schedules: Array<{ bot: string; cron: string; enabled: boolean; notifyOnError: boolean; isRunning: boolean; nextRun: Date | null }>;
    persistedState: Array<{ bot: string; cron: string; enabled: boolean; notifyOnError: boolean }>;
    lastFire: Array<{ bot: string; ts: string }>;
  };
  __resetForTest__: () => void;
  __fireCronForTest__: (userDataDir: string, bot: string, ctx: unknown) => Promise<void>;
};

const loader = require_('../../daemon/bots/loader.cjs') as {
  writeConfig: (userDataDir: string, bot: string, cfg: Record<string, unknown>) => Record<string, unknown>;
  writeConfigPatch: (userDataDir: string, bot: string, patch: Record<string, unknown>) => Record<string, unknown>;
};

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-sched-persist-'));
}

function readSchedulesFile(userDataDir: string): { schedules: Array<Record<string, unknown>>; updatedAt: string } {
  const text = fs.readFileSync(path.join(userDataDir, 'scheduler.json'), 'utf8');
  return JSON.parse(text);
}

function makeCtx(): Record<string, unknown> {
  return {
    activeRuns: new Map(),
    activeRunBots: new Map(),
    appendAudit: () => {},
    sendNotification: () => {},
    runSendMessageCycle: async () => ({ exitReason: 'completed', messageCount: 0, durationMs: 0 }),
    getBotScheduledPrompt: () => '[test]',
    getBotNotifyOnError: () => true,
  };
}

let userDataDir = '';
beforeEach(() => {
  userDataDir = mkTmp();
  scheduler.__resetForTest__();
});
afterEach(() => {
  scheduler.__resetForTest__();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('scheduler.json atomic persistence', () => {
  it('writes scheduler.json after the first upsertSchedule with valid cron + enabled:true', async () => {
    // Seed bot config so getBotNotifyOnError/getBotScheduledPrompt could read it.
    loader.writeConfig(userDataDir, 'bot-a', {
      id: 'bot-a', name: 'Bot A', schemaVersion: 1, allowlist: [],
      notifyOnError: true,
    });
    await scheduler.upsertSchedule(userDataDir, 'bot-a', '*/15 * * * *', { enabled: true, notifyOnError: true }, makeCtx());
    // persistQueue is async — wait one tick to flush.
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(path.join(userDataDir, 'scheduler.json'))).toBe(true);
    const parsed = readSchedulesFile(userDataDir);
    expect(parsed.schedules).toHaveLength(1);
    expect(parsed.schedules[0]).toMatchObject({
      bot: 'bot-a',
      cron: '*/15 * * * *',
      enabled: true,
      notifyOnError: true,
    });
    expect(typeof parsed.schedules[0].nextFireAt).toBe('string');
    expect(parsed.schedules[0].lastFireAt).toBeNull();
  });

  it('writes the file atomically: renameSync moves the tmp into place (no partial bytes)', async () => {
    await scheduler.upsertSchedule(userDataDir, 'bot-a', '*/5 * * * *', { enabled: true, notifyOnError: true }, makeCtx());
    // Read immediately: either old content or new content — never partial bytes.
    const text = fs.readFileSync(path.join(userDataDir, 'scheduler.json'), 'utf8');
    expect(() => JSON.parse(text)).not.toThrow();
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed.schedules)).toBe(true);
  });

  it('loadScheduler rehydrates croner tasks from a persisted file (survives daemon restart)', async () => {
    await scheduler.upsertSchedule(userDataDir, 'bot-a', '*/5 * * * *', { enabled: true, notifyOnError: true }, makeCtx());
    await scheduler.upsertSchedule(userDataDir, 'bot-b', '*/10 * * * *', { enabled: true, notifyOnError: false }, makeCtx());
    await new Promise((r) => setTimeout(r, 20));
    // Reset in-memory state to simulate daemon restart.
    scheduler.__resetForTest__();
    expect(scheduler.__inspectSchedulerForTest__().schedules).toHaveLength(0);
    await scheduler.loadScheduler(userDataDir, makeCtx());
    const insp = scheduler.__inspectSchedulerForTest__();
    expect(insp.schedules).toHaveLength(2);
    const a = insp.schedules.find((s) => s.bot === 'bot-a');
    const b = insp.schedules.find((s) => s.bot === 'bot-b');
    expect(a).toBeTruthy();
    expect(a!.cron).toBe('*/5 * * * *');
    expect(a!.notifyOnError).toBe(true);
    expect(b).toBeTruthy();
    expect(b!.cron).toBe('*/10 * * * *');
    expect(b!.notifyOnError).toBe(false);
  });

  it('corrupt JSON in scheduler.json is treated as empty (does not crash loadScheduler)', async () => {
    fs.writeFileSync(path.join(userDataDir, 'scheduler.json'), 'not json {{{', 'utf8');
    await expect(scheduler.loadScheduler(userDataDir, makeCtx())).resolves.toBeUndefined();
    expect(scheduler.__inspectSchedulerForTest__().schedules).toHaveLength(0);
    // Next upsertSchedule overwrites the corrupt file cleanly.
    await scheduler.upsertSchedule(userDataDir, 'bot-a', '*/5 * * * *', { enabled: true, notifyOnError: true }, makeCtx());
    await new Promise((r) => setTimeout(r, 20));
    const parsed = readSchedulesFile(userDataDir);
    expect(parsed.schedules).toHaveLength(1);
  });

  it('removeSchedule deletes the entry from the persisted file on next flush', async () => {
    await scheduler.upsertSchedule(userDataDir, 'bot-a', '*/5 * * * *', { enabled: true, notifyOnError: true }, makeCtx());
    await scheduler.upsertSchedule(userDataDir, 'bot-b', '*/10 * * * *', { enabled: true, notifyOnError: true }, makeCtx());
    await new Promise((r) => setTimeout(r, 20));
    scheduler.removeSchedule(userDataDir, 'bot-a');
    await new Promise((r) => setTimeout(r, 20));
    const parsed = readSchedulesFile(userDataDir);
    expect(parsed.schedules).toHaveLength(1);
    expect(parsed.schedules[0].bot).toBe('bot-b');
    // Re-load: bot-a must NOT be rehydrated.
    scheduler.__resetForTest__();
    await scheduler.loadScheduler(userDataDir, makeCtx());
    const insp = scheduler.__inspectSchedulerForTest__();
    expect(insp.schedules.find((s) => s.bot === 'bot-a')).toBeUndefined();
    expect(insp.schedules.find((s) => s.bot === 'bot-b')).toBeTruthy();
  });

  it('concurrent upserts (5 in parallel) all succeed and produce a valid JSON file with all 5 bots (Pitfall 12)', async () => {
    const ctx = makeCtx();
    const upserts = [
      scheduler.upsertSchedule(userDataDir, 'bot-1', '*/1 * * * *', { enabled: true, notifyOnError: true }, ctx),
      scheduler.upsertSchedule(userDataDir, 'bot-2', '*/2 * * * *', { enabled: true, notifyOnError: true }, ctx),
      scheduler.upsertSchedule(userDataDir, 'bot-3', '*/3 * * * *', { enabled: true, notifyOnError: true }, ctx),
      scheduler.upsertSchedule(userDataDir, 'bot-4', '*/4 * * * *', { enabled: true, notifyOnError: true }, ctx),
      scheduler.upsertSchedule(userDataDir, 'bot-5', '*/5 * * * *', { enabled: true, notifyOnError: true }, ctx),
    ];
    await Promise.all(upserts);
    await new Promise((r) => setTimeout(r, 30));
    const parsed = readSchedulesFile(userDataDir);
    const botIds = parsed.schedules.map((s) => s.bot).sort();
    expect(botIds).toEqual(['bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5']);
  });

  it('schedule with enabled:false is persisted but NOT rehydrated as a croner task', async () => {
    await scheduler.upsertSchedule(userDataDir, 'bot-a', '*/5 * * * *', { enabled: true, notifyOnError: true }, makeCtx());
    await scheduler.upsertSchedule(userDataDir, 'bot-b', '*/10 * * * *', { enabled: false, notifyOnError: true }, makeCtx());
    await new Promise((r) => setTimeout(r, 20));
    const parsed = readSchedulesFile(userDataDir);
    const bEntry = parsed.schedules.find((s) => s.bot === 'bot-b');
    expect(bEntry).toBeTruthy();
    expect(bEntry!.enabled).toBe(false);
    // Reset + reload — only bot-a should be rehydrated as a croner task.
    scheduler.__resetForTest__();
    await scheduler.loadScheduler(userDataDir, makeCtx());
    const insp = scheduler.__inspectSchedulerForTest__();
    expect(insp.schedules).toHaveLength(1);
    expect(insp.schedules[0].bot).toBe('bot-a');
  });

  it('lastFireAt is null on first persist; after one tick it becomes a non-null ISO', async () => {
    await scheduler.upsertSchedule(userDataDir, 'bot-a', '*/5 * * * *', { enabled: true, notifyOnError: true }, makeCtx());
    await new Promise((r) => setTimeout(r, 20));
    const before = readSchedulesFile(userDataDir);
    expect(before.schedules[0].lastFireAt).toBeNull();
    // Fire one tick.
    await scheduler.__fireCronForTest__(userDataDir, 'bot-a', makeCtx());
    await new Promise((r) => setTimeout(r, 20));
    const after = readSchedulesFile(userDataDir);
    expect(after.schedules[0].lastFireAt).toBeTruthy();
    // ISO timestamp shape.
    expect(after.schedules[0].lastFireAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});