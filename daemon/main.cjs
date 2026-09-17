// Daemon entry point. Pure CommonJS so it runs under process.execPath.

const readline = require('node:readline');
const { writeMessage, readMessage } = require('./protocol.cjs');
const registry = require('./tools/registry.cjs');
const audit = require('./audit.cjs');

const SERVER_INFO = { server: 'localbot-daemon', version: '0.1.0', tools: [] };

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
writeMessage(process.stdout, { kind: 'ready', version: '0.1.0' });

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const obj = readMessage(line);
  if (!obj) {
    // Malformed line. Send a parse error with id=null (JSON-RPC 2.0 §5.1).
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
        const startedAt = Date.now();
        let outcome = 'ok';
        let errPayload = undefined;
        try {
          const result = await registry.callTool(name, args);
          replyResult(id, result);
        } catch (err) {
          outcome = 'error';
          errPayload = { code: err.code || 'unknown_tool', message: err.message };
          replyError(id, err.code || 'unknown_tool', err.message);
        } finally {
          const durationMs = Date.now() - startedAt;
          audit.appendAudit({
            tool: name,
            params: args,
            outcome,
            durationMs,
            error: errPayload,
          });
        }
        break;
      }

      case 'tools/cancel': {
        // Phase 1 stub — no in-flight tools to cancel. Acknowledge.
        replyResult(id, { cancelled: true });
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
