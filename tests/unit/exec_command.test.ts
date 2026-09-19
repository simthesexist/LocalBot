// Unit tests for daemon/tools/exec_command.cjs — Phase 5 Wave 1.
// Run with: npm test

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

let userDataDir = '';
beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-exec-cmd-'));
});
afterEach(() => {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Fake child: EventEmitter with stdout/stderr Readables. Exit fires AFTER the
// streams end so readline drains them.
function makeFakeChild(opts: { stdoutLines?: string[]; stderrLines?: string[]; exitCode?: number; pid?: number }) {
  const exitCode = opts.exitCode ?? 0;
  const stdoutLines = opts.stdoutLines ?? [];
  const stderrLines = opts.stderrLines ?? [];
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: Readable;
    stderr: Readable;
    kill: (sig?: string) => boolean;
    _killCount: () => number;
    exitCode: number | null;
  };
  child.pid = opts.pid ?? 12345;
  child.stdout = Readable.from(stdoutLines.map((l) => `${l}\n`));
  child.stderr = Readable.from(stderrLines.map((l) => `${l}\n`));
  let killCount = 0;
  child.kill = (_sig?: string) => { killCount++; return true; };
  child._killCount = () => killCount;
  child.exitCode = null;
  // Emit exit only AFTER both streams have ended (so readline drains them).
  let pending = 2;
  const maybeExit = () => {
    pending--;
    if (pending <= 0) {
      child.exitCode = exitCode;
      child.emit('exit', exitCode);
    }
  };
  child.stdout.on('end', maybeExit);
  child.stderr.on('end', maybeExit);
  // Streams with no data still emit 'end' on next tick — guard with a microtask
  // so callers that don't add any lines still see an exit.
  if (stdoutLines.length === 0) Promise.resolve().then(maybeExit);
  if (stderrLines.length === 0) Promise.resolve().then(maybeExit);
  return child;
}

// Patch child_process.spawn for the next call, then load exec_command.
function loadWithSpawnReplacement(syntheticChild: ReturnType<typeof makeFakeChild>) {
  const cp = require_('node:child_process');
  const originalSpawn = cp.spawn;
  cp.spawn = () => syntheticChild;
  const mod = require_('../../daemon/tools/exec_command.cjs');
  cp.spawn = originalSpawn;
  return mod;
}

describe('exec_command.call — validation', () => {
  it('throws invalid_args when command is empty whitespace', async () => {
    const child = makeFakeChild({});
    const mod = loadWithSpawnReplacement(child);
    await expect(
      mod.call({ command: '   ' }, { userDataDir, bot: 'b', requestApproval: vi.fn() } as any),
    ).rejects.toMatchObject({ code: 'invalid_args' });
  });
  it('throws invalid_args when command is missing', async () => {
    const child = makeFakeChild({});
    const mod = loadWithSpawnReplacement(child);
    await expect(
      mod.call({}, { userDataDir, bot: 'b', requestApproval: vi.fn() } as any),
    ).rejects.toMatchObject({ code: 'invalid_args' });
  });
  it('throws invalid_args when args is null', async () => {
    const child = makeFakeChild({});
    const mod = loadWithSpawnReplacement(child);
    await expect(
      mod.call(null as unknown as Record<string, unknown>, { userDataDir, bot: 'b', requestApproval: vi.fn() } as any),
    ).rejects.toMatchObject({ code: 'invalid_args' });
  });
});

describe('exec_command.call — denylist short-circuit', () => {
  it('throws denylist_blocked BEFORE approval + spawn', async () => {
    const child = makeFakeChild({});
    const mod = loadWithSpawnReplacement(child);
    const approvalSpy = vi.fn();
    await expect(
      mod.call({ command: 'rm -rf /' }, { userDataDir, bot: 'b', requestApproval: approvalSpy as any } as any),
    ).rejects.toMatchObject({ code: 'denylist_blocked' });
    expect(approvalSpy).not.toHaveBeenCalled();
  });
});

describe('exec_command.call — always-allow short-circuit', () => {
  it('skips requestApproval when command is in always-allow', async () => {
    const alwaysAllow = require_('../../daemon/exec/alwaysAllow.cjs');
    alwaysAllow.appendAlwaysAllow(userDataDir, 'b', { command: 'echo fast', approvedAt: '2026-01-01T00:00:00Z' });

    const child = makeFakeChild({ stdoutLines: ['fast'], exitCode: 0 });
    const mod = loadWithSpawnReplacement(child);
    const approvalSpy = vi.fn(async () => ({ decision: 'allow-once' }));

    const result = await mod.call(
      { command: 'echo fast' },
      { userDataDir, bot: 'b', requestApproval: approvalSpy as any, signal: new AbortController().signal } as any,
    );
    expect(approvalSpy).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.approvedBy).toBe('user-always');

    const list = alwaysAllow.readAlwaysAllow(userDataDir, 'b');
    expect(list[0].useCount).toBe(2);
  });
});

describe('exec_command.call — approval flows', () => {
  it('allow-once: spawns, returns approvedBy=user-once', async () => {
    const child = makeFakeChild({ stdoutLines: ['hello-from-bot'], exitCode: 0 });
    const mod = loadWithSpawnReplacement(child);
    const result = await mod.call(
      { command: 'echo hello-from-bot' },
      {
        userDataDir,
        bot: 'b',
        requestApproval: async () => ({ decision: 'allow-once' }),
        notify: () => undefined,
        signal: new AbortController().signal,
      } as any,
    );
    expect(result.exitCode).toBe(0);
    expect(result.approvedBy).toBe('user-once');
    expect(typeof result.durationMs).toBe('number');
  });
  it('deny: throws denied WITHOUT spawn', async () => {
    let spawnCount = 0;
    const cp = require_('node:child_process');
    const originalSpawn = cp.spawn;
    cp.spawn = () => { spawnCount++; return makeFakeChild({}); };
    const mod = require_('../../daemon/tools/exec_command.cjs');
    cp.spawn = originalSpawn;

    await expect(
      mod.call({ command: 'echo secret' }, { userDataDir, bot: 'b', requestApproval: async () => ({ decision: 'deny' }) } as any),
    ).rejects.toMatchObject({ code: 'denied' });
    expect(spawnCount).toBe(0);
  });
  it('approval timeout: throws approval_timeout', async () => {
    const child = makeFakeChild({});
    const mod = loadWithSpawnReplacement(child);
    await expect(
      mod.call(
        { command: 'echo no-key' },
        { userDataDir, bot: 'b', requestApproval: (async () => { throw Object.assign(new Error('no decision'), { code: 'approval_timeout' }); }) as any } as any,
      ),
    ).rejects.toMatchObject({ code: 'approval_timeout' });
  });
  it('allow-always: persists command + returns user-always', async () => {
    const alwaysAllow = require_('../../daemon/exec/alwaysAllow.cjs');
    const child = makeFakeChild({ stdoutLines: ['ok'], exitCode: 0 });
    const mod = loadWithSpawnReplacement(child);
    const result = await mod.call(
      { command: 'echo persistent' },
      {
        userDataDir,
        bot: 'b',
        requestApproval: async () => ({ decision: 'allow-always' }),
        notify: () => undefined,
        signal: new AbortController().signal,
      } as any,
    );
    expect(result.approvedBy).toBe('user-always');
    const list = alwaysAllow.readAlwaysAllow(userDataDir, 'b');
    expect(list.map((e: any) => e.command)).toContain('echo persistent');
  });
});

describe('exec_command.call — abort', () => {
  it('registers abort listener without crashing when not aborted', async () => {
    const child = makeFakeChild({ stdoutLines: ['hi'], exitCode: 0 });
    const mod = loadWithSpawnReplacement(child);
    const ctrl = new AbortController();
    const result = await mod.call(
      { command: 'echo hi' },
      {
        userDataDir,
        bot: 'b',
        requestApproval: async () => ({ decision: 'allow-once' }),
        notify: () => undefined,
        signal: ctrl.signal,
      } as any,
    );
    expect(result.exitCode).toBe(0);
  });
});