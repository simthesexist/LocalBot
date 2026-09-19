// In-process fake M3 server. Bound to 127.0.0.1:0 so the OS picks a free port.
// Reuses the real Anthropic SSE envelope so the official SDK parses the
// response cleanly. Exported as a CommonJS-compatible module via `module.exports`
// (Playwright's test runner is CJS-aware).
//
// Phase 2 Wave 3: extended with streamToolUseResponse({name, input,
// followupText}) for the smoke-tools test that exercises a tool_use round
// trip end-to-end.

import http from 'node:http';

export interface FakeM3Server {
  url: string;
  port: number;
  close(): Promise<void>;
  /** Number of POST /v1/messages requests received since start. */
  getRequestCount(): number;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'Access-Control-Allow-Origin': '*',
};

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function writeSse(res: http.ServerResponse, chunks: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tick = () => {
      if (i >= chunks.length) {
        res.end();
        resolve();
        return;
      }
      const ok = res.write(chunks[i++], 'utf8', (err) => {
        if (err) reject(err);
      });
      if (ok) {
        setImmediate(tick);
      } else {
        res.once('drain', tick);
      }
    };
    setTimeout(tick, 25); // space the frames ~25ms apart, per Plan 01-02
  });
}

function streamTextResponse(res: http.ServerResponse, text: string): Promise<void> {
  // Split text into small deltas so each one becomes a content_block_delta event.
  const tokens = text.split(/(\s+)/).filter(Boolean);
  const chunks: string[] = [];
  chunks.push(
    sseFrame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'MiniMax/M3',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }),
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
  );
  tokens.forEach((tok, i) => {
    chunks.push(
      sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: tok },
      }),
    );
    // no per-token delay — writeSse already spaces frames at ~25ms each.
    void i;
  });
  chunks.push(
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseFrame('message_stop', { type: 'message_stop' }),
  );
  return writeSse(res, chunks);
}

interface StreamToolUseOpts {
  name: string;
  input: Record<string, unknown>;
  followupText: string;
}

// Phase 3: streamLongResponse is the counterpart to streamTextResponse when
// the test wants to exercise the summarizer / accumulator / soft-cap
// trigger. It deliberately emits input_tokens above SOFT_CAP (default
// 100k) so the main-side logic fires its summarizer path.
interface StreamLongResponseOpts {
  body?: string;
  inputTokens?: number;
  /** Optional output_tokens carried on message_delta (default 1000). */
  outputTokens?: number;
}

function streamLongResponse(
  res: http.ServerResponse,
  opts: StreamLongResponseOpts = {},
): Promise<void> {
  const body = opts.body ?? 'Long response body for memory injection / accumulate tests. '.repeat(40);
  const tokens = body.split(/(\s+)/).filter(Boolean);
  const chunks: string[] = [];
  chunks.push(
    sseFrame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_fake_long',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'MiniMax/M3',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: opts.inputTokens ?? 110_000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
  );
  tokens.forEach((tok) => {
    chunks.push(
      sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: tok },
      }),
    );
  });
  chunks.push(
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: opts.outputTokens ?? 1000 },
    }),
    sseFrame('message_stop', { type: 'message_stop' }),
  );
  return writeSse(res, chunks);
}

function streamToolUseResponse(
  res: http.ServerResponse,
  opts: StreamToolUseOpts,
): Promise<void> {
  const toolUseId = `toolu_fake_${Date.now().toString(36)}`;
  const inputJson = JSON.stringify(opts.input);
  const inputChunks: string[] = [];
  const CHUNK_SIZE = 12;
  for (let i = 0; i < inputJson.length; i += CHUNK_SIZE) {
    inputChunks.push(inputJson.slice(i, i + CHUNK_SIZE));
  }
  const tokens = opts.followupText.split(/(\s+)/).filter(Boolean);

  const chunks: string[] = [];
  chunks.push(
    sseFrame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_fake_tool',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'MiniMax/M3',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }),
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolUseId, name: opts.name, input: {} },
    }),
  );
  inputChunks.forEach((chunk) => {
    chunks.push(
      sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: chunk },
      }),
    );
  });
  chunks.push(
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    }),
  );
  tokens.forEach((tok) => {
    chunks.push(
      sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: tok },
      }),
    );
  });
  chunks.push(
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sseFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
    }),
    sseFrame('message_stop', { type: 'message_stop' }),
  );
  return writeSse(res, chunks);
}

// Phase 3 Wave 3: edit_file tool_use helpers used by tree-diff.test.ts and
// memory-history.test.ts to drive DiffView + binary placeholder paths
// end-to-end. The shape mirrors Anthropic's SSE envelope so the official
// SDK parses it identically.

export interface StreamEditFileOpts {
  /** The substring the bot wants to find inside the target file. */
  find: string;
  /** The substring the bot will write in place of `find`. */
  replace: string;
  /** Free-form text emitted AFTER the tool_use completes. Default "Done". */
  followupText?: string;
  /** File path passed in the tool_use input. Default "hello.txt". */
  path?: string;
  /** Token count carried on message_start. Default 200. */
  inputTokens?: number;
}

/**
 * Build the SSE chunks for an `edit_file` tool_use followed by `followupText`.
 * Mirrors streamToolUseResponse's chunking but with a deterministic, named
 * shape so tests can assert against the same payload every run.
 */
export function buildEditFileToolUseChunks(opts: StreamEditFileOpts): string[] {
  const followupText = opts.followupText ?? 'Done';
  const path = opts.path ?? 'hello.txt';
  const inputTokens = opts.inputTokens ?? 200;
  const toolUseId = 'tu_edit';
  const inputObj = { path, find: opts.find, replace: opts.replace };
  const inputJson = JSON.stringify(inputObj);
  const inputChunks: string[] = [];
  const CHUNK_SIZE = 24;
  for (let i = 0; i < inputJson.length; i += CHUNK_SIZE) {
    inputChunks.push(inputJson.slice(i, i + CHUNK_SIZE));
  }
  const tokens = followupText.split(/(\s+)/).filter(Boolean);

  const chunks: string[] = [];
  chunks.push(
    sseFrame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_fake_edit',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'MiniMax/M3',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolUseId, name: 'edit_file', input: {} },
    }),
  );
  inputChunks.forEach((chunk) => {
    chunks.push(
      sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: chunk },
      }),
    );
  });
  chunks.push(
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    }),
  );
  tokens.forEach((tok) => {
    chunks.push(
      sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: tok },
      }),
    );
  });
  chunks.push(
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sseFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 30 },
    }),
    sseFrame('message_stop', { type: 'message_stop' }),
  );
  return chunks;
}

/**
 * Phase 3 Wave 3 — Edit-File SSE helper. Streams an `edit_file` tool_use
 * envelope for the test that wants to drive the DiffView path end-to-end.
 * Resolves once the stream has been fully written to the response.
 */
export function streamEditFileToolUse(
  res: http.ServerResponse,
  opts: StreamEditFileOpts,
): Promise<void> {
  return writeSse(res, buildEditFileToolUseChunks(opts));
}

/**
 * Phase 3 Wave 3 — Binary edit_file helper. The pre-created workspace
 * fixture (`hello.bin` with a NUL byte) makes the real daemon's `edit_file`
 * return `{binary:true}`; the renderer takes the DiffBinaryPlaceholder path.
 */
export function streamBinaryEditFile(
  res: http.ServerResponse,
  opts: { followupText?: string } = {},
): Promise<void> {
  return streamEditFileToolUse(res, {
    find: 'old',
    replace: 'new',
    path: 'hello.bin',
    followupText: opts.followupText ?? 'Binary edit attempted',
    inputTokens: 150,
  });
}

export async function createFakeM3Server(): Promise<FakeM3Server> {
  // Per-server overrides for the smoke-tools test. When set, every POST is
  // answered with the matching streamToolUseResponse, regardless of tools
  // payload. Undefined = fall back to streamTextResponse based on probe shape.
  // Phase 3: forcedStream now also accepts 'long' so memory-history.test.ts
  // can drive streamLongResponse for the soft-cap / summarizer path. Wave 3
  // adds 'edit_file' + 'binary_edit' so tree-diff.test.ts can drive the
  // DiffView + DiffBinaryPlaceholder paths.
  let forcedToolUse: StreamToolUseOpts | null = null;
  let forcedLong: StreamLongResponseOpts | null = null;
  let forcedEditFile: StreamEditFileOpts | null = null;
  let forcedBinaryEditFile: { followupText?: string } | null = null;
  let forcedStream: 'text' | 'tool_use' | 'long' | 'edit_file' | 'binary_edit' = 'text';

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, x-api-key, anthropic-version',
      });
      res.end();
      return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'not_found', message: 'fake M3 only handles /v1/messages' } }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      // Only count requests we actually accept.
      res.statusCode = 200;
      let parsed: any = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request', message: 'bad JSON body' } }));
        return;
      }

      const maxTokens: number = parsed.max_tokens ?? 0;
      const userText: string =
        Array.isArray(parsed.messages) && parsed.messages.length > 0
          ? parsed.messages[parsed.messages.length - 1]?.content ?? ''
          : '';
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;

      // Increment request count atomically (after parse but before stream).
      requestCount++;

      res.writeHead(200, SSE_HEADERS);

      // ── Per-server forced response (set by smoke-tools.test.ts). ──
      if (forcedStream === 'tool_use' && forcedToolUse) {
        void streamToolUseResponse(res, forcedToolUse);
        return;
      }
      if (forcedStream === 'long' && forcedLong) {
        void streamLongResponse(res, forcedLong);
        return;
      }
      if (forcedStream === 'edit_file' && forcedEditFile) {
        void streamEditFileToolUse(res, forcedEditFile);
        return;
      }
      if (forcedStream === 'binary_edit' && forcedBinaryEditFile) {
        void streamBinaryEditFile(res, forcedBinaryEditFile);
        return;
      }

      // ── Default routing: probe vs real chat. ──
      if (maxTokens === 1 || userText === 'ping') {
        void streamTextResponse(res, 'ok');
        return;
      }

      // ── Phase 3: any user message that starts with "long:" triggers a
      //     streamLongResponse so the renderer can verify the memory
      //     injection / event flow without a separate forced-stream flag. ──
      if (userText.startsWith('long:')) {
        void streamLongResponse(res, {});
        return;
      }

      // Real chat: if the request includes a `tools` array AND the user text
      // explicitly asks for a tool_use response (e.g. "read hello.txt"),
      // emit a tool_use envelope instead. This keeps the test self-contained
      // without requiring the smoke test to mutate server state.
      if (hasTools && /read /.test(userText)) {
        const toolUseOpts: StreamToolUseOpts = {
          name: 'read_file',
          input: { path: 'hello.txt' },
          followupText: 'Reading hello.txt now.',
        };
        void streamToolUseResponse(res, toolUseOpts);
        return;
      }

      void streamTextResponse(res, 'Hello from fake M3');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('fake M3 server failed to bind');
  }
  const port = addr.port;
  const url = `http://127.0.0.1:${port}`;

  let requestCount = 0;
  return {
    url,
    port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    getRequestCount() {
      return requestCount;
    },
    // Internal hook for smoke-tools.test.ts — bypass the default routing.
    __forceToolUse: (opts: StreamToolUseOpts) => {
      forcedToolUse = opts;
      forcedStream = 'tool_use';
    },
    // Phase 3: streamLongResponse hook for memory-history.test.ts.
    __forceLong: (opts: StreamLongResponseOpts = {}) => {
      forcedLong = opts;
      forcedStream = 'long';
    },
    // Phase 3 Wave 3: edit_file tool_use hook for tree-diff.test.ts.
    __forceEditFile: (opts: StreamEditFileOpts) => {
      forcedEditFile = opts;
      forcedStream = 'edit_file';
    },
    // Phase 3 Wave 3: binary edit_file hook for tree-diff.test.ts.
    __forceBinaryEditFile: (opts: { followupText?: string } = {}) => {
      forcedBinaryEditFile = opts;
      forcedStream = 'binary_edit';
    },
  } as FakeM3Server & {
    __forceToolUse: (opts: StreamToolUseOpts) => void;
    __forceLong: (opts?: StreamLongResponseOpts) => void;
    __forceEditFile: (opts: StreamEditFileOpts) => void;
    __forceBinaryEditFile: (opts?: { followupText?: string }) => void;
  };
}

module.exports = {
  createFakeM3Server,
  // Phase 3 Wave 3 — exposed for tests that want to drive their own
  // request lifecycle against the fake server (memory-history + tree-diff).
  buildEditFileToolUseChunks,
  streamEditFileToolUse,
  streamBinaryEditFile,
  // Phase 4 Wave 3 — bot trigger stream helper with abort signal support.
  streamBotTrigger,
  // Phase 6 Wave 3 — cron-trigger helpers for the scheduler E2E smoke.
  streamCronTrigger,
  streamCronError,
};

// ────────────────────────────────────────────────────────────────────────
// Phase 4 Wave 3: streamBotTrigger({bot, port, abortSignal})
//
// A standalone helper (no shared server) that listens on `port` and
// answers every POST /v1/messages with a canned token stream. When
// `abortSignal` fires, emits a final `{event:'cancelled'}` chunk and
// closes the response so the SDK parses the cancellation cleanly.
//
// Used by bot-crud + multi-bot Playwright tests to drive Phase 4's
// bots/trigger surface against the daemon without hitting the real API.
// Logs every emitted chunk to stdout for test debugging (T-P4-30:
// only {event, delta} — never the full prompt body).
// ────────────────────────────────────────────────────────────────────────

export interface StreamBotTriggerOpts {
  bot: string;
  port: number;
  abortSignal: AbortSignal;
  /** Per-token delay in ms (default 25). */
  tokenDelayMs?: number;
}

export async function streamBotTrigger(opts: StreamBotTriggerOpts): Promise<{
  url: string;
  close: () => Promise<void>;
  waitForRequest: () => Promise<{ promptText: string }>;
}> {
  const { bot, port, abortSignal, tokenDelayMs = 25 } = opts;
  let resolveReq!: (v: { promptText: string }) => void;
  const reqP = new Promise<{ promptText: string }>((res) => { resolveReq = res; });

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, x-api-key, anthropic-version',
      });
      res.end();
      return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'not_found', message: 'fake M3 bot trigger only handles /v1/messages' } }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString('utf8'); });
    req.on('end', async () => {
      // Extract the user's prompt text for the test (T-P4-30: only used
      // for the waitForRequest helper, never persisted to audit/log).
      let promptText = '';
      try {
        const parsed = body ? JSON.parse(body) : {};
        promptText = Array.isArray(parsed?.messages) && parsed.messages.length > 0
          ? parsed.messages[parsed.messages.length - 1]?.content ?? ''
          : '';
      } catch { /* ignore malformed bodies */ }

      // Resolve the waitForRequest promise on the FIRST request only.
      resolveReq({ promptText });

      res.writeHead(200, SSE_HEADERS);

      const tokenSeq = ['hello ', 'world ', `from bot ${bot}`, ' — STREAM_END'];
      const chunks: string[] = [
        sseFrame('message_start', {
          type: 'message_start',
          message: {
            id: `msg_fake_${bot}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'MiniMax/M3',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        }),
        sseFrame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      ];
      // eslint-disable-next-line no-console
      console.log(`[fake-m3] bot=${bot} stream-start`);

      let i = 0;
      const tick = () => {
        if (abortSignal.aborted) {
          // Cancellation marker so the daemon's @anthropic-ai/sdk abort
          // path emits the truncated cancellation message.
          chunks.push(sseFrame('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: ' [cancelled]' },
          }));
          chunks.push(
            sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
            sseFrame('message_stop', { type: 'message_stop' }),
          );
          // eslint-disable-next-line no-console
          console.log(`[fake-m3] bot=${bot} stream-cancelled after ${i} tokens`);
          writeSse(res, chunks).catch(() => { /* ignore */ });
          return;
        }
        if (i >= tokenSeq.length) {
          chunks.push(
            sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
            sseFrame('message_stop', { type: 'message_stop' }),
          );
          // eslint-disable-next-line no-console
          console.log(`[fake-m3] bot=${bot} stream-end after ${i} tokens`);
          writeSse(res, chunks).catch(() => { /* ignore */ });
          return;
        }
        const tok = tokenSeq[i++];
        chunks.push(sseFrame('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: tok },
        }));
        // eslint-disable-next-line no-console
        console.log(`[fake-m3] bot=${bot} token: ${JSON.stringify(tok)}`);
        setTimeout(tick, tokenDelayMs);
      };
      tick();
    });
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  // eslint-disable-next-line no-console
  console.log(`[fake-m3] streamBotTrigger listening on 127.0.0.1:${port} for bot=${bot}`);

  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    waitForRequest: () => reqP,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Phase 6 Wave 3: streamCronTrigger / streamCronError
//
// Cron-fire helpers used by tests/playwright/scheduler-notification.test.ts
// to drive the full Phase 6 stack from a fake M3 cron stream to the
// daemon's bots/trigger path with trigger='cron'.
//
// Mirrors streamBotTrigger's signature; each helper binds a server to
// `port` and answers every POST /v1/messages with a canned SSE envelope.
// ────────────────────────────────────────────────────────────────────────

export interface StreamCronTriggerOpts {
  bot: string;
  port: number;
  abortSignal: AbortSignal;
  /** Follow-up text emitted after the tool_use completes. Default mirrors streamBotTrigger. */
  followupText?: string;
  /** Token delay between frames in ms (default 25). */
  tokenDelayMs?: number;
}

/**
 * Streams a complete cron-fired run: a tool_use block (so the daemon
 * records a meaningful RunRecord), a brief assistant text follow-up,
 * then {event:'message_stop'}. Mirrors streamBotTrigger's chunking so
 * the daemon's runSendMessageCycle parses it identically.
 */
export async function streamCronTrigger(
  opts: StreamCronTriggerOpts,
): Promise<{ url: string; close: () => Promise<void> }> {
  const { bot, port, abortSignal, followupText, tokenDelayMs = 25 } = opts;
  const toolUseId = `toolu_cron_${Date.now().toString(36)}`;
  const inputJson = JSON.stringify({ op: 'check_in' });
  const inputChunks: string[] = [];
  const CHUNK_SIZE = 12;
  for (let i = 0; i < inputJson.length; i += CHUNK_SIZE) {
    inputChunks.push(inputJson.slice(i, i + CHUNK_SIZE));
  }
  const tokens = (followupText ?? `cron check-in complete for ${bot}`).split(/(\s+)/).filter(Boolean);

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, x-api-key, anthropic-version',
      });
      res.end();
      return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'not_found', message: 'fake M3 cron trigger only handles /v1/messages' } }));
      return;
    }
    // Discard the body — the cron test does not need to inspect prompts.
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, SSE_HEADERS);
      const chunks: string[] = [
        sseFrame('message_start', {
          type: 'message_start',
          message: {
            id: `msg_fake_cron_${bot}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'MiniMax/M3',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        }),
        sseFrame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: toolUseId, name: 'read_file', input: {} },
        }),
      ];
      inputChunks.forEach((chunk) => {
        chunks.push(
          sseFrame('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: chunk },
          }),
        );
      });
      chunks.push(
        sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
        sseFrame('content_block_start', {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        }),
      );
      // Emit the assistant follow-up text in small deltas.
      tokens.forEach((tok) => {
        chunks.push(
          sseFrame('content_block_delta', {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: tok },
          }),
        );
      });
      chunks.push(
        sseFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
        sseFrame('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 40 },
        }),
        sseFrame('message_stop', { type: 'message_stop' }),
      );
      writeSse(res, chunks).catch(() => { /* ignore */ });
      // Cancel-on-abort is not exercised by the cron test (the cycle
      // completes synchronously in <1s), but mirror streamBotTrigger's
      // shape for forward compatibility.
      void abortSignal;
      void tokenDelayMs;
    });
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  // eslint-disable-next-line no-console
  console.log(`[fake-m3] streamCronTrigger listening on 127.0.0.1:${port} for bot=${bot}`);
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface StreamCronErrorOpts {
  bot: string;
  port: number;
  /** Error message the LLM returns; default 'simulated cron failure'. */
  errorMessage?: string;
  abortSignal: AbortSignal;
}

/**
 * Streams a cron-fired run that ENDS IN AN ERROR. The LLM returns a
 * tool_use for an unknown tool followed by a tool_result with
 * isError:true, which causes runSendMessageCycle to emit exitReason:
 * 'errored'. The daemon then emits the `notification:scheduled-error`
 * event when bot.notifyOnError !== false (default).
 *
 * Mirrors Phase 5's exec-command error stream shape so the daemon's
 * existing error-handling path is exercised.
 */
export async function streamCronError(
  opts: StreamCronErrorOpts,
): Promise<{ url: string; close: () => Promise<void> }> {
  const { bot, port, errorMessage, abortSignal } = opts;
  const errMsg = errorMessage ?? 'simulated cron failure';
  const toolUseId = `toolu_cron_err_${Date.now().toString(36)}`;
  const toolResultId = `toolu_cron_result_${Date.now().toString(36)}`;

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, x-api-key, anthropic-version',
      });
      res.end();
      return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'not_found', message: 'fake M3 cron error only handles /v1/messages' } }));
      return;
    }
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, SSE_HEADERS);
      const chunks: string[] = [
        sseFrame('message_start', {
          type: 'message_start',
          message: {
            id: `msg_fake_cron_err_${bot}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'MiniMax/M3',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        }),
        sseFrame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: toolUseId, name: 'unknown_tool_for_test', input: {} },
        }),
        sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
        sseFrame('content_block_start', {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        }),
        // The "error" path: the LLM says it can't complete the task and
        // returns the user-supplied error message as a text block.
        sseFrame('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: errMsg },
        }),
        sseFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
        sseFrame('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 12 },
        }),
        sseFrame('message_stop', { type: 'message_stop' }),
      ];
      // Reference both IDs so eslint doesn't flag unused locals; the
      // tool_use_id pairing matters for any future test that asserts
      // the round-trip via tool_result blocks.
      void toolResultId;
      writeSse(res, chunks).catch(() => { /* ignore */ });
      void abortSignal;
    });
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  // eslint-disable-next-line no-console
  console.log(`[fake-m3] streamCronError listening on 127.0.0.1:${port} for bot=${bot}`);
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
