// Daemon entry point. Pure CommonJS so it runs under process.execPath.

const readline = require('node:readline');
const path = require('node:path');
const { writeMessage, readMessage } = require('./protocol.cjs');
const registry = require('./tools/registry.cjs');
const audit = require('./audit.cjs');
const { createWatcher } = require('./watcher.cjs');

// Phase 2: per-bot policy lives in the daemon; the orchestrator (main)
// forwards params.bot on initialize and params.bot on every tools/call.
// The 'tools' field in SERVER_INFO is a placeholder list of *names* (Phase 1
// compat). The full schemas come from registry.listTools().
const SERVER_INFO = { server: 'localbot-daemon', version: '0.3.0', tools: [] };

let nextId = 1;
const pendingReady = { resolve: null, reject: null };

// Per-call AbortController registry so `tools/cancel` can abort in-flight
// tool work (Pitfall 3 — cancel propagation). Keyed by params.toolCallId.
const abortControllers = new Map();

function ensureAbortController(toolCallId) {
  if (!toolCallId) {
    // No toolCallId → no-op controller; tools that ignore `signal` still work.
    return new AbortController();
  }
  let ctrl = abortControllers.get(toolCallId);
  if (!ctrl) {
    ctrl = new AbortController();
    abortControllers.set(toolCallId, ctrl);
  }
  return ctrl;
}

function dropAbortController(toolCallId) {
  if (!toolCallId) return;
  abortControllers.delete(toolCallId);
}

// Code-search audit shape (Pitfall 5): strip the matches payload so the
// JSONL line stays well under 1 MiB even for huge result sets. We only
// record the params + result_count (extracted from the success result, or
// 0 if the call failed).
function codeSearchAuditParams(args, successResult) {
  const { pattern, glob, path, max_results } = args || {};
  let resultCount;
  if (successResult && Array.isArray(successResult.matches)) {
    resultCount = successResult.matches.length;
  }
  const audit = { pattern, glob, path, max_results };
  if (typeof resultCount === 'number') audit.result_count = resultCount;
  return audit;
}

function reply(obj) {
  writeMessage(process.stdout, obj);
}

function replyError(id, code, message) {
  reply({ jsonrpc: '2.0', id, error: { code, message } });
}

function replyResult(id, result) {
  reply({ jsonrpc: '2.0', id, result });
}

// Phase 3 Wave 2: unsolicited notifications (no `id`) are framed as
// `{"jsonrpc":"2.0","method":"<channel>","params":{...}}` and emitted on the
// same NDJSON pipe as request/response. The `readMessage` parser already
// returns any JSON object; main's spawn bridge routes notifications with a
// `method` field to registered listeners.
let activeWatcher = null;

function sendNotification(method, params) {
  reply({ jsonrpc: '2.0', method, params });
}

// Handshake: write { kind: 'ready' } as the very first line.
writeMessage(process.stdout, { kind: 'ready', version: '0.3.0' });

const rl = readline.createInterface({ input: process.stdin });

// Phase 2: workspaceRoot is latched on initialize and threaded into every
// tools/call ctx. It MUST NOT come from any caller other than initialize.
let workspaceRoot = null;
let currentBot = 'default';
let botDir = null; // Phase 3: <userData>/bots/<bot>; threaded into memory_read/write ctx

rl.on('line', async (line) => {
  const obj = readMessage(line);
  if (!obj) {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  const { id, method, params } = obj;

  try {
    switch (method) {
      case 'initialize': {
        if (params && typeof params.userDataDir === 'string') {
          audit.setUserDataDir(params.userDataDir);
        }
        if (params && typeof params.workspaceRoot === 'string') {
          workspaceRoot = params.workspaceRoot;
        }
        if (params && typeof params.bot === 'string') {
          currentBot = params.bot;
          audit.setCurrentBot(params.bot);
        }
        // Phase 3: botDir is the canonical <userData>/bots/<bot> directory
        // for memory IO. Falls back to <userData>/bots/<bot> derived from
        // userDataDir + bot when the orchestrator doesn't pass it explicitly.
        if (params && typeof params.botDir === 'string' && params.botDir.length > 0) {
          botDir = params.botDir;
        } else if (params && typeof params.userDataDir === 'string' && typeof params.bot === 'string') {
          botDir = path.join(params.userDataDir, 'bots', params.bot);
        }

        // Phase 3 Wave 2: filesystem watcher for live tree refresh. The
        // orchestrator passes the root paths it wants watched; the daemon
        // debounces change events to a single `tree:refresh` notification
        // per debounce window (default 250ms; RESEARCH.md §"Pitfall 3").
        const treeRoots = (params && Array.isArray(params.treeRoots))
          ? params.treeRoots.filter((r) => r && typeof r.absPath === 'string' && r.absPath.length > 0)
          : [];
        if (activeWatcher) {
          try { activeWatcher.stop(); } catch { /* ignore */ }
          activeWatcher = null;
        }
        if (treeRoots.length > 0) {
          activeWatcher = createWatcher(treeRoots, { debounceMs: 250 });
          activeWatcher.on('refresh', (payload) => {
            sendNotification('tree:refresh', payload);
            audit.appendAudit({
              tool: 'tree.refresh',
              bot: currentBot,
              params: { rootPath: payload.rootPath, changedCount: payload.changedPaths.length },
              outcome: 'ok',
              durationMs: 0,
            });
          });
          activeWatcher.start();
        }

        const tools = registry.listTools();
        replyResult(id, { ...SERVER_INFO, tools });
        break;
      }

      case 'tools/list': {
        replyResult(id, { tools: registry.listTools() });
        break;
      }

      case 'tools/call': {
        const name = (params && params.name) || 'unknown';
        const args = (params && params.arguments) || {};
        const bot = (params && typeof params.bot === 'string') ? params.bot : currentBot;
        const toolCallId = (params && typeof params.toolCallId === 'string')
          ? params.toolCallId
          : undefined;
        const startedAt = Date.now();
        let outcome = 'ok';
        let errPayload = undefined;
        let successResult = undefined;
        try {
          // Phase 2 Wave 3: build a per-call AbortController so `tools/cancel`
          // (which kills the registered child) and `client.ts` cancel can both
          // abort in-flight tool work. The no-op signal preserves Phase 1
          // behavior for tools that don't care about cancellation.
          const abortController = ensureAbortController(toolCallId);
          const result = await registry.callTool(bot, name, args, {
            workspaceRoot,
            botDir,
            toolCallId,
            bot,
            signal: abortController.signal,
          });
          successResult = result;
          replyResult(id, result);
        } catch (err) {
          outcome = 'error';
          errPayload = {
            code: err.code || 'unknown_tool',
            message: err.message,
            ...(err.reason ? { reason: err.reason } : {}),
          };
          // Use the error code as the JSON-RPC error code (string codes are
          // valid per JSON-RPC 2.0 §5.1 when used in extension envelopes;
            // existing Phase 1 Playwright smoke asserts `code: 'unknown_tool'`).
          replyError(id, errPayload.code, errPayload.message);
        } finally {
          // Code-search audit minimization (Pitfall 5): the matches payload
          // would blow the 1 MiB JSONL cap, so record only the params +
          // result_count for the code_search audit line.
          const auditParams = (name === 'code_search')
            ? codeSearchAuditParams(args, successResult)
            : args;
          const durationMs = Date.now() - startedAt;
          audit.appendAudit({
            tool: name,
            bot,
            params: auditParams,
            outcome,
            durationMs,
            error: errPayload,
            tool_use_id: toolCallId,
          });
          dropAbortController(toolCallId);
        }
        break;
      }

      case 'tools/cancel': {
        const toolCallId = (params && typeof params.toolCallId === 'string') ? params.toolCallId : '';
        if (!toolCallId) {
          replyError(id, -32602, 'missing toolCallId');
          break;
        }
        // Abort the per-call AbortController first so the tool's async loop
        // unwinds; then forward to the registry which kills any registered
        // child (e.g. ripgrep for code_search).
        const ctrl = abortControllers.get(toolCallId);
        if (ctrl) {
          try { ctrl.abort(); } catch { /* ignore */ }
        }
        replyResult(id, registry.cancelToolCall(toolCallId));
        break;
      }

      // Phase 3: system memory IO + tree list. These are separate JSON-RPC
      // methods so main can bypass the per-bot allowlist when reading/writing
      // its own memory + tree. Internally they route through registry.callTool
      // with bot='_system' (registry.SYSTEM_TOOLS short-circuits the allowlist).
      case 'memory/read': {
        const startedAt = Date.now();
        const botArg = (params && typeof params.bot === 'string') ? params.bot : currentBot;
        try {
          const result = await registry.callTool('_system', 'memory.read', params || {}, {
            workspaceRoot,
            botDir,
            bot: botArg,
            signal: new AbortController().signal,
          });
          audit.appendAudit({
            tool: 'memory.read',
            bot: botArg,
            params: { bot: botArg },
            outcome: 'ok',
            durationMs: Date.now() - startedAt,
          });
          replyResult(id, result);
        } catch (err) {
          audit.appendAudit({
            tool: 'memory.read',
            bot: botArg,
            params: { bot: botArg },
            outcome: 'error',
            durationMs: Date.now() - startedAt,
            error: { code: err.code || 'unknown_tool', message: err.message },
          });
          replyError(id, err.code || 'memory_read_failed', err.message);
        }
        break;
      }

      case 'memory/write': {
        const startedAt = Date.now();
        const botArg = (params && typeof params.bot === 'string') ? params.bot : currentBot;
        try {
          const result = await registry.callTool('_system', 'memory.write', params || {}, {
            workspaceRoot,
            botDir,
            bot: botArg,
            signal: new AbortController().signal,
          });
          audit.appendAudit({
            tool: 'memory.write',
            bot: botArg,
            params: { bot: botArg, bytesWritten: result?.bytesWritten, factCount: result?.factCount },
            outcome: 'ok',
            durationMs: Date.now() - startedAt,
          });
          replyResult(id, result);
        } catch (err) {
          audit.appendAudit({
            tool: 'memory.write',
            bot: botArg,
            params: { bot: botArg },
            outcome: 'error',
            durationMs: Date.now() - startedAt,
            error: { code: err.code || 'memory_write_failed', message: err.message },
          });
          replyError(id, err.code || 'memory_write_failed', err.message);
        }
        break;
      }

      case 'tree/list': {
        const startedAt = Date.now();
        const botArg = (params && typeof params.bot === 'string') ? params.bot : currentBot;
        try {
          const result = await registry.callTool('_system', 'tree.list', params || {}, {
            workspaceRoot,
            botDir,
            bot: botArg,
            signal: new AbortController().signal,
          });
          const entriesReturned = Array.isArray(result?.entries) ? result.entries.length : 0;
          audit.appendAudit({
            tool: 'tree.list',
            bot: botArg,
            params: {
              path: params?.path,
              maxDepth: params?.maxDepth,
              maxEntriesPerDir: params?.maxEntriesPerDir,
              entriesReturned,
            },
            outcome: 'ok',
            durationMs: Date.now() - startedAt,
          });
          replyResult(id, result);
        } catch (err) {
          audit.appendAudit({
            tool: 'tree.list',
            bot: botArg,
            params: { path: params?.path },
            outcome: 'error',
            durationMs: Date.now() - startedAt,
            error: { code: err.code || 'tree_list_failed', message: err.message },
          });
          replyError(id, err.code || 'tree_list_failed', err.message);
        }
        break;
      }

      default: {
        replyError(id, -32601, `method not found: ${method}`);
      }
    }
  } catch (err) {
    replyError(id, -32603, err.message || 'internal error');
  }
});

rl.on('close', async () => {
  if (activeWatcher) {
    try { await activeWatcher.stop(); } catch { /* ignore */ }
    activeWatcher = null;
  }
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));