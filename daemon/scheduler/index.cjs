// Phase 6: per-bot cron scheduler. Owns the cron timer evaluation for the
// daemon (AGENT-09). One croner task per enabled bot; state is persisted to
// <userData>/scheduler.json atomically (tmp + rename). The renderer never
// touches this file directly — it edits via bots/update which proxies here.
//
// Threat model coverage:
//   - T-P6-01: croner `protect: true` prevents two croner fires from
//     overlapping; cross-check against `ctx.activeRuns` blocks manual-vs-
//     scheduled conflicts.
//   - T-P6-03: atomic tmp + rename + serialized persistQueue.
//   - T-P6-04: NO per-tick audit entries; RunRecord close-time audit only.
//   - T-P6-08: ctx.activeRuns + activeRunBots cross-check before fire.
//   - T-P6-09: cron-fired runId is registered in BOTH maps BEFORE awaiting
//     runSendMessageCycle and removed in a finally block (AGENT-08 cancel
//     invariant).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// croner's CJS bundle exports {Cron, CronDate, CronPattern, scheduledJobs}.
// We load it via dynamic ESM import (croner's package.json has
// "type": "module"); once cached in module scope it's a free read.
let _croner = null;
async function ensureCroner() {
  if (!_croner) {
    _croner = await import('croner');
  }
  return _croner;
}

// In-memory state. `schedules` is keyed by bot id — one croner task per bot.
// `lastFire` is for UI display only; NEVER used for next-fire math
// (croner.nextRun() is canonical).
const schedules = new Map();
const lastFire = new Map();

// Per-bot config cache: {cron, enabled, notifyOnError} persisted to scheduler.json.
// The on-disk file is the authoritative state across daemon restarts.
const persistedState = new Map();

// Pitfall 12: serialize concurrent persistSchedules writes via a promise
// chain so the file is never written with interleaved bytes.
let persistQueue = Promise.resolve();

function schedulerPath(userDataDir) {
  return path.join(userDataDir, 'scheduler.json');
}

function readSchedulesFile(userDataDir) {
  try {
    const raw = fs.readFileSync(schedulerPath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.schedules)) {
      return parsed.schedules;
    }
    return [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    // Corrupt JSON — treat as empty (Pitfall: don't crash the daemon).
    if (e instanceof SyntaxError) return [];
    throw e;
  }
}

function persistSchedules(userDataDir) {
  // Atomic tmp + rename. Serialized so concurrent callers don't interleave.
  const job = persistQueue.then(async () => {
    const entries = [];
    for (const [bot, cfg] of persistedState.entries()) {
      const task = schedules.get(bot);
      const nextFireAt = task && typeof task.nextRun === 'function'
        ? (() => {
            const d = task.nextRun();
            return d ? new Date(d).toISOString() : null;
          })()
        : null;
      entries.push({
        bot,
        cron: cfg.cron,
        enabled: cfg.enabled,
        notifyOnError: cfg.notifyOnError,
        nextFireAt,
        lastFireAt: lastFire.get(bot) || null,
        updatedAt: new Date().toISOString(),
      });
    }
    const payload = JSON.stringify({ schedules: entries, updatedAt: new Date().toISOString() }, null, 2);
    const finalPath = schedulerPath(userDataDir);
    const tmp = `${finalPath}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, finalPath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
  }).catch(() => { /* keep chain alive */ });
  persistQueue = job;
  return job;
}

/**
 * loadScheduler(userDataDir, ctx) — read scheduler.json and rehydrate croner
 * tasks for every enabled entry. Idempotent; safe to call multiple times
 * (existing tasks are stopped first). Loads croner lazily.
 */
async function loadScheduler(userDataDir, ctx) {
  const { Cron } = await ensureCroner();
  const entries = readSchedulesFile(userDataDir);
  for (const entry of entries) {
    if (!entry || typeof entry.bot !== 'string' || entry.bot.length === 0) continue;
    // Back-compat (Pitfall 11): existing bots without notifyOnError default
    // to true so users get notified when a previously-scheduled bot errors.
    const notifyOnError = entry.notifyOnError === undefined ? true : !!entry.notifyOnError;
    persistedState.set(entry.bot, {
      cron: entry.cron || '',
      enabled: !!entry.enabled,
      notifyOnError,
    });
    if (entry.enabled && typeof entry.cron === 'string' && entry.cron.length > 0) {
      try {
        const task = new Cron(entry.cron, {
          protect: true,
          name: `bot:${entry.bot}`,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }, async () => onCronTick(userDataDir, entry.bot, ctx));
        schedules.set(entry.bot, task);
      } catch (e) {
        // Bad cron persisted — skip but don't crash the daemon.
        // eslint-disable-next-line no-console
        console.warn(`[scheduler] loadScheduler: invalid cron for bot=${entry.bot}: ${e.message}`);
      }
    }
  }
}

/**
 * upsertSchedule(userDataDir, bot, cronExpr, opts, ctx) — start or replace
 * the croner task for `bot`. If opts.enabled === false OR cronExpr is empty,
 * any existing schedule is removed. Invalid cron throws `{code:'invalid_cron'}`.
 */
async function upsertSchedule(userDataDir, bot, cronExpr, opts, ctx) {
  if (typeof userDataDir !== 'string' || userDataDir.length === 0) {
    throw Object.assign(new Error('userDataDir required'), { code: 'invalid_args' });
  }
  if (typeof bot !== 'string' || bot.length === 0) {
    throw Object.assign(new Error('bot required'), { code: 'invalid_args' });
  }
  const enabled = !!(opts && opts.enabled);
  const notifyOnError = opts && opts.notifyOnError === false ? false : true;

  // Persist state regardless of enabled flag — so a disabled schedule still
  // survives daemon restart as 'not running'.
  persistedState.set(bot, { cron: cronExpr || '', enabled, notifyOnError });

  // Stop existing task if any.
  const existing = schedules.get(bot);
  if (existing) {
    try { existing.stop(); } catch { /* ignore */ }
    schedules.delete(bot);
  }

  if (!enabled || !cronExpr || cronExpr.length === 0) {
    void persistSchedules(userDataDir);
    return;
  }

  const { Cron } = await ensureCroner();
  // Pitfall 1: synchronous try/catch — croner parses in the constructor.
  let task;
  try {
    task = new Cron(cronExpr, {
      protect: true,
      name: `bot:${bot}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, async () => onCronTick(userDataDir, bot, ctx));
  } catch (e) {
    throw Object.assign(
      new Error(`invalid cron expression: ${cronExpr}`),
      { code: 'invalid_cron', cause: e },
    );
  }
  schedules.set(bot, task);
  void persistSchedules(userDataDir);
}

/**
 * removeSchedule(userDataDir, bot) — stop the croner task, drop the
 * persisted entry. In-memory state is authoritative; the file write is
 * best-effort (Pitfall 8).
 */
function removeSchedule(userDataDir, bot) {
  const existing = schedules.get(bot);
  if (existing) {
    try { existing.stop(); } catch { /* ignore */ }
    schedules.delete(bot);
  }
  lastFire.delete(bot);
  persistedState.delete(bot);
  void persistSchedules(userDataDir);
}

/**
 * getNextFireAt(bot) — return the ISO string of the next fire time, or null.
 */
function getNextFireAt(bot) {
  const task = schedules.get(bot);
  if (!task || typeof task.nextRun !== 'function') return null;
  const d = task.nextRun();
  return d ? new Date(d).toISOString() : null;
}

/**
 * onCronTick(userDataDir, bot, ctx) — invoked by croner when the cron
 * fires. Cross-checks ctx.activeRuns for an in-progress run on this bot
 * (Pitfall 4 / T-P6-08); if found, logs an audit entry and drops the tick.
 *
 * Otherwise generates a UUID runId, registers an AbortController in BOTH
 * ctx.activeRuns and ctx.activeRunBots BEFORE awaiting the cycle (the
 * AGENT-08 cancellation prerequisite), invokes runSendMessageCycle, and
 * removes both entries in a finally block. On `errored` exit, emits a
 * `notification:scheduled-error` event if notifyOnError !== false.
 */
async function onCronTick(userDataDir, bot, ctx) {
  const startedAt = Date.now();
  if (!ctx || typeof ctx.runSendMessageCycle !== 'function') {
    return;
  }
  // Pitfall 4 / T-P6-08: block ticks when a manual run is already in flight.
  for (const [runId, runBot] of (ctx.activeRunBots || new Map()).entries()) {
    if (runBot === bot && (ctx.activeRuns || new Map()).has(runId)) {
      if (typeof ctx.appendAudit === 'function') {
        ctx.appendAudit({
          tool: 'scheduler.tick',
          bot,
          params: { outcome: 'skipped', reason: 'run_in_progress' },
          outcome: 'error',
          durationMs: Date.now() - startedAt,
        });
      }
      return;
    }
  }

  const runId = crypto.randomUUID();
  const controller = new AbortController();
  // Register BEFORE awaiting — bots/cancel looks up the AbortController by
  // runId in these maps (AGENT-08 invariant).
  ctx.activeRuns.set(runId, controller);
  ctx.activeRunBots.set(runId, bot);

  let cycle;
  try {
    // Read the scheduled prompt (may be undefined → use default).
    let prompt = '[Scheduled run] Perform your regular check-in.';
    try {
      if (typeof ctx.getBotScheduledPrompt === 'function') {
        const got = ctx.getBotScheduledPrompt(bot);
        if (typeof got === 'string' && got.length > 0) prompt = got;
      }
    } catch { /* fall back to default */ }

    // Broadcast running status so the sidebar updates.
    if (typeof ctx.sendNotification === 'function') {
      ctx.sendNotification('bot:status', {
        bot,
        status: 'running',
        runId,
        ts: new Date().toISOString(),
      });
    }

    cycle = await ctx.runSendMessageCycle(userDataDir, bot, prompt, runId, controller.signal);

    // RunRecord append — shape matches Phase 4 manual-trigger RunRecord.
    const record = {
      ts: new Date().toISOString(),
      runId,
      trigger: 'cron',
      durationMs: cycle.durationMs,
      exitReason: cycle.exitReason,
      messageCount: cycle.messageCount,
    };
    if (cycle.errorPayload) record.error = cycle.errorPayload;
    if (typeof ctx.appendRunRecord === 'function') {
      try {
        await ctx.appendRunRecord(userDataDir, bot, record);
      } catch { /* best-effort */ }
    }

    // Patch bot config status (mirror Phase 4 manual path).
    if (typeof ctx.writeConfigPatch === 'function') {
      try {
        ctx.writeConfigPatch(userDataDir, bot, {
          status: cycle.exitReason === 'completed' || cycle.exitReason === 'cancelled' ? 'idle' : 'errored',
          lastRunAt: record.ts,
          lastRunExitReason: cycle.exitReason,
          lastRunError: cycle.errorPayload ? cycle.errorPayload.message : undefined,
        });
      } catch { /* best-effort */ }
    }

    // Broadcast terminal status.
    if (typeof ctx.sendNotification === 'function') {
      ctx.sendNotification('bot:status', {
        bot,
        status: cycle.exitReason === 'completed' || cycle.exitReason === 'cancelled' ? 'idle' : 'errored',
        runId,
        ts: new Date().toISOString(),
      });
    }

    // Audit minimization (T-P6-04): single line on cycle close, no per-tick.
    if (typeof ctx.appendAudit === 'function') {
      ctx.appendAudit({
        tool: 'bots.run',
        bot,
        params: { runId, trigger: 'cron', messageCount: cycle.messageCount },
        outcome: cycle.exitReason === 'errored' ? 'error' : 'ok',
        durationMs: cycle.durationMs,
        error: cycle.errorPayload,
      });
    }

    // Notify on errored (AGENT-10) — opt-out via notifyOnError === false.
    const shouldNotify = cycle.exitReason === 'errored' &&
      typeof ctx.getBotNotifyOnError === 'function' &&
      ctx.getBotNotifyOnError(bot) !== false;
    if (shouldNotify && typeof ctx.sendNotification === 'function') {
      ctx.sendNotification('notification:scheduled-error', {
        bot,
        runId,
        errorMessage: cycle.errorPayload?.message ?? 'unknown error',
        ts: new Date().toISOString(),
      });
    }
  } catch (err) {
    // Outer catch — minimal audit.
    if (typeof ctx.appendAudit === 'function') {
      ctx.appendAudit({
        tool: 'bots.run',
        bot,
        params: { runId, trigger: 'cron' },
        outcome: 'error',
        durationMs: Date.now() - startedAt,
        error: { code: err.code || 'bots_run_failed', message: err.message },
      });
    }
  } finally {
    // Remove from both maps — matches Phase 4 manual-trigger pattern.
    ctx.activeRuns.delete(runId);
    ctx.activeRunBots.delete(runId);
    lastFire.set(bot, new Date().toISOString());
    void persistSchedules(userDataDir);
  }
}

/**
 * Test seams — exported for unit tests. NOT for production use.
 */
function __inspectSchedulerForTest__() {
  return {
    schedules: Array.from(schedules.entries()).map(([bot, task]) => ({
      bot,
      cron: persistedState.get(bot)?.cron || '',
      enabled: !!persistedState.get(bot)?.enabled,
      notifyOnError: persistedState.get(bot)?.notifyOnError !== false,
      isRunning: typeof task.isRunning === 'function' ? task.isRunning() : false,
      nextRun: typeof task.nextRun === 'function' ? task.nextRun() : null,
    })),
    persistedState: Array.from(persistedState.entries()).map(([bot, cfg]) => ({ bot, ...cfg })),
    lastFire: Array.from(lastFire.entries()).map(([bot, ts]) => ({ bot, ts })),
  };
}

function __resetForTest__() {
  for (const task of schedules.values()) {
    try { task.stop(); } catch { /* ignore */ }
  }
  schedules.clear();
  lastFire.clear();
  persistedState.clear();
  persistQueue = Promise.resolve();
}

async function __fireCronForTest__(bot) {
  // Manually invoke the cron tick handler (used by tests that don't want
  // to wait for real cron time). Returns the tick's promise.
  return onCronTick(arguments[1] || process.cwd(), bot, arguments[2]);
}

// Provide a convenience wrapper so __fireCronForTest__(bot, ctx) works.
async function __fireCronForTestWithCtx__(userDataDir, bot, ctx) {
  return onCronTick(userDataDir, bot, ctx);
}

module.exports = {
  loadScheduler,
  upsertSchedule,
  removeSchedule,
  getNextFireAt,
  // Test seams
  __inspectSchedulerForTest__,
  __resetForTest__,
  __fireCronForTest__: __fireCronForTestWithCtx__,
  _internal: { schedules, lastFire, persistedState, persistSchedules, readSchedulesFile, schedulerPath },
};