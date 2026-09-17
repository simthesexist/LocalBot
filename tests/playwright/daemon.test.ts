// Playwright smoke for the tool daemon (does NOT launch Electron).
//
// Spawns the real daemon via process.execPath against an in-process JSON-RPC
// channel. Sends `initialize`, then `tools/call { name: 'echo', ... }`,
// asserts the unknown_tool error envelope, and verifies the audit JSONL line
// was appended under <LOCALBOT_USER_DATA_DIR>/audit/<UTC-day>.jsonl.
//
// This lockstep proves SEC-04 (every tools/call writes an audit line) without
// requiring the full Electron stack.

import { test, expect } from '@playwright/test';
import { spawn, ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

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
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof obj.id === 'number' && pending.has(obj.id)) {
      const p = pending.get(obj.id)!;
      pending.delete(obj.id);
      // Always resolve with the full envelope — error envelopes still carry
      // useful fields (id, error.code, error.message).
      p.resolve(obj);
    }
  });

  function send(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  return { send };
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
      } catch {
        // ignore malformed
      }
    };
    rl.on('line', onLine);
    setTimeout(() => {
      rl.removeListener('line', onLine);
      rl.close();
      resolve(false);
    }, 10_000);
  });
}

test('daemon tools/call writes one NDJSON audit line with unknown_tool error', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-daemon-'));
  const daemonEntry = path.join(process.cwd(), 'daemon', 'main.cjs');

  const child = spawn(process.execPath, [daemonEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LOCALBOT_USER_DATA_DIR: tmp,
    },
  }) as ChildProcessByStdio<Writable, Readable>;

  // Surface daemon stderr for diagnostics.
  const stderrLines: string[] = [];
  child.stderr?.on('data', (chunk) => {
    stderrLines.push(chunk.toString('utf8'));
  });

  try {
    const ready = await awaitReady(child);
    expect(ready, 'daemon failed to emit {kind:"ready"} within 10s').toBe(true);

    const rpc = createJsonRpcClient(child);

    const initResp = await rpc.send('initialize', {
      client: 'localbot-smoke-test',
      version: '0.1.0',
      userDataDir: tmp,
    });
    expect(initResp.result.server).toBe('localbot-daemon');
    expect(Array.isArray(initResp.result.tools)).toBe(true);

    // Fire tools/call with a fake tool name — registry.cjs returns unknown_tool.
    const callResp = await rpc.send('tools/call', {
      name: 'echo',
      arguments: { hello: 'world' },
    });

    // Daemon replies with JSON-RPC error envelope (id matches the request).
    expect(callResp.id).toBeGreaterThan(0);
    expect(callResp.error).toBeTruthy();
    expect(callResp.error.code).toBe('unknown_tool');

    // The audit stream is async-write — give the daemon a moment to flush.
    await new Promise((r) => setTimeout(r, 250));
  } finally {
    child.stdin.end();
    await new Promise((r) => setTimeout(r, 100));
    if (!child.killed) child.kill();
  }

  // Verify audit JSONL line.
  const auditDirPath = path.join(tmp, 'audit');
  const files = fs.existsSync(auditDirPath)
    ? fs.readdirSync(auditDirPath).filter((f) => f.endsWith('.jsonl'))
    : [];
  expect(files.length, 'expected at least one audit jsonl file').toBeGreaterThan(0);

  const dateFile = files.find((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  expect(dateFile, `expected UTC-day audit file under ${auditDirPath}`).toBeTruthy();

  const lines = fs
    .readFileSync(path.join(auditDirPath, dateFile!), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // At least one line must match the canonical shape from D-12.
  // Phase 2: bot defaults to 'default' when initialize doesn't pass params.bot
  // (the previous 'daemon' constant is removed per Plan 02-01 §B).
  const echoLine = lines.find(
    (l: any) =>
      l.tool === 'echo' &&
      l.bot === 'default' &&
      l.outcome === 'error' &&
      l.error?.code === 'unknown_tool' &&
      typeof l.durationMs === 'number' &&
      l.params?.hello === 'world',
  );

  expect(
    echoLine,
    `expected an audit line with tool=echo outcome=error unknown_tool\nGot:\n${JSON.stringify(lines, null, 2)}\nStderr:\n${stderrLines.join('')}`,
  ).toBeTruthy();

  // Cleanup.
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
