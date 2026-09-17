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

export async function createFakeM3Server(): Promise<FakeM3Server> {
  // Per-server overrides for the smoke-tools test. When set, every POST is
  // answered with the matching streamToolUseResponse, regardless of tools
  // payload. Undefined = fall back to streamTextResponse based on probe shape.
  let forcedToolUse: StreamToolUseOpts | null = null;
  let forcedStream: 'text' | 'tool_use' = 'text';

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

      // ── Default routing: probe vs real chat. ──
      if (maxTokens === 1 || userText === 'ping') {
        void streamTextResponse(res, 'ok');
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
  } as FakeM3Server & { __forceToolUse: (opts: StreamToolUseOpts) => void };
}

module.exports = { createFakeM3Server };
