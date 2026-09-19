// Daemon entry point. Pure CommonJS so it runs under process.execPath.

const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { writeMessage, readMessage } = require('./protocol.cjs');
const registry = require('./tools/registry.cjs');
const audit = require('./audit.cjs');
const { createWatcher } = require('./watcher.cjs');
const botLoader = require('./bots/loader.cjs');
const { appendRun: appendRunRecord } = require('./runs/jsonl.cjs');

// Phase 4 Wave 2: per-runId AbortController map for bots/trigger + bots/cancel.
// Keyed by runId so multiple bots can run concurrently (Pitfall 10).
const activeRuns = new Map();
// Side map: runId → bot id (so bots/cancel can stamp the audit line).
const activeRunBots = new Map();

/**
 * runSendMessageCycle(bot, content, runId, signal) — runs one sendMessage
 * cycle in-process via the @anthropic-ai/sdk CJS bundle. Streams tokens as
 * `chat:token` notifications, persists the assistant turn, and writes one
 * RunRecord on completion. The cancel surface is `signal.aborted`.
 *
 * Wave 2 PLANNER RECOMMENDATION: daemon is CommonJS so we `require()`
 * the SDK's CJS bundle directly — no subprocess, no Electron fork. The
 * SDK key is loaded from <userDataDir>/api-key.bin via safeStorage
 * (Phase 1). If no key is configured, we abort the cycle with
 * exitReason='errored' and error.code='missing_api_key'.
 */
async function runSendMessageCycle(userDataDir, bot, content, runId, signal) {
  const startedAt = Date.now();
  let exitReason = 'completed';
  let errorPayload = undefined;
  let messageCount = 0;
  let aggregated = '';

  // Read API key from <userDataDir>/api-key.bin (Phase 1 safeStorage shape).
  let apiKey;
  try {
    apiKey = fs.readFileSync(path.join(userDataDir, 'api-key.bin'), 'utf8');
  } catch {
    apiKey = process.env.ANTHROPIC_API_KEY || '';
  }

  if (!apiKey) {
    exitReason = 'errored';
    errorPayload = { code: 'missing_api_key', message: 'no api key configured' };
    return { exitReason, errorPayload, messageCount, durationMs: Date.now() - startedAt };
  }

  let client;
  try {
    // CommonJS require of the SDK's CJS bundle. The SDK ships both ESM
    // and CJS; the CJS bundle exports the Anthropic class as the default.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { default: Anthropic } = require('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey });
  } catch (err) {
    exitReason = 'errored';
    errorPayload = { code: 'sdk_init_failed', message: err.message };
    return { exitReason, errorPayload, messageCount, durationMs: Date.now() - startedAt };
  }

  const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionDir = path.join(userDataDir, 'sessions', bot);
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);

  try {
    // Persist the user turn.
    const userRow = { ts: Date.now(), role: 'user', content, msgId: `${runId}-m0` };
    fs.appendFileSync(sessionFile, JSON.stringify(userRow) + '\n', 'utf8');
    messageCount++;

    // Build minimal system prompt + messages for the single-cycle call.
    const system = 'You are Localbot. Be concise. Use tools when useful.';
    const stream = client.messages.stream({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content }],
    }, { signal });

    stream.on('text', (text) => {
      aggregated += text;
      sendNotification('chat:token', { msgId: `${runId}-m1`, delta: text });
    });

    await stream.finalMessage();

    if (signal && signal.aborted) {
      exitReason = 'cancelled';
    } else {
      // Persist the assistant turn.
      const assistantRow = { ts: Date.now(), role: 'assistant', content: aggregated, msgId: `${runId}-m1` };
      fs.appendFileSync(sessionFile, JSON.stringify(assistantRow) + '\n', 'utf8');
      messageCount++;
    }
  } catch (err) {
    if (signal && signal.aborted) {
      exitReason = 'cancelled';
    } else {
      exitReason = 'errored';
      errorPayload = { code: err.code || 'cycle_failed', message: err.message };
    }
  }

  return { exitReason, errorPayload, messageCount, durationMs: Date.now() - startedAt };
}

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

// Phase 5 Wave 1: pending shell approvals. The Promise lives here (canonical
// state) so a `shell/respond` JSON-RPC reply can resolve it from the main
// thread, regardless of which worker the tool's call() landed in.
const pendingApprovals = new Map(); // shellId -> { resolve, reject, timer, command, bot }
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

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

// Phase 5 Wave 1: exec_command audit minimization (T-P5-08). The audit line
// for exec_command MUST NEVER include the full command or stdout/stderr text.
// Only 6 fields: command_redacted (slice 0..80), commandLength, approvedBy,
// exitCode, stdoutBytes, stderrCount.
function execCommandAuditParams(args, successResult, errPayload) {
  const cmd = (args && typeof args.command === 'string') ? args.command : '';
  let approvedBy = 'n/a';
  let exitCode = null;
  let stdoutBytes = 0;
  let stderrCount = 0;
  if (successResult && typeof successResult === 'object') {
    if (typeof successResult.approvedBy === 'string') approvedBy = successResult.approvedBy;
    if (typeof successResult.exitCode === 'number') exitCode = successResult.exitCode;
    if (typeof successResult.stdoutBytes === 'number') stdoutBytes = successResult.stdoutBytes;
    if (typeof successResult.stderrCount === 'number') stderrCount = successResult.stderrCount;
  } else if (errPayload && typeof errPayload === 'object' && errPayload.code) {
    // denylist_blocked / denied / approval_timeout map onto approvedBy buckets.
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
// Phase 4: userDataDir is the root of all bot/audit/session JSONL files.
// Latched from initialize.params.userDataDir; bots/* handlers read it to
// locate <userData>/bots/<bot>/config.json.
let userDataDirState = null;

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
          userDataDirState = params.userDataDir;
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
          // Phase 5 Wave 2: defense-in-depth denylist re-check. exec_command's
          // own module-level matchesDangerous() is the primary gate, but
          // re-validating here means a future refactor of exec_command.cjs
          // cannot accidentally bypass the global safety net. The check is
          // intentionally cheap (regex array of 11 patterns) and only fires
          // for exec_command; other tools are unaffected.
          if (name === 'exec_command') {
            const denylist = require('./exec/denylist.cjs');
            const m = denylist.matchesDangerous(args && typeof args.command === 'string' ? args.command : '');
            if (m && m.hit) {
              throw Object.assign(new Error('denylist_blocked'), { code: 'denylist_blocked' });
            }
          }
          // Phase 2 Wave 3: build a per-call AbortController so `tools/cancel`
          // (which kills the registered child) and `client.ts` cancel can both
          // abort in-flight tool work. The no-op signal preserves Phase 1
          // behavior for tools that don't care about cancellation.
          const abortController = ensureAbortController(toolCallId);
          // Phase 5 Wave 1: requestApproval bridge for exec_command. The
          // tool's call() awaits this promise; main.cjs resolves it when
          // shell/respond arrives (or when APPROVAL_TIMEOUT_MS elapses).
          const requestApproval = ({ command, bot: approvalBot }) => {
            const shellId = (typeof toolCallId === 'string' && toolCallId.length > 0)
              ? toolCallId
              : crypto.randomUUID();
            return new Promise((resolveApproval, rejectApproval) => {
              const timer = setTimeout(() => {
                if (pendingApprovals.has(shellId)) {
                  pendingApprovals.delete(shellId);
                  rejectApproval(Object.assign(new Error('approval timeout'), { code: 'approval_timeout' }));
                }
              }, APPROVAL_TIMEOUT_MS);
              pendingApprovals.set(shellId, {
                resolve: resolveApproval,
                reject: rejectApproval,
                timer,
                command,
                bot: approvalBot,
                notify: sendNotification,
              });
              sendNotification('shell:request-approval', { shellId, command, bot: approvalBot, ts: Date.now() });
            });
          };
          const result = await registry.callTool(bot, name, args, {
            workspaceRoot,
            botDir,
            toolCallId,
            bot,
            userDataDir: userDataDirState,
            notify: sendNotification,
            requestApproval,
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
          // result_count for the code_search audit line. exec_command audit
          // minimization (T-P5-08): never record the full command or stdout.
          let auditParams;
          if (name === 'code_search') {
            auditParams = codeSearchAuditParams(args, successResult);
          } else if (name === 'exec_command') {
            auditParams = execCommandAuditParams(args, successResult, errPayload);
          } else {
            auditParams = args;
          }
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

      // Phase 5 Wave 1: shell/respond — the renderer (via main) routes the
      // user's modal decision back to the daemon. Resolves the pending Promise
      // for `ctx.requestApproval` (the canonical state lives in main.cjs).
      case 'shell/respond': {
        const shellId = (params && typeof params.shellId === 'string') ? params.shellId : '';
        const decision = (params && typeof params.decision === 'string') ? params.decision : '';
        if (!shellId) {
          replyError(id, -32602, 'missing shellId');
          break;
        }
        if (!['allow-once', 'allow-always', 'deny'].includes(decision)) {
          replyError(id, -32602, `invalid decision: ${decision}`);
          break;
        }
        const entry = pendingApprovals.get(shellId);
        if (!entry) {
          replyError(id, 'no_such_shell', `no pending approval: ${shellId}`);
          break;
        }
        pendingApprovals.delete(shellId);
        if (entry.timer) clearTimeout(entry.timer);
        entry.resolve({ decision, shellId, command: entry.command, bot: entry.bot });
        replyResult(id, { ok: true });
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

      // Phase 4 Wave 1: bots/list, bots/create, bots/delete — JSON-RPC
      // methods for per-bot metadata CRUD. All write a single audit line
      // in the canonical {ts, bot, tool, params, outcome, durationMs,
      // error?} shape (SEC-04). bots/create uses audit minimization
      // (T-P4-10): the `params` field carries only {name, personaBytes},
      // never the persona content or workspace path.
      case 'bots/list': {
        const startedAt = Date.now();
        try {
          const bots = botLoader.listAllBots(userDataDirState);
          audit.appendAudit({
            tool: 'bots.list',
            bot: currentBot,
            params: {},
            outcome: 'ok',
            durationMs: Date.now() - startedAt,
          });
          replyResult(id, { ok: true, bots });
        } catch (err) {
          audit.appendAudit({
            tool: 'bots.list',
            bot: currentBot,
            params: {},
            outcome: 'error',
            durationMs: Date.now() - startedAt,
            error: { code: err.code || 'bots_list_failed', message: err.message },
          });
          replyError(id, err.code || 'bots_list_failed', err.message);
        }
        break;
      }

      case 'bots/create': {
        const startedAt = Date.now();
        try {
          if (!userDataDirState) throw Object.assign(new Error('daemon not initialized'), { code: 'daemon_not_initialized' });
          const p = params || {};
          // Derive id from params.name when not provided; refuse bot_exists.
          const botId = (typeof p.id === 'string' && p.id.length > 0)
            ? botLoader.deriveSlug(p.id)
            : botLoader.deriveSlug(String(p.name || ''));
          if (botLoader.botExists(userDataDirState, botId)) {
            throw Object.assign(new Error(`bot already exists: ${botId}`), { code: 'bot_exists' });
          }
          const cfg = {
            id: botId,
            name: typeof p.name === 'string' ? p.name : botId,
            persona: typeof p.persona === 'string' ? p.persona : '',
            workspace: typeof p.workspace === 'string' ? p.workspace : '',
            allowlist: Array.isArray(p.allowlist) ? p.allowlist.slice() : [],
            cron: typeof p.cron === 'string' && p.cron.length > 0 ? p.cron : undefined,
            cronEnabled: typeof p.cronEnabled === 'boolean' ? p.cronEnabled : undefined,
            schemaVersion: 1,
            status: 'idle',
          };
          const written = botLoader.writeConfig(userDataDirState, botId, cfg);

          // Side effect: seed memory.md + facts.json stubs so the bot has
          // the Phase 3 surfaces ready before any LLM-driven memory.update.
          const botDirPath = path.join(userDataDirState, 'bots', botId);
          const memoryPath = path.join(botDirPath, 'memory.md');
          const factsPath = path.join(botDirPath, 'facts.json');
          if (!fs.existsSync(memoryPath)) {
            fs.writeFileSync(memoryPath, '', 'utf8');
          }
          if (!fs.existsSync(factsPath)) {
            fs.writeFileSync(factsPath, '{}', 'utf8');
          }

          // Audit minimization (T-P4-10 + T-P4-22): only record the id and
          // name — never the persona content, persona bytes, workspace path,
          // or allowlist contents. The audit envelope already carries `bot`
          // (the id); name is the human label.
          audit.appendAudit({
            tool: 'bots.create',
            bot: botId,
            params: { id: botId, name: written.name },
            outcome: 'ok',
            durationMs: Date.now() - startedAt,
          });
          replyResult(id, { ok: true, bot: written });
        } catch (err) {
          // Audit on failure still keeps the params minimization pattern.
          audit.appendAudit({
            tool: 'bots.create',
            bot: (params && typeof params.id === 'string') ? params.id : (params && typeof params.name === 'string' ? params.name : currentBot),
            params: { id: (params && typeof params.id === 'string') ? params.id : '', name: params && typeof params.name === 'string' ? params.name : '' },
            outcome: 'error',
            durationMs: Date.now() - startedAt,
            error: { code: err.code || 'bots_create_failed', message: err.message },
          });
          replyError(id, err.code || 'bots_create_failed', err.message);
        }
        break;
      }

      case 'bots/delete': {
        const startedAt = Date.now();
        try {
          if (!userDataDirState) throw Object.assign(new Error('daemon not initialized'), { code: 'daemon_not_initialized' });
          const p = params || {};
          const botId = typeof p.bot === 'string' ? p.bot : '';
          if (botId.length === 0) {
            throw Object.assign(new Error('bot id required'), { code: 'invalid_id' });
          }
          // T-P4-05: protect the implicit `default` bot — Phase 3 data
          // would be lost if a renderer-driven delete succeeded.
          if (botId === 'default') {
            throw Object.assign(new Error('cannot delete the implicit default bot'), { code: 'protected_bot' });
          }
          botLoader.deleteBot(userDataDirState, botId);

          // Best-effort: remove the per-bot sessions directory.
          // The runs JSONL removal is Wave 2's responsibility (the runs
          // writer doesn't exist yet — appendRun lands with the trigger
          // flow in Plan 04-02).
          const sessionsPath = path.join(userDataDirState, 'sessions', botId);
          try { fs.rmSync(sessionsPath, { recursive: true, force: true }); } catch { /* ignore */ }

          audit.appendAudit({
            tool: 'bots.delete',
            bot: botId,
            params: {},
            outcome: 'ok',
            durationMs: Date.now() - startedAt,
          });
          replyResult(id, { ok: true });
        } catch (err) {
          audit.appendAudit({
            tool: 'bots.delete',
            bot: (params && typeof params.bot === 'string') ? params.bot : currentBot,
            params: {},
            outcome: 'error',
            durationMs: Date.now() - startedAt,
            error: { code: err.code || 'bots_delete_failed', message: err.message },
          });
          replyError(id, err.code || 'bots_delete_failed', err.message);
        }
        break;
      }

      // Phase 4 Wave 2: bots/update, bots/trigger, bots/cancel. The first
      // patches config.json atomically; trigger and cancel manage the
      // per-runId AbortController map + RunRecord history (Pitfall 10).
      case 'bots/update': {
        const startedAt = Date.now();
        try {
          if (!userDataDirState) throw Object.assign(new Error('daemon not initialized'), { code: 'daemon_not_initialized' });
          const p = params || {};
          const botId = typeof p.bot === 'string' ? p.bot : '';
          if (!botId) throw Object.assign(new Error('bot required'), { code: 'invalid_id' });
          const patch = (p.patch && typeof p.patch === 'object' && !Array.isArray(p.patch)) ? p.patch : {};
          const written = botLoader.writeConfigPatch(userDataDirState, botId, patch);
          // Audit minimization (T-P4-17): only record the changedKeys array.
          audit.appendAudit({
            tool: 'bots.update',
            bot: botId,
            params: { changedKeys: Object.keys(patch).sort() },
            outcome: 'ok',
            durationMs: Date.now() - startedAt,
          });
          replyResult(id, { ok: true, bot: written });
        } catch (err) {
          audit.appendAudit({
            tool: 'bots.update',
            bot: (params && typeof params.bot === 'string') ? params.bot : currentBot,
            params: { changedKeys: (params && params.patch) ? Object.keys(params.patch).sort() : [] },
            outcome: 'error',
            durationMs: Date.now() - startedAt,
            error: { code: err.code || 'bots_update_failed', message: err.message },
          });
          replyError(id, err.code || 'bots_update_failed', err.message);
        }
        break;
      }

      case 'bots/trigger': {
        const startedAt = Date.now();
        const p = params || {};
        const botId = typeof p.bot === 'string' ? p.bot : '';
        const content = typeof p.content === 'string' ? p.content : '';
        if (!botId) {
          replyError(id, 'invalid_id', 'bot required');
          break;
        }
        if (content.length === 0) {
          replyError(id, 'invalid_content', 'content required');
          break;
        }
        // Validate the bot exists (throws unknown_bot otherwise).
        botLoader.readConfig(userDataDirState, botId);

        const runId = (typeof p.runId === 'string' && p.runId.length > 0)
          ? p.runId
          : crypto.randomUUID();
        const controller = new AbortController();
        activeRuns.set(runId, controller);
        activeRunBots.set(runId, botId);

        // Broadcast running status (Pitfall 9 — every transition).
        sendNotification('bot:status', { bot: botId, status: 'running', runId, ts: new Date().toISOString() });

        try {
          const cycle = await runSendMessageCycle(userDataDirState, botId, content, runId, controller.signal);

          // Pitfall 6 ordering: RunRecord append FIRST, then status patch.
          const record = {
            ts: new Date().toISOString(),
            runId,
            trigger: 'manual',
            durationMs: cycle.durationMs,
            exitReason: cycle.exitReason,
            messageCount: cycle.messageCount,
          };
          if (cycle.errorPayload) record.error = cycle.errorPayload;
          await appendRunRecord(userDataDirState, botId, record);

          // Now patch config.json#status + lastRunAt (best-effort).
          try {
            botLoader.writeConfigPatch(userDataDirState, botId, {
              status: cycle.exitReason === 'completed' || cycle.exitReason === 'cancelled' ? 'idle' : 'errored',
              lastRunAt: record.ts,
              lastRunExitReason: cycle.exitReason,
              lastRunError: cycle.errorPayload ? cycle.errorPayload.message : undefined,
            });
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(`[bots/trigger] status patch failed for bot=${botId}: ${e.message}`);
          }

          // Broadcast terminal status.
          sendNotification('bot:status', {
            bot: botId,
            status: cycle.exitReason === 'completed' || cycle.exitReason === 'cancelled' ? 'idle' : 'errored',
            runId,
            ts: new Date().toISOString(),
          });

          // Audit minimization (T-P4-19 + T-P4-23): no error.message text
          // in params, no `bot` field (envelope already carries it). Only
          // {runId, trigger, messageCount}.
          audit.appendAudit({
            tool: 'bots.run',
            bot: botId,
            params: { runId, trigger: 'manual', messageCount: cycle.messageCount },
            outcome: cycle.exitReason === 'errored' ? 'error' : 'ok',
            durationMs: cycle.durationMs,
            error: cycle.errorPayload,
          });
          replyResult(id, { ok: true, runId, exitReason: cycle.exitReason });
        } catch (err) {
          // Even on outer catch, params stay minimal — {runId, trigger}.
          audit.appendAudit({
            tool: 'bots.run',
            bot: botId,
            params: { runId, trigger: 'manual' },
            outcome: 'error',
            durationMs: Date.now() - startedAt,
            error: { code: err.code || 'bots_run_failed', message: err.message },
          });
          replyError(id, err.code || 'bots_run_failed', err.message);
        } finally {
          activeRuns.delete(runId);
          activeRunBots.delete(runId);
        }
        break;
      }

      case 'bots/cancel': {
        const startedAt = Date.now();
        try {
          const p = params || {};
          const runId = typeof p.runId === 'string' ? p.runId : '';
          if (!runId) {
            throw Object.assign(new Error('runId required'), { code: 'no_such_run' });
          }
          const ctrl = activeRuns.get(runId);
          if (!ctrl) {
            throw Object.assign(new Error(`no active run: ${runId}`), { code: 'no_such_run' });
          }
          try { ctrl.abort(); } catch { /* ignore */ }
          // The aborted runSendMessageCycle writes its cancelled RunRecord
          // before exiting; we don't write one here to avoid double-write.
          // Audit minimization (T-P4-23): only {runId}. Bot is in envelope.
          audit.appendAudit({
            tool: 'bots.cancel',
            bot: activeRunBots.get(runId) || currentBot,
            params: { runId },
            outcome: 'ok',
            durationMs: Date.now() - startedAt,
          });
          replyResult(id, { ok: true });
        } catch (err) {
          // Audit minimization: error case still keeps params minimal.
          audit.appendAudit({
            tool: 'bots.cancel',
            bot: currentBot,
            params: { runId: (params && typeof params.runId === 'string') ? params.runId : '' },
            outcome: 'error',
            durationMs: Date.now() - startedAt,
            error: { code: err.code || 'bots_cancel_failed', message: err.message },
          });
          replyError(id, err.code || 'bots_cancel_failed', err.message);
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