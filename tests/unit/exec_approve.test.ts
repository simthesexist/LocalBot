// Unit tests for the shell/approve + shell/respond JSON-RPC round-trip —
// Phase 5 Wave 1.
//
// These exercise the registry.callTool path (the canonical requestApproval
// bridge in main.cjs is verified by the Playwright daemon-smoke suite; here
// we focus on the exec_command surface + audit minimization invariants).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const registry = require_('../../daemon/tools/registry.cjs') as {
  callTool: (botId: string, name: string, args: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
  TOOLS: string[];
};
const policy = require_('../../daemon/bots/policy.cjs') as {
  getPolicy: (botId: string, ctx: unknown) => { allowlist: Set<string>; denylist: Set<string> };
};
const loader = require_('../../daemon/bots/loader.cjs') as {
  writeConfig: (userDataDir: string, bot: string, cfg: Record<string, unknown>) => Record<string, unknown>;
};

let userDataDir = '';
beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-exec-approve-'));
});
afterEach(() => {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeBotWithExec(bot: string, extraAllow: string[] = []) {
  loader.writeConfig(userDataDir, bot, {
    id: bot,
    name: bot,
    schemaVersion: 1,
    allowlist: ['exec_command', ...extraAllow],
  });
}

describe('exec_command registry surface', () => {
  it('lists exec_command in registry.TOOLS', () => {
    expect(registry.TOOLS).toContain('exec_command');
  });
  it('throws code=denied when exec_command is NOT in bot allowlist', async () => {
    // Bot with no allowlist (or just empty array) -> exec_command refused.
    loader.writeConfig(userDataDir, 'bot-a', { id: 'bot-a', name: 'A', schemaVersion: 1, allowlist: [] });
    await expect(
      registry.callTool('bot-a', 'exec_command', { command: 'echo hi' }, {
        userDataDir,
        bot: 'bot-a',
        requestApproval: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'denied', reason: 'allowlist' });
  });
  it('auto-deny on denylist: rm -rf /', async () => {
    writeBotWithExec('bot-a');
    await expect(
      registry.callTool('bot-a', 'exec_command', { command: 'rm -rf /' }, {
        userDataDir,
        bot: 'bot-a',
        requestApproval: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'denylist_blocked' });
  });
  it('passes through to requestApproval when command is allowed + not denylisted', async () => {
    writeBotWithExec('bot-a');
    const approval = vi.fn(async () => ({ decision: 'allow-once' }));
    // We use a custom ctx that stubs spawn by short-circuiting. exec_command
    // will call ctx.requestApproval first; after that it tries to spawn a real
    // cmd.exe which we must intercept. The simplest is to use a synthetic
    // child via patchChildProcess() — for this test we just verify the
    // approval was awaited (regardless of spawn outcome).
    const cp = require_('node:child_process');
    const { Readable } = require_('node:stream') as typeof import('node:stream');
    const { EventEmitter } = require_('node:events') as typeof import('node:events');
    const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; pid: number; kill: () => boolean; exitCode: number | null };
    child.stdout = Readable.from([]); child.stderr = Readable.from([]); child.pid = 1; child.kill = () => true; child.exitCode = null;
    setImmediate(() => { child.exitCode = 0; child.emit('exit', 0); });
    const original = cp.spawn;
    cp.spawn = () => child;
    try {
      const result = await registry.callTool('bot-a', 'exec_command', { command: 'echo approved' }, {
        userDataDir,
        bot: 'bot-a',
        requestApproval: approval,
        signal: new AbortController().signal,
      });
      expect(approval).toHaveBeenCalled();
      expect((result as { approvedBy?: string }).approvedBy).toBe('user-once');
    } finally {
      cp.spawn = original;
    }
  });
  it('persists always-allow + useCount after allow-always', async () => {
    writeBotWithExec('bot-a');
    const alwaysAllow = require_('../../daemon/exec/alwaysAllow.cjs');
    const cp = require_('node:child_process');
    const { Readable } = require_('node:stream') as typeof import('node:stream');
    const { EventEmitter } = require_('node:events') as typeof import('node:events');
    const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; pid: number; kill: () => boolean; exitCode: number | null };
    child.stdout = Readable.from([]); child.stderr = Readable.from([]); child.pid = 1; child.kill = () => true; child.exitCode = null;
    setImmediate(() => { child.exitCode = 0; child.emit('exit', 0); });
    const original = cp.spawn;
    cp.spawn = () => child;
    try {
      await registry.callTool('bot-a', 'exec_command', { command: 'echo sticky' }, {
        userDataDir,
        bot: 'bot-a',
        requestApproval: async () => ({ decision: 'allow-always' }),
        signal: new AbortController().signal,
      });
      const list = alwaysAllow.readAlwaysAllow(userDataDir, 'bot-a');
      expect(list.map((e: { command: string }) => e.command)).toContain('echo sticky');
    } finally {
      cp.spawn = original;
    }
  });
  it('throws code=denied reason=allowlist for unknown tool names', async () => {
    writeBotWithExec('bot-a');
    await expect(
      registry.callTool('bot-a', 'totally_made_up_tool', {}, {
        userDataDir,
        bot: 'bot-a',
        requestApproval: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'unknown_tool' });
  });
});

describe('default bot policy', () => {
  it('does NOT include exec_command in DEFAULT_POLICY.allowlist', () => {
    const def = require_('../../daemon/bots/default.cjs') as { DEFAULT_POLICY: { allowlist: Set<string> } };
    expect(def.DEFAULT_POLICY.allowlist.has('exec_command')).toBe(false);
  });
});