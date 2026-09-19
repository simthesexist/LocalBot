// Unit tests for the daemon scheduler tick handler. Run with: npm test.
//
// Phase 6 Wave 1: covers AGENT-09 (cron fire) + AGENT-10 (scheduled-error
// notification). Tests exercise the scheduler module's public surface:
// upsertSchedule / removeSchedule / getNextFireAt / onCronTick (via the
// __fireCronForTest__ seam).
//
// We use croner with a '*/1 * * * *' expression for the schedule start
// tests, but the cron-TICK behaviour (cross-check, registration, audit,
// notification) is exercised by directly invoking onCronTick so the tests
// don't depend on real wall-clock time.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const scheduler = require_('../../daemon/scheduler/index.cjs') as {
  loadScheduler: (userDataDir: string, ctx: unknown) => Promise<void>;
  upsertSchedule: (userDataDir: string, bot: string, cron: string, opts: Record<string, unknown>, ctx: unknown) => Promise<void>;
  removeSchedule: (userDataDir: string, bot: string) => void;
  getNextFireAt: (bot: string) => string | null;
  __fireCronForTest__: (userDataDir: string, bot: string, ctx: unknown) => Promise<void>;
  __inspectSchedulerForTest__: () => {
    schedules: Array<{ bot: string; cron: string; enabled: boolean; notifyOnError: boolean; isRunning: boolean; nextRun: Date | null }>;
    persistedState: Array<{ bot: string; cron: string; enabled: boolean; notifyOnError: boolean }>;
    lastFire: Array<{ bot: string; ts: string }>;
  };
  __resetForTest__: () => void;
};

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-scheduler-tick-'));
}

function makeCtx(overrides: Record<string, unknown> = {}): {
  activeRuns: Map<string, AbortController>;
  activeRunBots: Map<string, string>;
  appendAudit: ReturnType<typeof vi.fn>;
  sendNotification: ReturnType<typeof vi.fn>;
  runSendMessageCycle: ReturnType<typeof vi.fn>;
  getBotScheduledPrompt: (bot: string) => string;
  getBotNotifyOnError: (bot: string) => boolean;
} {
  const activeRuns = new Map<string, AbortController>();
  const activeRunBots = new Map<string, string>();
  return {
    activeRuns,
    activeRunBots,
    appendAudit: vi.fn(),
    sendNotification: vi.fn(),
    runSendMessageCycle: vi.fn().mockResolvedValue({
      exitReason: 'completed',
      messageCount: 2,
      durationMs: 500,
    }),
    getBotScheduledPrompt: () => '[test scheduled prompt]',
    getBotNotifyOnError: () => true,
    ...overrides,
  } as any;
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

describe('upsertSchedule + croner task lifecycle', () => {
  it('starts a croner task for a valid cron expression and surfaces nextRun()', async () => {
    const ctx = makeCtx();
    await scheduler.upsertSchedule(userDataDir, 'bot-a', '*/1 * * * *', { enabled: true, notifyOnError: true }, ctx);
    const insp = scheduler.__inspectSchedulerForTest__();
    const entry = insp.schedules.find((s) => s.bot === 'bot-a');
    expect(entry).toBeTruthy();
    expect(entry!.cron).toBe('*/1 * * * *');
    expect(entry!.enabled).toBe(true);
    expect(entry!.notifyOnError).toBe(true);
    // nextRun should be a Date within 60 seconds of now (every-minute cron).
    expect(entry!.nextRun).toBeTruthy();
    const delta = entry!.nextRun!.getTime() - Date.now();
    expect(delta).toBeGreaterThan(-1_000);
    expect(delta).toBeLessThan(61_000);
  });

  it('throws code:invalid_cron when the cron expression is malformed', async () => {
    const ctx = makeCtx();
    await expect(
      scheduler.upsertSchedule(userDataDir, 'bad-bot', 'not a cron', { enabled: true, notifyOnError: true }, ctx),
    ).rejects.toMatchObject({ code: 'invalid_cron' });
    const insp = scheduler.__inspectSchedulerForTest__();
    expect(insp.schedules.find((s) => s.bot === 'bad-bot')).toBeUndefined();
  });

  it('removeSchedule stops the croner task and clears nextFireAt', async () => {
    const ctx = makeCtx();
    await scheduler.upsertSchedule(userDataDir, 'bot-a', '*/5 * * * *', { enabled: true, notifyOnError: true }, ctx);
    expect(scheduler.getNextFireAt('bot-a')).toBeTruthy();
    scheduler.removeSchedule(userDataDir, 'bot-a');
    expect(scheduler.getNextFireAt('bot-a')).toBeNull();
    const insp = scheduler.__inspectSchedulerForTest__();
    expect(insp.schedules.find((s) => s.bot === 'bot-a')).toBeUndefined();
  });

  it('upserting the same bot twice replaces the task (protect:true semantics)', async () => {
    const ctx = makeCtx();
    await scheduler.upsertSchedule(userDataDir, 'bot-a', '*/1 * * * *', { enabled: true, notifyOnError: true }, ctx);
    await scheduler.upsertSchedule(userDataDir, 'bot-a', '*/2 * * * *', { enabled: true, notifyOnError: false }, ctx);
    const insp = scheduler.__inspectSchedulerForTest__();
    const entries = insp.schedules.filter((s) => s.bot === 'bot-a');
    expect(entries).toHaveLength(1); // replaced, not duplicated
    expect(entries[0].cron).toBe('*/2 * * * *');
    expect(entries[0].notifyOnError).toBe(false);
  });

  it('upserting with enabled:false removes any existing schedule and persists as disabled', async () => {
    const ctx = makeCtx();
    await scheduler.upsertSchedule(userDataDir, 'bot-a', '*/1 * * * *', { enabled: true, notifyOnError: true }, ctx);
    await scheduler.upsertSchedule(userDataDir, 'bot-a', '', { enabled: false, notifyOnError: true }, ctx);
    expect(scheduler.getNextFireAt('bot-a')).toBeNull();
    const insp = scheduler.__inspectSchedulerForTest__();
    const persisted = insp.persistedState.find((s) => s.bot === 'bot-a');
    expect(persisted).toBeTruthy();
    expect(persisted!.enabled).toBe(false);
  });
});

describe('onCronTick behaviour (cross-check + registration + audit + notify)', () => {
  it('calls runSendMessageCycle with a UUID runId when activeRuns is empty', async () => {
    const ctx = makeCtx();
    await scheduler.__fireCronForTest__(userDataDir, 'bot-a', ctx);
    expect(ctx.runSendMessageCycle).toHaveBeenCalledTimes(1);
    const args = ctx.runSendMessageCycle.mock.calls[0];
    // signature: (userDataDir, bot, prompt, runId, signal)
    expect(args[0]).toBe(userDataDir);
    expect(args[1]).toBe('bot-a');
    expect(args[2]).toBe('[test scheduled prompt]');
    expect(typeof args[3]).toBe('string');
    expect(args[3]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(args[4]).toBeInstanceOf(AbortSignal);
    // No skip audit was written.
    const tickAudit = ctx.appendAudit.mock.calls.find((c: any[]) => c[0]?.tool === 'scheduler.tick');
    expect(tickAudit).toBeUndefined();
  });

  it('skips the tick + logs scheduler.tick audit when activeRuns has the same bot', async () => {
    const ctx = makeCtx();
    const controller = new AbortController();
    const existingRunId = 'pre-existing-run';
    ctx.activeRuns.set(existingRunId, controller);
    ctx.activeRunBots.set(existingRunId, 'bot-a');
    await scheduler.__fireCronForTest__(userDataDir, 'bot-a', ctx);
    expect(ctx.runSendMessageCycle).not.toHaveBeenCalled();
    const tickAudit = ctx.appendAudit.mock.calls.find((c: any[]) => c[0]?.tool === 'scheduler.tick');
    expect(tickAudit).toBeTruthy();
    expect(tickAudit[0]).toMatchObject({
      tool: 'scheduler.tick',
      bot: 'bot-a',
      outcome: 'error',
      params: { outcome: 'skipped', reason: 'run_in_progress' },
    });
  });

  it('still fires when activeRuns has a run for a DIFFERENT bot', async () => {
    const ctx = makeCtx();
    const otherController = new AbortController();
    ctx.activeRuns.set('other-run', otherController);
    ctx.activeRunBots.set('other-run', 'bot-b');
    await scheduler.__fireCronForTest__(userDataDir, 'bot-a', ctx);
    expect(ctx.runSendMessageCycle).toHaveBeenCalledTimes(1);
    expect(ctx.runSendMessageCycle.mock.calls[0][1]).toBe('bot-a');
  });

  it('emits notification:scheduled-error on errored cycle + notifyOnError !== false', async () => {
    const ctx = makeCtx({
      runSendMessageCycle: vi.fn().mockResolvedValue({
        exitReason: 'errored',
        errorPayload: { code: 'cycle_failed', message: 'boom' },
        messageCount: 0,
        durationMs: 50,
      }),
      getBotNotifyOnError: () => true,
    });
    await scheduler.__fireCronForTest__(userDataDir, 'bot-a', ctx);
    const notif = ctx.sendNotification.mock.calls.find((c: any[]) => c[0] === 'notification:scheduled-error');
    expect(notif).toBeTruthy();
    expect(notif[1]).toMatchObject({
      bot: 'bot-a',
      errorMessage: 'boom',
    });
    expect(typeof notif[1].runId).toBe('string');
    expect(typeof notif[1].ts).toBe('string');
  });

  it('does NOT emit notification:scheduled-error when notifyOnError === false', async () => {
    const ctx = makeCtx({
      runSendMessageCycle: vi.fn().mockResolvedValue({
        exitReason: 'errored',
        errorPayload: { code: 'cycle_failed', message: 'silent failure' },
        messageCount: 0,
        durationMs: 50,
      }),
      getBotNotifyOnError: () => false,
    });
    await scheduler.__fireCronForTest__(userDataDir, 'bot-a', ctx);
    const notif = ctx.sendNotification.mock.calls.find((c: any[]) => c[0] === 'notification:scheduled-error');
    expect(notif).toBeUndefined();
  });

  it('does NOT emit notification:scheduled-error when the cycle completes', async () => {
    const ctx = makeCtx(); // default mock returns exitReason: 'completed'
    await scheduler.__fireCronForTest__(userDataDir, 'bot-a', ctx);
    const notif = ctx.sendNotification.mock.calls.find((c: any[]) => c[0] === 'notification:scheduled-error');
    expect(notif).toBeUndefined();
  });

  it('registers the AbortController in activeRuns + activeRunBots BEFORE awaiting runSendMessageCycle, and removes both in finally (AGENT-08 invariant)', async () => {
    let resolveCycle: (v: unknown) => void = () => {};
    const cyclePromise = new Promise((resolve) => { resolveCycle = resolve; });
    const ctx = makeCtx({
      runSendMessageCycle: vi.fn().mockReturnValue(cyclePromise),
    });
    const firePromise = scheduler.__fireCronForTest__(userDataDir, 'bot-a', ctx);
    // Allow the tick handler to reach the await point.
    await new Promise((r) => setImmediate(r));
    expect(ctx.runSendMessageCycle).toHaveBeenCalledTimes(1);
    // Both maps should now contain the runId → AbortController mapping.
    expect(ctx.activeRuns.size).toBe(1);
    expect(ctx.activeRunBots.size).toBe(1);
    const [runId] = Array.from(ctx.activeRuns.keys());
    expect(ctx.activeRuns.get(runId)).toBeInstanceOf(AbortController);
    expect(ctx.activeRunBots.get(runId)).toBe('bot-a');
    // Resolve the cycle; the finally block must clear both maps.
    resolveCycle({ exitReason: 'completed', messageCount: 1, durationMs: 10 });
    await firePromise;
    expect(ctx.activeRuns.has(runId)).toBe(false);
    expect(ctx.activeRunBots.has(runId)).toBe(false);
  });

  it('removes both map entries even when runSendMessageCycle throws', async () => {
    const ctx = makeCtx({
      runSendMessageCycle: vi.fn().mockRejectedValue(new Error('boom')),
    });
    await scheduler.__fireCronForTest__(userDataDir, 'bot-a', ctx);
    expect(ctx.activeRuns.size).toBe(0);
    expect(ctx.activeRunBots.size).toBe(0);
  });

  it('stamps a single bots.run audit line on cycle close with trigger:cron', async () => {
    const ctx = makeCtx();
    await scheduler.__fireCronForTest__(userDataDir, 'bot-a', ctx);
    const auditCalls = ctx.appendAudit.mock.calls.filter((c: any[]) => c[0]?.tool === 'bots.run');
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0][0]).toMatchObject({
      tool: 'bots.run',
      bot: 'bot-a',
      outcome: 'ok',
      params: { trigger: 'cron', messageCount: 2 },
    });
    // No per-tick scheduler.tick entry on the success path.
    const tickCalls = ctx.appendAudit.mock.calls.filter((c: any[]) => c[0]?.tool === 'scheduler.tick');
    expect(tickCalls).toHaveLength(0);
  });
});