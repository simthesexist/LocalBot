// Phase 9 Plan 1: WebSocket message dispatcher.
//
// `dispatchWsMessage(ws, req)` is invoked once per WebSocket connection
// from startNetworkServer's `WebSocketServer.on('connection', ...)` hook.
// The handler:
//   - JSON-parses incoming frames with a try/catch (malformed → drop
//     silently, Pitfall 1)
//   - Validates shape: type=='sendMessage', msgId non-empty string,
//     content non-empty string <= 4096 chars, bot optional non-empty
//     string. Unknown types are dropped silently (Pitfall 1).
//   - Registers an AbortController in the module-scope `activeWsRuns`
//     map keyed by msgId (mirrors chat.ts activeStreams at L41).
//   - Calls the SAME runAgenticLoop that src/main/ipc/chat.ts uses —
//     the phone chat cycle IS the desktop chat cycle (NET-02 invariant).
//   - Streams token/toolUse/toolResult events as `{type, msgId, ...}`
//     JSON frames back over the same ws.
//   - On WS close, aborts every active run for that connection (Pitfall:
//     a dropped phone must NOT leave an orphan LLM call chewing tokens).
//
// Audit minimization (T-9-04, Pitfall 1): the audit row for a WS
// sendMessage carries ONLY `{action:'ws.send_message', bot, msgId,
// durationMs, outcome}`. NEVER message content, bot persona, or token
// deltas. The audit is written from startNetworkServer's `bind` event so
// the audit shape is consistent across WS origins.

import http from 'node:http';
import type { WebSocket as WsWebSocket } from 'ws';
import { runAgenticLoop } from '../llm/loop';
import { TOOL_SCHEMAS } from '../llm/tools';
import { loadConfigIntoSystemPrompt } from '../bots/policy';
import { readMemory, injectMemorySuffix } from '../bots/memory';
import { DEFAULT_SYSTEM_PROMPT_BASE } from '../llm/prompts';

// ws@8 emits Buffer frames by default. We coerce to string before JSON.parse.
type RawFrame = Buffer | string | ArrayBuffer | Buffer[];

// Per-msgId AbortController map; mirrors chat.ts activeStreams (L41).
// Test seam: the test file resets this map between cases via __reset in
// src/main/network/index.ts.
const activeWsRuns = new Map<string, AbortController>();

const MAX_CONTENT_BYTES = 4096;

function safeSend(ws: WsWebSocket, payload: unknown): void {
  try {
    // ws@8: send is synchronous against an open socket. Wrapped in try/catch
    // so a mid-stream close cannot crash the dispatch loop.
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(payload));
    }
  } catch {
    /* swallow — client likely gone */
  }
}

function asWs(value: unknown): WsWebSocket {
  // Cast helper so the test seam can pass a partial mock without pulling
  // in the real ws module types at the import boundary.
  return value as WsWebSocket;
}

function asRawFrame(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  // ws@8 can send an array of buffers (one per message fragment). Coalesce.
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.map((b) => (Buffer.isBuffer(b) ? b : Buffer.from(b as ArrayBuffer))))
      .toString('utf8');
  }
  return '';
}

interface CancelMessage {
  type: 'cancel';
  msgId: string;
}
interface SendMessageFrame {
  type: 'sendMessage';
  msgId: string;
  content: string;
  bot: string;
}

function isCancelMessage(msg: unknown): msg is CancelMessage {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return m.type === 'cancel' && typeof m.msgId === 'string' && m.msgId.length > 0;
}

function isSendMessageFrame(msg: unknown): msg is SendMessageFrame {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'sendMessage') return false;
  if (typeof m.msgId !== 'string' || m.msgId.length === 0) return false;
  if (typeof m.content !== 'string') return false;
  if (m.content.length === 0 || m.content.length > MAX_CONTENT_BYTES) return false;
  if (m.bot !== undefined && (typeof m.bot !== 'string' || m.bot.length === 0)) return false;
  return true;
}

/**
 * Test seam: peek at the activeWsRuns map WITHOUT exposing it for mutation.
 * Returns the count + msgIds currently in flight (used by ws_handlers.test.ts
 * to assert cancel-on-close + abort propagation).
 */
export function _activeRunCount(): number {
  return activeWsRuns.size;
}

/** Test seam: clear the activeWsRuns map (used between cases). */
export function __resetWsRuns(): void {
  for (const ac of activeWsRuns.values()) {
    try { ac.abort(); } catch { /* ignore */ }
  }
  activeWsRuns.clear();
}

/**
 * Attach dispatchWsMessage to a single ws connection. The function returns
 * a Promise so callers can `await` the dispatcher's lifetime, but in
 * practice the `on('close')` handler keeps the connection alive until the
 * client disconnects — the promise resolves earlier.
 *
 * `_req` is the IncomingMessage; kept in the signature for parity with
 * Phase 7 vault/server.ts and any future auth challenge (Pitfall 1: Wave 1
 * has no auth, but a `req.headers.host` / `req.socket.remoteAddress` peek
 * lands in Wave 2 alongside Tailscale detection).
 */
export function dispatchWsMessage(ws: unknown, _req: http.IncomingMessage): Promise<void> {
  const conn = asWs(ws);
  return new Promise<void>((resolve) => {
    let closed = false;
    const cleanup = () => {
      // On WS close, abort every in-flight run originating from this
      // connection. The handler map is keyed by msgId, not by ws, so we
      // can't tell which msgIds belong to which connection — we abort ALL
      // of them when ANY client disconnects. Phase 9 v1 has a single
      // phone client at a time, so this is acceptable; Wave 2 splits the
      // map per-connection if needed.
      for (const ac of activeWsRuns.values()) {
        try { ac.abort(); } catch { /* ignore */ }
      }
      activeWsRuns.clear();
      closed = true;
      resolve();
    };

    conn.on('close', cleanup);
    conn.on('error', () => { /* keep dispatcher alive on socket error */ });

    conn.on('message', async (raw: RawFrame) => {
      if (closed) return;
      const text = asRawFrame(raw);
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        // Pitfall 1: malformed JSON dropped silently — no leak to client.
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      // Cancel path: abort the per-msgId controller for an in-flight run.
      if (isCancelMessage(msg)) {
        const ac = activeWsRuns.get(msg.msgId);
        if (ac) {
          try { ac.abort(); } catch { /* ignore */ }
        }
        return;
      }

      // Send path: validate shape, run one chat cycle, stream events back.
      if (!isSendMessageFrame(msg)) {
        return;
      }

      const ac = new AbortController();
      activeWsRuns.set(msg.msgId, ac);

      const startedAt = Date.now();
      const bot = msg.bot;

      // Mirror chat.ts sendMessageStarted so the phone can render a
      // optimistic "thinking" pill without waiting for the first token.
      safeSend(conn, { type: 'messageStarted', msgId: msg.msgId, bot });

      try {
        // System prompt + memory suffix — mirrors chat.ts L179-188.
        let personaSystem = DEFAULT_SYSTEM_PROMPT_BASE;
        try {
          const loaded = await loadConfigIntoSystemPrompt(bot);
          personaSystem = loaded.system;
        } catch {
          // Unknown bot / loadConfig failure → fall back to base system
          // prompt (mirrors chat.ts defensive default).
        }
        const mem = await readMemory(bot);
        const system = injectMemorySuffix(personaSystem, mem.markdown, mem.facts);

        const result = await runAgenticLoop({
          messages: [{ ts: startedAt, role: 'user', content: msg.content }],
          system,
          tools: TOOL_SCHEMAS,
          signal: ac.signal,
          bot,
          onToken: (delta) => safeSend(conn, { type: 'token', msgId: msg.msgId, delta }),
          onToolUse: (b) => safeSend(conn, {
            type: 'toolUse',
            msgId: msg.msgId,
            toolUseId: b.id,
            name: b.name,
            input: b.input,
          }),
          onToolResult: (r) => safeSend(conn, {
            type: 'toolResult',
            msgId: msg.msgId,
            toolUseId: r.toolUseId,
            content: r.content,
            isError: r.isError,
          }),
        });
        // Wave 1 ignores the loopResult.audit envelope — only the message
        // end + audit minimization matters here.
        void result;
        safeSend(conn, { type: 'messageDone', msgId: msg.msgId });
      } catch (err) {
        // Cancel + fatal errors both surface here. chat.ts distinguishes
        // 'cancelled' from other categories via classifyError; for Wave 1
        // we treat any throw as a messageError envelope (the phone can
        // surface "something went wrong" without picking the cancellation
        // vs fatal distinction apart). The audit row below picks the
        // outcome from the error shape.
        const message = (err instanceof Error) ? err.message : String(err);
        safeSend(conn, { type: 'messageError', msgId: msg.msgId, error: message });
      } finally {
        activeWsRuns.delete(msg.msgId);
      }
    });
  });
}
