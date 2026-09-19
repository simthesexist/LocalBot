// Phase 5 Wave 1: exec_command tool.
//
// Flow (per RESEARCH.md + VALIDATION.md):
//   1) Validate args shape
//   2) matchesDangerous — auto-deny on global denylist BEFORE anything else
//   3) readAlwaysAllow — if exact match, increment useCount + skip approval
//   4) requestApproval (JSON-RPC shell/approve -> renderer modal) on miss
//   5) Spawn child (cmd.exe /d /s /c on Windows, /bin/sh -c on POSIX)
//   6) Line-buffered stdout/stderr via node:readline; emit shell:token on each
//   7) On AbortController, killChildTree (Windows: taskkill /T /F, POSIX:
//      process.kill(-pid, SIGTERM) then SIGKILL after 2s)
//   8) On exit, emit shell:exit + resolve
//
// Threat model coverage:
//   - T-05-01 (denylist FIRST)
//   - T-05-02 (approval gate synchronous; Promise lives in main.cjs)
//   - T-05-04 (audit minimization done in main.cjs, this tool returns the
//     minimal {exitCode, stdoutBytes, stderrCount, approvedBy})
//   - T-05-07 (tree-kill on AbortController)
//
// Prohibitions:
//   - MUST NOT log full command text or stdout/stderr via console.log
//     anywhere in this file (T-P5-04).

const { spawn } = require('node:child_process');
const readline = require('node:readline');

const { matchesDangerous } = require('../exec/denylist.cjs');
const { readAlwaysAllow, appendAlwaysAllow } = require('../exec/alwaysAllow.cjs');

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function killChildTree(child, isWin) {
  if (!child || !child.pid) return;
  try {
    if (isWin) {
      // taskkill /pid <pid> /T /F walks the process tree
      const { spawn: spawnSync } = require('node:child_process');
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
      setTimeout(() => {
        try {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }, 2000);
    }
  } catch { /* ignore */ }
}

async function call(args, ctx) {
  // 1) Validate args shape.
  if (!args || typeof args !== 'object') {
    throw err('invalid_args', 'args object required');
  }
  const { command, cwd, timeoutMs } = args;
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw err('invalid_args', 'command must be a non-empty string');
  }

  // 2) Denylist FIRST (T-05-01).
  const danger = matchesDangerous(command);
  if (danger.hit) {
    throw err('denylist_blocked', `command matches denylist pattern: ${danger.pattern}`);
  }

  const userDataDir = (ctx && typeof ctx.userDataDir === 'string') ? ctx.userDataDir : '';
  const bot = (ctx && typeof ctx.bot === 'string') ? ctx.bot : 'default';

  // 3) Always-allow check (exact match).
  const allowed = readAlwaysAllow(userDataDir, bot);
  const allowedHit = allowed.find((e) => e.command === command);
  let approvedBy;
  if (allowedHit) {
    appendAlwaysAllow(userDataDir, bot, {
      command,
      approvedAt: new Date().toISOString(),
    });
    approvedBy = 'user-always';
  } else {
    // 4) Request approval.
    const approval = await ctx.requestApproval({ command, bot });
    if (!approval || typeof approval.decision !== 'string') {
      throw err('approval_timeout', 'no decision received');
    }
    if (approval.decision === 'deny') {
      throw err('denied', 'user denied shell command');
    }
    if (approval.decision === 'allow-once') {
      approvedBy = 'user-once';
    } else if (approval.decision === 'allow-always') {
      approvedBy = 'user-always';
      appendAlwaysAllow(userDataDir, bot, {
        command,
        approvedAt: new Date().toISOString(),
      });
    } else {
      throw err('denied', `unknown decision: ${approval.decision}`);
    }
  }

  // 5) Spawn child.
  const isWin = process.platform === 'win32';
  const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];
  const child = spawn(shell, shellArgs, {
    cwd: cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !isWin,
  });

  let stdoutBytes = 0;
  let stderrCount = 0;
  const shellStreamId = (ctx && ctx.shellStreamId) || `${Date.now()}-${child.pid}`;

  const rlOut = readline.createInterface({ input: child.stdout });
  rlOut.on('line', (line) => {
    stdoutBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (ctx && typeof ctx.notify === 'function') {
      ctx.notify({ kind: 'shell:token', shellId: shellStreamId, stream: 'stdout', line, ts: Date.now() });
    }
  });
  const rlErr = readline.createInterface({ input: child.stderr });
  rlErr.on('line', (line) => {
    stderrCount++;
    if (ctx && typeof ctx.notify === 'function') {
      ctx.notify({ kind: 'shell:token', shellId: shellStreamId, stream: 'stderr', line, ts: Date.now() });
    }
  });

  // 6) Abort -> tree kill.
  const signal = ctx && ctx.signal;
  const onAbort = () => killChildTree(child, isWin);
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', onAbort);
  }

  // 7) Optional timeout.
  let timeoutFired = false;
  let timeoutHandle = null;
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timeoutFired = true;
      killChildTree(child, isWin);
    }, timeoutMs);
  }

  const startedAt = Date.now();
  const exitCode = await new Promise((resolve) => {
    if (child.exitCode != null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code ?? 0));
    }
  });
  const durationMs = Date.now() - startedAt;

  // Cleanup listeners.
  try { rlOut.close(); } catch { /* ignore */ }
  try { rlErr.close(); } catch { /* ignore */ }
  if (signal && typeof signal.removeEventListener === 'function') {
    signal.removeEventListener('abort', onAbort);
  }
  if (timeoutHandle) clearTimeout(timeoutHandle);

  // 8) Emit shell:exit + return.
  if (ctx && typeof ctx.notify === 'function') {
    ctx.notify({
      kind: 'shell:exit',
      shellId: shellStreamId,
      exitCode,
      durationMs,
      isError: timeoutFired || exitCode !== 0,
    });
  }

  return { exitCode, stdoutBytes, stderrCount, approvedBy, durationMs };
}

module.exports = { call, killChildTree };