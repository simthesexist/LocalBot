// Spawn the tool daemon, drive the handshake, and route tools/call.

import { spawn, ChildProcess } from 'node:child_process';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CHANNELS } from '../../shared/ipc-channels';
import type { DaemonStatus, JsonRpcRequest, JsonRpcResponse } from '../../shared/types';
import { writeMessage, readMessage } from './protocol';
import { appendAuditLine } from '../audit/logger';

let daemonProc: ChildProcess | null = null;
let initialized = false;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timeout: NodeJS.Timeout }>();
let activeToolCallId: string | null = null;
let intentionalStop = false;
let respawnAttempts = 0;
const RESPAWN_WINDOW_MS = 60_000;
const RESPAWN_MAX = 10;
let firstSpawnAt = Date.now();

const TOOL_CALL_TIMEOUT_MS = 60_000;

function broadcastStatus(status: DaemonStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNELS.EVENT_DAEMON_STATUS, status);
  }
}

function rejectAllPending(reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timeout);
    p.reject(new Error(reason));
  }
  pending.clear();
}

async function sendRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  if (!daemonProc || !daemonProc.stdin || initialized === false) {
    throw new Error('daemon not ready');
  }
  return new Promise<JsonRpcResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(req.id);
      reject(new Error(`daemon request timed out after ${TOOL_CALL_TIMEOUT_MS}ms`));
    }, TOOL_CALL_TIMEOUT_MS);
    pending.set(req.id, { resolve, reject, timeout });
    writeMessage(daemonProc!.stdin!, req);
  });
}

/**
 * Phase 2: callTool accepts a {toolCallId, bot} envelope so the daemon can
 * stamp the audit line with the right bot id and emit the JSON-RPC
 * `params.bot` for policy lookup. `bot` defaults to 'default' when the
 * caller omits it (Phase 2 has only one bot).
 */
export interface CallToolOptions {
  toolCallId?: string;
  bot?: string;
}

export async function callTool(
  name: string,
  params: Record<string, unknown>,
  opts: CallToolOptions = {},
): Promise<JsonRpcResponse> {
  if (!initialized) {
    throw new Error('daemon not initialized');
  }
  const id = nextId++;
  const toolCallId = opts.toolCallId ?? `tc_${id}_${Date.now()}`;
  const bot = opts.bot ?? 'default';
  activeToolCallId = toolCallId;
  const startedAt = Date.now();
  try {
    const resp = await sendRequest({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: params, toolCallId, bot },
    });
    const durationMs = Date.now() - startedAt;
    const err = (resp as any)?.error;
    await appendAuditLine({
      bot,
      tool: name,
      params,
      outcome: err ? 'error' : 'ok',
      durationMs,
      tool_use_id: toolCallId,
      error: err ? { code: String(err.code ?? 'unknown'), message: String(err.message ?? '') } : undefined,
    });
    return resp;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    await appendAuditLine({
      bot,
      tool: name,
      params,
      outcome: 'error',
      durationMs,
      tool_use_id: toolCallId,
      error: { code: 'daemon_unreachable', message: (err as Error).message },
    });
    throw err;
  } finally {
    activeToolCallId = null;
  }
}

export async function cancelToolCall(toolCallId: string): Promise<void> {
  if (!initialized) return;
  const id = nextId++;
  try {
    await sendRequest({
      jsonrpc: '2.0',
      id,
      method: 'tools/cancel',
      params: { toolCallId },
    });
  } catch {
    // swallow — best-effort cancel
  }
}

export function getActiveToolCallId(): string | null {
  return activeToolCallId;
}

/**
 * Phase 3: invoke the daemon's `memory/<method>` JSON-RPC method. The daemon
 * exposes memory.read / memory.write as separate top-level methods that
 * bypass the per-bot allowlist (registry.SYSTEM_TOOLS). Reuses the same
 * NDJSON framing + pending map as callTool.
 *
 * `method` may be passed as either `memory/read` or `memory.read`; the slash
 * form matches the daemon wire envelope, the dot form matches the registry
 * tool name. Both are normalized to the wire form.
 */
export async function callMemory(
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!initialized) throw new Error('daemon not initialized');
  const wireMethod = method.replace(/^memory\./, 'memory/');
  const id = nextId++;
  const startedAt = Date.now();
  const bot = (typeof args.bot === 'string' ? args.bot : 'default');
  try {
    const resp = await sendRequest({
      jsonrpc: '2.0',
      id,
      method: wireMethod,
      params: args,
    });
    const durationMs = Date.now() - startedAt;
    const err = (resp as { error?: { code?: unknown; message?: unknown } }).error;
    await appendAuditLine({
      bot,
      tool: wireMethod,
      params: args,
      outcome: err ? 'error' : 'ok',
      durationMs,
      error: err ? { code: String(err.code ?? 'unknown'), message: String(err.message ?? '') } : undefined,
    });
    return (resp as { result?: unknown }).result ?? resp;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    await appendAuditLine({
      bot,
      tool: wireMethod,
      params: args,
      outcome: 'error',
      durationMs,
      error: { code: 'daemon_unreachable', message: (err as Error).message },
    });
    throw err;
  }
}

/**
 * Phase 3: invoke the daemon's `tree/<method>` JSON-RPC method. Same
 * envelope rules as callMemory. The daemon exposes `tree/list` as a
 * system-only JSON-RPC method that bypasses the bot allowlist.
 */
export async function callTree(
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!initialized) throw new Error('daemon not initialized');
  const wireMethod = method.replace(/^tree\./, 'tree/');
  const id = nextId++;
  const startedAt = Date.now();
  const bot = (typeof (args as { bot?: string }).bot === 'string'
    ? (args as { bot: string }).bot
    : 'default');
  try {
    const resp = await sendRequest({
      jsonrpc: '2.0',
      id,
      method: wireMethod,
      params: args,
    });
    const durationMs = Date.now() - startedAt;
    const err = (resp as { error?: { code?: unknown; message?: unknown } }).error;
    await appendAuditLine({
      bot,
      tool: wireMethod,
      params: args,
      outcome: err ? 'error' : 'ok',
      durationMs,
      error: err ? { code: String(err.code ?? 'unknown'), message: String(err.message ?? '') } : undefined,
    });
    return (resp as { result?: unknown }).result ?? resp;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    await appendAuditLine({
      bot,
      tool: wireMethod,
      params: args,
      outcome: 'error',
      durationMs,
      error: { code: 'daemon_unreachable', message: (err as Error).message },
    });
    throw err;
  }
}

function attachLineReader(proc: ChildProcess): void {
  if (!proc.stdout) return;
  const rl = readline.createInterface({ input: proc.stdout as NodeJS.ReadableStream });
  rl.on('line', (line) => {
    const obj = readMessage(line);
    if (!obj) return;
    const id = (obj as any).id;
    if (typeof id === 'number' && pending.has(id)) {
      const p = pending.get(id)!;
      pending.delete(id);
      clearTimeout(p.timeout);
      p.resolve(obj);
      return;
    }
    // Out-of-band notification handling can go here.
  });
}

function scheduleRespawn(): void {
  if (intentionalStop) return;
  const now = Date.now();
  if (now - firstSpawnAt > RESPAWN_WINDOW_MS) {
    firstSpawnAt = now;
    respawnAttempts = 0;
  }
  respawnAttempts++;
  if (respawnAttempts > RESPAWN_MAX) {
    broadcastStatus({ state: 'down', message: 'Tool daemon stopped responding' });
    return;
  }
  broadcastStatus({ state: 'connecting', message: 'Tool daemon reconnecting…' });
  setTimeout(() => {
    void spawnDaemon();
  }, 1000);
}

export function resolveDaemonEntry(appPath: string): string {
  const candidates = [
    path.join(appPath, 'daemon', 'main.cjs'),
    path.join(appPath, '..', 'daemon', 'main.cjs'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

export async function spawnDaemon(): Promise<void> {
  intentionalStop = false;
  initialized = false;

  const entry = resolveDaemonEntry(app.getAppPath());
  const proc = spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env },
  });
  daemonProc = proc as ChildProcess;

  proc.on('exit', (code) => {
    initialized = false;
    daemonProc = null;
    rejectAllPending(`daemon exited with code ${code ?? 'null'}`);
    if (!intentionalStop) {
      scheduleRespawn();
    }
  });

  proc.on('error', (err) => {
    void appendAuditLine({
      bot: '__system__',
      tool: 'daemon_spawn',
      params: { entry },
      outcome: 'error',
      durationMs: 0,
      error: { code: 'spawn_error', message: err.message },
    });
  });

  attachLineReader(daemonProc);

  // Wait for the first line: {"kind":"ready"}.
  const ready = await new Promise<boolean>((resolve) => {
    if (!daemonProc?.stdout) {
      resolve(false);
      return;
    }
    const rl = readline.createInterface({ input: daemonProc.stdout as NodeJS.ReadableStream });
    const onLine = (line: string) => {
      const obj = readMessage(line);
      if (obj && (obj as any).kind === 'ready') {
        rl.removeListener('line', onLine);
        rl.close();
        resolve(true);
      }
    };
    rl.on('line', onLine);
    // Hard timeout: 10s
    setTimeout(() => {
      rl.removeListener('line', onLine);
      rl.close();
      resolve(false);
    }, 10_000);
  });

  if (!ready) {
    broadcastStatus({ state: 'down', message: 'Daemon failed to become ready' });
    if (daemonProc) {
      daemonProc.kill();
    }
    scheduleRespawn();
    return;
  }

  // Send initialize. Phase 2: include workspaceRoot so the daemon's
  // safe_path can resolve paths against the bot workspace. Lazy-create the
  // workspace dir so the daemon's first tools/call finds it ready.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ensureWorkspace, ensureBotDir, botDir, userDataDir } = require('../paths');
  const workspaceRoot = await ensureWorkspace();
  const initBot = 'default';
  await ensureBotDir(initBot);
  const initId = nextId++;
  const initReq: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: initId,
    method: 'initialize',
    params: {
      client: 'localbot-main',
      version: '0.3.0',
      userDataDir: userDataDir(),
      bot: initBot,
      workspaceRoot,
      botDir: botDir(initBot),
    },
  };
  try {
    const resp = await sendRequest(initReq);
    if ((resp as any).error) {
      throw new Error(`initialize error: ${(resp as any).error.message}`);
    }
    initialized = true;
    respawnAttempts = 0;
    firstSpawnAt = Date.now();
    broadcastStatus({ state: 'ready' });
  } catch (err) {
    broadcastStatus({ state: 'down', message: 'Daemon initialize failed' });
    if (daemonProc) daemonProc.kill();
    scheduleRespawn();
  }
}

export async function stopDaemon(): Promise<void> {
  intentionalStop = true;
  initialized = false;
  if (daemonProc) {
    daemonProc.kill();
    daemonProc = null;
  }
}
