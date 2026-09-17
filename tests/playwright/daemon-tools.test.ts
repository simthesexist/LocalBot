// Playwright smoke for the Phase 2 tool daemon surface.
//
// Spawns the real daemon via process.execPath against an in-process JSON-RPC
// channel. Sends `initialize` with bot + workspaceRoot, then exercises:
//   1. tools/call { name: 'read_file' }     → happy path; asserts audit JSONL
//   2. tools/call { name: 'exec_command' }  → allowlist refusal; asserts audit
//
// Both audit lines must carry `tool_use_id` (the wire toolCallId).
//
// Mirrors tests/playwright/daemon.test.ts (Phase 1) but proves the Phase 2
// allowlist + read_file + audit additions.

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

function findAuditLine(lines: any[], predicate: (l: any) => boolean) {
  return lines.find(predicate);
}

test('daemon read_file end-to-end + allowlist refusal', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-daemon-tools-'));
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const hello = path.join(workspace, 'hello.txt');
  fs.writeFileSync(hello, 'world\n', 'utf8');

  const daemonEntry = path.join(process.cwd(), 'daemon', 'main.cjs');
  const child = spawn(process.execPath, [daemonEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LOCALBOT_USER_DATA_DIR: tmp },
  }) as ChildProcessByStdio<Writable, Readable>;

  const stderrLines: string[] = [];
  child.stderr?.on('data', (chunk) => stderrLines.push(chunk.toString('utf8')));

  try {
    const ready = await awaitReady(child);
    expect(ready, 'daemon failed to emit {kind:"ready"} within 10s').toBe(true);

    const rpc = createJsonRpcClient(child);

    // Phase 2 initialize: bot + workspaceRoot are required for tools/call.
    const initResp = await rpc.send('initialize', {
      client: 'localbot-tools-test',
      version: '0.2.0',
      userDataDir: tmp,
      bot: 'default',
      workspaceRoot: workspace,
    });
    expect(initResp.result.server).toBe('localbot-daemon');
    expect(Array.isArray(initResp.result.tools)).toBe(true);
    expect(initResp.result.tools).toHaveLength(5);

    // ─── 1. Happy path: read_file returns the workspace file's content. ───
    const readResp = await rpc.send('tools/call', {
      name: 'read_file',
      arguments: { path: 'hello.txt' },
      toolCallId: 'tc_test_1',
      bot: 'default',
    });
    expect(readResp.result).toBeTruthy();
    expect(readResp.result.content).toBe('world\n');

    // ─── 2. Allowlist refusal: exec_command is not registered. ───
    const denResp = await rpc.send('tools/call', {
      name: 'exec_command',
      arguments: {},
      toolCallId: 'tc_test_2',
      bot: 'default',
    });
    expect(denResp.error).toBeTruthy();
    // exec_command is not in the Phase 2 TOOLS list → unknown_tool.
    expect(denResp.error.code).toBe('unknown_tool');

    // The audit stream is async-write — give the daemon a moment to flush.
    await new Promise((r) => setTimeout(r, 250));
  } finally {
    child.stdin.end();
    await new Promise((r) => setTimeout(r, 100));
    if (!child.killed) child.kill();
  }

  // Verify audit JSONL.
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

  // ─── Read the read_file audit line: tool_use_id, bot, outcome ok. ───
  const readLine = findAuditLine(
    lines,
    (l: any) =>
      l.tool === 'read_file' &&
      l.bot === 'default' &&
      l.outcome === 'ok' &&
      l.tool_use_id === 'tc_test_1' &&
      l.params?.path === 'hello.txt' &&
      typeof l.durationMs === 'number',
  );
  expect(
    readLine,
    `expected a read_file audit line with tool_use_id=tc_test_1\nGot:\n${JSON.stringify(lines, null, 2)}\nStderr:\n${stderrLines.join('')}`,
  ).toBeTruthy();

  // ─── Read the exec_command audit line: outcome error, unknown_tool. ───
  const denLine = findAuditLine(
    lines,
    (l: any) =>
      l.tool === 'exec_command' &&
      l.bot === 'default' &&
      l.outcome === 'error' &&
      l.error?.code === 'unknown_tool' &&
      l.tool_use_id === 'tc_test_2',
  );
  expect(
    denLine,
    `expected an exec_command audit line with error.code=unknown_tool\nGot:\n${JSON.stringify(lines, null, 2)}\nStderr:\n${stderrLines.join('')}`,
  ).toBeTruthy();

  // Cleanup.
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

test('write_file + edit_file + list_dir round-trip end-to-end', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-daemon-tools-'));
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  // Pre-create note.txt so edit_file has something to mutate.
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'hello', 'utf8');

  const daemonEntry = path.join(process.cwd(), 'daemon', 'main.cjs');
  const child = spawn(process.execPath, [daemonEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LOCALBOT_USER_DATA_DIR: tmp },
  }) as ChildProcessByStdio<Writable, Readable>;

  const stderrLines: string[] = [];
  child.stderr?.on('data', (chunk) => stderrLines.push(chunk.toString('utf8')));

  try {
    const ready = await awaitReady(child);
    expect(ready, 'daemon failed to emit {kind:"ready"} within 10s').toBe(true);

    const rpc = createJsonRpcClient(child);

    await rpc.send('initialize', {
      client: 'localbot-tools-test',
      version: '0.2.0',
      userDataDir: tmp,
      bot: 'default',
      workspaceRoot: workspace,
    });

    // ─── 1. write_file creates a new file in a nested directory. ───
    const wResp = await rpc.send('tools/call', {
      name: 'write_file',
      arguments: { path: 'nested/note.txt', content: 'hi\n' },
      toolCallId: 'tc_w_1',
      bot: 'default',
    });
    expect(wResp.error, `write_file failed: ${JSON.stringify(wResp)}`).toBeUndefined();
    expect(wResp.result).toMatchObject({ path: 'nested/note.txt', bytesWritten: 3 });
    expect(
      fs.readFileSync(path.join(workspace, 'nested', 'note.txt'), 'utf8'),
    ).toBe('hi\n');

    // ─── 2. edit_file mutates the pre-existing note.txt atomically. ───
    const eResp = await rpc.send('tools/call', {
      name: 'edit_file',
      arguments: { path: 'note.txt', find: 'hello', replace: 'goodbye' },
      toolCallId: 'tc_e_1',
      bot: 'default',
    });
    expect(eResp.error, `edit_file failed: ${JSON.stringify(eResp)}`).toBeUndefined();
    expect(eResp.result).toMatchObject({ path: 'note.txt', replacements: 1 });
    expect(fs.readFileSync(path.join(workspace, 'note.txt'), 'utf8')).toBe('goodbye');

    // ─── 3. edit_file with multiple_matches surfaces an error envelope. ───
    const dupResp = await rpc.send('tools/call', {
      name: 'edit_file',
      arguments: { path: 'note.txt', find: 'o', replace: '0' },
      toolCallId: 'tc_e_dup',
      bot: 'default',
    });
    expect(dupResp.error).toBeTruthy();
    expect(dupResp.error.code).toBe('multiple_matches');

    // ─── 4. list_dir returns sorted entries (dirs first, alpha). ───
    const lResp = await rpc.send('tools/call', {
      name: 'list_dir',
      arguments: { path: '.' },
      toolCallId: 'tc_l_1',
      bot: 'default',
    });
    expect(lResp.error, `list_dir failed: ${JSON.stringify(lResp)}`).toBeUndefined();
    expect(Array.isArray(lResp.result.entries)).toBe(true);
    const entries = lResp.result.entries as Array<{ name: string; type: string }>;
    const names = entries.map((e) => e.name);
    // Dirs first; 'nested' must come before 'note.txt'.
    expect(names[0]).toBe('nested');
    expect(names).toContain('note.txt');
    const nested = entries.find((e) => e.name === 'nested');
    const noteTxt = entries.find((e) => e.name === 'note.txt');
    expect(nested?.type).toBe('dir');
    expect(noteTxt?.type).toBe('file');

    // The audit stream is async-write — give the daemon a moment to flush.
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    child.stdin.end();
    await new Promise((r) => setTimeout(r, 100));
    if (!child.killed) child.kill();
  }

  // Verify audit JSONL.
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

  // Every tool_use_id from this test must show up in the audit, with
  // bot:'default', outcome matching the call's success/failure shape,
  // and a numeric durationMs.
  const toolUseIds = ['tc_w_1', 'tc_e_1', 'tc_e_dup', 'tc_l_1'];
  for (const id of toolUseIds) {
    const line = lines.find((l: any) => l.tool_use_id === id);
    expect(
      line,
      `expected audit line with tool_use_id=${id}\nGot:\n${JSON.stringify(lines, null, 2)}\nStderr:\n${stderrLines.join('')}`,
    ).toBeTruthy();
    expect(line.bot).toBe('default');
    expect(typeof line.durationMs).toBe('number');
  }
  const dupLine = lines.find((l: any) => l.tool_use_id === 'tc_e_dup');
  expect(dupLine.outcome).toBe('error');
  expect(dupLine.error?.code).toBe('multiple_matches');
  expect(dupLine.tool).toBe('edit_file');
  const okLines = ['tc_w_1', 'tc_e_1', 'tc_l_1'].map((id) =>
    lines.find((l: any) => l.tool_use_id === id),
  );
  for (const l of okLines) expect(l.outcome).toBe('ok');

  // Cleanup.
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
