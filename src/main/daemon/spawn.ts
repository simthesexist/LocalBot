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
const notificationListeners = new Map<string, Set<(params: unknown) => void>>();
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

async function sendRequest(req: JsonRpcRequest, opts: { bypassInitCheck?: boolean } = {}): Promise<JsonRpcResponse> {
  if (!daemonProc || !daemonProc.stdin) {
    throw new Error('daemon not ready');
  }
  // The initialize handshake is the first request we send; `initialized`
  // is only flipped to true AFTER the daemon ACKs initialize, so this
  // single call needs to bypass the gate. All subsequent callTool /
  // callMemory / callTree requests must go through the normal gate.
  if (!opts.bypassInitCheck && initialized === false) {
    throw new Error('daemon not initialized');
  }
  return new Promise<JsonRpcResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(req.id);
      reject(new Error(`daemon request timed out after ${TOOL_CALL_TIMEOUT_MS}ms`));
    }, TOOL_CALL_TIMEOUT_MS);
    pending.set(req.id, { resolve, reject, timeout });
    try {
      writeMessage(daemonProc!.stdin!, req);
    } catch (e) {
      pending.delete(req.id);
      reject(e as Error);
    }
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

function attachLineReader(proc: ChildProcess): readline.Interface {
  if (!proc.stdout) {
    throw new Error('daemon stdout not available');
  }
  const rl = readline.createInterface({ input: proc.stdout as NodeJS.ReadableStream });
  // Pre-handshake buffer: lines that arrive BEFORE ready resolves must be
  // dispatched to the pending/notifications map after ready, because the
  // bridge only sets up `pending` entries once it has decided to talk to the
  // daemon. We buffer raw NDJSON lines (strings) so we can replay them
  // unchanged — `readMessage` is pure JSON.parse so re-running it is safe.
  const preReadyBuffer: string[] = [];
  let readyResolved = false;
  rl.on('line', (line) => {
    if (!readyResolved) {
      preReadyBuffer.push(line);
      return;
    }
    dispatchLine(line);
  });
  // Mark ready once the handshake resolves; replay any buffered line that
  // arrived before ready (e.g. an unsolicited notification fired during the
  // handshake window).
  (rl as readline.Interface & { __markReady: () => void }).__markReady = () => {
    readyResolved = true;
    while (preReadyBuffer.length > 0) {
      const line = preReadyBuffer.shift()!;
      dispatchLine(line);
    }
  };
  return rl;
}

function dispatchLine(line: string): void {
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
  // Phase 3 Wave 2: notifications from the daemon (no `id`, but `method`).
  // The line reader in protocol.cjs tolerates extra fields; dispatch to
  // any listeners registered via onNotification().
  const method = (obj as { method?: unknown }).method;
  if (typeof method === 'string') {
    const set = notificationListeners.get(method);
    if (set && set.size > 0) {
      const params = (obj as { params?: unknown }).params;
      for (const cb of Array.from(set)) {
        try { cb(params); } catch { /* listener errors must not break the bridge */ }
      }
    }
  }
}

/**
 * Phase 4 Wave 1: invoke the daemon's `bots/<method>` JSON-RPC methods.
 * The daemon exposes `bots/list`, `bots/create`, `bots/delete` as
 * top-level methods that bypass the per-bot tool allowlist (they ARE
 * the per-bot metadata CRUD). Returns the raw `{result}` payload —
 * callers do their own shape checks so the wire codes surface as
 * `{ok:false, error}` in the renderer without a translate step.
 */
export async function callBot(
  method: 'bots/list' | 'bots/create' | 'bots/delete',
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!initialized) throw new Error('daemon not initialized');
  const id = nextId++;
  // bots/delete scopes the audit by the bot being deleted; the other two
  // use the implicit `default` bot for the audit line (the caller is
  // main, not an LLM-driven tool call).
  const bot = (typeof (args as { bot?: string }).bot === 'string')
    ? (args as { bot: string }).bot
    : 'default';
  const startedAt = Date.now();
  try {
    const resp = await sendRequest({
      jsonrpc: '2.0',
      id,
      method,
      params: args,
    });
    const durationMs = Date.now() - startedAt;
    const err = (resp as { error?: { code?: unknown; message?: unknown } }).error;
    await appendAuditLine({
      bot,
      tool: method,
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
      tool: method,
      params: args,
      outcome: 'error',
      durationMs,
      error: { code: 'daemon_unreachable', message: (err as Error).message },
    });
    throw err;
  }
}

/**
 * Subscribe to a daemon-emitted notification channel (e.g. `tree:refresh`).
 * Returns an unsubscribe function. Listeners are called synchronously from
 * the line-reader tick; throws are swallowed so one bad listener does not
 * take down the bridge for the others.
 */
export function onNotification(method: string, cb: (params: unknown) => void): () => void {
  let set = notificationListeners.get(method);
  if (!set) {
    set = new Set();
    notificationListeners.set(method, set);
  }
  set.add(cb);
  return () => {
    const cur = notificationListeners.get(method);
    if (!cur) return;
    cur.delete(cb);
    if (cur.size === 0) notificationListeners.delete(method);
  };
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
  // process.execPath inside Electron's main process is the Electron binary
  // (not node.exe). ELECTRON_RUN_AS_NODE=1 in the child env makes the child
  // behave as plain Node so it executes `entry` as a script. Without this
  // flag, the spawned binary launches a new Electron GUI app and ignores
  // the script arg — the ready handshake never fires and `initialized`
  // stays false (root cause of G-3-4).
  const proc = spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  daemonProc = proc as ChildProcess;

  proc.on('exit', (code, signal) => {
    initialized = false;
    daemonProc = null;
    rejectAllPending(`daemon exited with code ${code ?? 'null'} signal=${signal ?? 'null'}`);
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

  // Wire a SINGLE readline interface on the daemon's stdout. The previous
  // version created TWO readlines (one for the ready handshake, one for
  // ongoing traffic) which, under Electron's Windows pipe semantics, caused
  // the second and subsequent lines to be buffered until process exit — the
  // G-3-4 root cause. We now use one readline, buffer pre-ready lines into
  // attachLineReader's __markReady queue, and dispatch them once the
  // handshake resolves.
  const rl = attachLineReader(daemonProc);

  // Wait for the first line: {"kind":"ready"}. We watch the readline
  // interface directly (instead of opening a second readline) so there is
  // exactly one consumer on the stdout pipe.
  const ready = await new Promise<boolean>((resolve) => {
    const onLine = (line: string) => {
      const obj = readMessage(line);
      if (obj && (obj as any).kind === 'ready') {
        rl.removeListener('line', onLine);
        resolve(true);
      }
    };
    rl.on('line', onLine);
    // Hard timeout: 10s
    setTimeout(() => {
      rl.removeListener('line', onLine);
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

  // Bridge is now hot — flip ready-resolved so any buffered lines (e.g. an
  // unsolicited tree:refresh notification fired during the handshake) get
  // dispatched to the pending/notifications map.
  (rl as readline.Interface & { __markReady: () => void }).__markReady();

  // Send initialize. Phase 2: include workspaceRoot so the daemon's
  // safe_path can resolve paths against the bot workspace. Lazy-create the
  // workspace dir so the daemon's first tools/call finds it ready.
  // Phase 3 Wave 2: also pass treeRoots so the daemon can wire up the
  // chokidar watcher and emit `tree:refresh` notifications.
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
      treeRoots: [
        { id: 'workspace', absPath: workspaceRoot },
        { id: 'bots', absPath: botDir(initBot) },
      ],
    },
  };
  try {
    const resp = await sendRequest(initReq, { bypassInitCheck: true });
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
