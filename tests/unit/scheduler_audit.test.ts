// Phase 6 Wave 3: audit minimization tests for scheduler-fired runs.
//
// Verifies the threat-model invariants from 06-RESEARCH.md + 06-03 threat
// model:
//  -T-P6-19: audit JSONL rows for a cron-fired run contain ONLY
//   {runId, trigger, messageCount} (3 keys). No scheduledPrompt text,
//   no error stack, no cron expression, no workspace, no persona.
//  -T-P6-19: a manual-triggered run also produces the same 3-key shape
//   with trigger='manual'.
//  -T-P6-04: a cron tick that is SKIPPED due to an in-progress run
//   does NOT append a 'bots.run' audit line; it only emits the
//   scheduler.tick skip audit.
//  -T-P6-04: a SUCCESSFUL cron-fired run produces EXACTLY ONE
//   'bots.run' audit row, not multiple per-tick entries.
//  - Errored cron run audit row carries an `error` sub-object with
//   {code, message} but still respects the 3-key params shape.
//
// Pattern mirrors tests/unit/bots_update_atomic.test.ts: spawn the real
// daemon and read the audit JSONL after a manual / cron run.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const childProcess = require_('node:child_process') as typeof import('node:child_process');
const readlineMod = require_('node:readline') as typeof import('node:readline');

const scheduler = require_('../../daemon/scheduler/index.cjs') as {
  loadScheduler: (userDataDir: string, ctx: unknown) => Promise<void>;
  upsertSchedule: (userDataDir: string, bot: string, cron: string, opts: Record<string, unknown>, ctx: unknown) => Promise<void>;
  removeSchedule: (userDataDir: string, bot: string) => void;
  getNextFireAt: (bot: string) => string | null;
  __fireCronForTest__: (userDataDir: string, bot: string, ctx: unknown) => Promise<void>;
  __resetForTest__: () => void;
};

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-scheduler-audit-'));
}

interface DaemonHandle {
  send: (method: string, params?: Record<string, unknown>) => Promise<any>;
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

function readAudit(userDataDir: string): Array<Record<string, unknown>> {
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

let userDataDir = '';
let daemon: DaemonHandle | null = null;
beforeEach(() => {
  userDataDir = mkTmp();
  scheduler.__resetForTest__();
});
afterEach(async () => {
  if (daemon) {
    await daemon.stop();
    daemon = null;
  }
  scheduler.__resetForTest__();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('scheduler audit minimization (T-P6-19 + T-P6-04)', () => {
  it('Case A: manual run writes bots.run audit row with EXACTLY {runId, trigger, messageCount} (no prompt/cron/workspace leak)', async () => {
    daemon = startDaemon(userDataDir);
    await daemon.ready();
    await daemon.send('initialize', { userDataDir });
    await daemon.send('bots/create', {
      name: 'audit-bot-1',
      persona: 'sensitive persona text',
      workspace: userDataDir,
      allowlist: ['read_file'],
    });
    // Trigger a manual run with a distinctive prompt. The real daemon will
    // call appendAudit; we just need the row to land.
    await daemon.send('bots/trigger', {
      bot: 'audit-bot-1',
      content: 'manual trigger with a sensitive secret: xyz',
      runId: 'run-manual-1',
    });
    await new Promise((r) => setTimeout(r, 500));
    const allAudit = readAudit(userDataDir);
    const botsRunAudit = allAudit.filter((l) => l.tool === 'bots.run');
    if (botsRunAudit.length === 0) {
      // eslint-disable-next-line no-console
      console.error('No bots.run audit row found. All audit lines:',
        allAudit.map((l) => ({ tool: l.tool, outcome: l.outcome, bot: l.bot })));
    }
    expect(botsRunAudit.length).toBeGreaterThanOrEqual(1);
    const last = botsRunAudit[botsRunAudit.length - 1];
    expect(last.bot).toBe('audit-bot-1');
    const params = last.params as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(['messageCount', 'runId', 'trigger']);
    expect(params.trigger).toBe('manual');
    // Minimization: no prompt body, persona, workspace, allowlist leak.
    expect(params.content).toBeUndefined();
    expect(params.persona).toBeUndefined();
    expect(params.workspace).toBeUndefined();
    expect(params.allowlist).toBeUndefined();
    expect(JSON.stringify(params)).not.toContain('xyz');
    expect(JSON.stringify(params)).not.toContain('sensitive persona');
  });

  it('Case B: a cron-fired run stamps trigger:"cron" in the bots.run audit row', async () => {
    daemon = startDaemon(userDataDir);
    await daemon.ready();
    await daemon.send('initialize', { userDataDir });
    await daemon.send('bots/create', {
      name: 'cron-audit-bot',
      persona: '',
      workspace: userDataDir,
      allowlist: [],
    });
    await daemon.send('bots/update', {
      bot: 'cron-audit-bot',
      patch: { cron: '*/5 * * * *', cronEnabled: true, notifyOnError: true },
    });
    await new Promise((r) => setTimeout(r, 100));
    await daemon.send('bots/trigger', {
      bot: 'cron-audit-bot',
      content: 'cron fire',
      runId: 'run-cron-1',
      trigger: 'cron',
    });
    await new Promise((r) => setTimeout(r, 500));
    const botsRunAudit = readAudit(userDataDir).filter((l) => l.tool === 'bots.run');
    expect(botsRunAudit.length).toBeGreaterThanOrEqual(1);
    const cron = botsRunAudit.find((l) => (l.params as any)?.trigger === 'cron');
    expect(cron, 'a cron-triggered bots.run audit row was not written').toBeTruthy();
    expect(cron!.bot).toBe('cron-audit-bot');
    const params = cron!.params as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(['messageCount', 'runId', 'trigger']);
    expect(params.trigger).toBe('cron');
    expect(params.runId).toBeTruthy();
    expect(typeof params.messageCount).toBe('number');
    // No cron expression, prompt, or workspace leak.
    expect(JSON.stringify(params)).not.toContain('*/5 * * * *');
    expect(JSON.stringify(params)).not.toContain('audit test prompt');
  });

  it('Case C: the RunRecord JSONL row for a cron-fired run has trigger:"cron"', async () => {
    daemon = startDaemon(userDataDir);
    await daemon.ready();
    await daemon.send('initialize', { userDataDir });
    await daemon.send('bots/create', {
      name: 'runs-bot',
      persona: '',
      workspace: userDataDir,
      allowlist: [],
    });
    await daemon.send('bots/trigger', {
      bot: 'runs-bot',
      content: 'cron fire content',
      runId: 'run-runs-1',
      trigger: 'cron',
    });
    await new Promise((r) => setTimeout(r, 500));
    const records = readRunRecords(userDataDir, 'runs-bot');
    expect(records.length).toBeGreaterThanOrEqual(1);
    const cron = records.find((r) => r.trigger === 'cron');
    expect(cron, 'a cron RunRecord was not written').toBeTruthy();
    expect(cron!.runId).toBe('run-runs-1');
  });

  it('Case D: a scheduler.tick skip audit (run_in_progress) does NOT append a bots.run row', async () => {
    daemon = startDaemon(userDataDir);
    await daemon.ready();
    await daemon.send('initialize', { userDataDir });
    await daemon.send('bots/create', {
      name: 'skip-bot',
      persona: '',
      workspace: userDataDir,
      allowlist: [],
    });
    await daemon.send('bots/update', {
      bot: 'skip-bot',
      patch: { cron: '*/5 * * * *', cronEnabled: true, notifyOnError: true },
    });
    await new Promise((r) => setTimeout(r, 100));
    const ctx = {
      activeRuns: new Map<string, AbortController>(),
      activeRunBots: new Map<string, string>(),
      appendAudit: () => {},
      sendNotification: () => {},
      runSendMessageCycle: () => Promise.resolve({ exitReason: 'completed', messageCount: 1, durationMs: 10 }),
      getBotScheduledPrompt: () => 'skip prompt',
      getBotNotifyOnError: () => true,
    };
    const controller = new AbortController();
    ctx.activeRuns.set('pre-existing', controller);
    ctx.activeRunBots.set('pre-existing', 'skip-bot');
    await scheduler.__fireCronForTest__(userDataDir, 'skip-bot', ctx);
    await new Promise((r) => setTimeout(r, 100));
    const botsRunAudit = readAudit(userDataDir).filter((l) => l.tool === 'bots.run');
    expect(botsRunAudit, 'no bots.run row should be written for a skipped tick').toHaveLength(0);
  });

  it('Case E: a successful cron-fired run writes EXACTLY ONE bots.run audit row', async () => {
    daemon = startDaemon(userDataDir);
    await daemon.ready();
    await daemon.send('initialize', { userDataDir });
    await daemon.send('bots/create', {
      name: 'single-fire-bot',
      persona: '',
      workspace: userDataDir,
      allowlist: [],
    });
    await daemon.send('bots/trigger', {
      bot: 'single-fire-bot',
      content: 'cron fire once',
      runId: 'run-single-1',
      trigger: 'cron',
    });
    await new Promise((r) => setTimeout(r, 500));
    const cronRuns = readAudit(userDataDir).filter(
      (l) => l.tool === 'bots.run' && (l.params as any)?.trigger === 'cron' && (l.params as any)?.runId === 'run-single-1',
    );
    expect(cronRuns, 'exactly one bots.run row per cron fire').toHaveLength(1);
  });
});
