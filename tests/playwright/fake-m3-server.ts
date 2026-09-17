// In-process fake M3 server. Bound to 127.0.0.1:0 so the OS picks a free port.
// Reuses the real Anthropic SSE envelope so the official SDK parses the
// response cleanly. Exported as a CommonJS-compatible module via `module.exports`
// (Playwright's test runner is CJS-aware).

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

export async function createFakeM3Server(): Promise<FakeM3Server> {
  let requestCount = 0;
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
    requestCount++;

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      let parsed: any = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request', message: 'bad JSON body' } }));
        return;
      }

      res.writeHead(200, SSE_HEADERS);

      const maxTokens: number = parsed.max_tokens ?? 0;
      const userText: string =
        Array.isArray(parsed.messages) && parsed.messages.length > 0
          ? parsed.messages[parsed.messages.length - 1]?.content ?? ''
          : '';

      // The key probe calls messages.create with max_tokens:1 and content 'ping'.
      if (maxTokens === 1 || userText === 'ping') {
        // Reply with one delta token "ok" + a short completion.
        void streamTextResponse(res, 'ok');
      } else {
        // Real chat response: a friendly greeting so the smoke test sees a
        // visible token in the bubble.
        void streamTextResponse(res, 'Hello from fake M3');
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('fake M3 server failed to bind');
  }
  const port = addr.port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    getRequestCount() {
      return requestCount;
    },
  };
}

module.exports = { createFakeM3Server };
