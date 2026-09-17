// Daemon entry point. Pure CommonJS so it runs under process.execPath.

const readline = require('node:readline');
const { writeMessage, readMessage } = require('./protocol.cjs');
const registry = require('./tools/registry.cjs');
const audit = require('./audit.cjs');

// Phase 2: per-bot policy lives in the daemon; the orchestrator (main)
// forwards params.bot on initialize and params.bot on every tools/call.
// The 'tools' field in SERVER_INFO is a placeholder list of *names* (Phase 1
// compat). The full schemas come from registry.listTools().
const SERVER_INFO = { server: 'localbot-daemon', version: '0.2.0', tools: [] };

let nextId = 1;
const pendingReady = { resolve: null, reject: null };

function reply(obj) {
  writeMessage(process.stdout, obj);
}

function replyError(id, code, message) {
  reply({ jsonrpc: '2.0', id, error: { code, message } });
}

function replyResult(id, result) {
  reply({ jsonrpc: '2.0', id, result });
}

// Handshake: write { kind: 'ready' } as the very first line.
writeMessage(process.stdout, { kind: 'ready', version: '0.2.0' });

const rl = readline.createInterface({ input: process.stdin });

// Phase 2: workspaceRoot is latched on initialize and threaded into every
// tools/call ctx. It MUST NOT come from any caller other than initialize.
let workspaceRoot = null;
let currentBot = 'default';

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
        replyResult(id, { ...SERVER_INFO, tools: registry.listTools() });
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
        try {
          const result = await registry.callTool(bot, name, args, {
            workspaceRoot,
            toolCallId,
            bot,
          });
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
          const durationMs = Date.now() - startedAt;
          audit.appendAudit({
            tool: name,
            bot,
            params: args,
            outcome,
            durationMs,
            error: errPayload,
            tool_use_id: toolCallId,
          });
        }
        break;
      }

      case 'tools/cancel': {
        const toolCallId = (params && typeof params.toolCallId === 'string') ? params.toolCallId : '';
        replyResult(id, registry.cancelToolCall(toolCallId));
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

rl.on('close', () => {
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
