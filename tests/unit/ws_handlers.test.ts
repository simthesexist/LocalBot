// Phase 9 Plan 1: tests for src/main/network/handlers.ts — WS message
// dispatch (sendMessage round-trip + cancel + malformed-JSON drop +
// unknown-type drop + msgId validation + content cap + ws.close abort).
//
// Strategy:
//   - vi.mock the LLM loop + persona/memory helpers so no real LLM call
//     happens (these modules are slow + require a config.toml + API key).
//   - Construct a `makeMockWs()` that mimics the subset of ws.WebSocket the
//     handlers touch: send(), on('message'), on('close'). Fire 'message'
//     payloads via `fireMessage`; observe what was sent via the `sent`
//     array.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'node:http';

type Frame = Record<string, unknown>;

interface MockWs {
  ws: unknown;
  sent: Frame[];
  fireMessage: (raw: string) => Promise<void>;
  fireClose: () => void;
}

function makeMockWs(): MockWs {
  const sent: Frame[] = [];
  let onMessage: ((raw: unknown) => void) | null = null;
  let onClose: (() => void) | null = null;

  const ws = {
    readyState: 1,
    send: (data: string) => {
      try {
        sent.push(JSON.parse(data) as Frame);
      } catch {
        sent.push({ raw: data });
      }
    },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'message') onMessage = cb as (raw: unknown) => void;
      if (event === 'close') onClose = cb as () => void;
    },
  };

  return {
    ws,
    sent,
    // Fire-and-forget: handlers.ts registers an async onMessage handler;
    // awaiting the handler would deadlock cases that mock runAgenticLoop
    // to suspend indefinitely (cancel/abort coverage). Tests yield with
    // setTimeout afterwards to allow microtasks to flush.
    fireMessage: (raw: string) => {
      if (onMessage) {
        void onMessage(Buffer.from(raw));
      }
    },
    fireClose: () => {
      if (onClose) onClose();
    },
  };
}

// vi.mock is hoisted above all imports. The factory must NOT reference any
// outer-scope variables. Each mocked function is a vi.fn() so the test can
// assert call shape AND drive behavior (resolve / reject / invoke callbacks).
let mockRunLoop: ReturnType<typeof vi.fn>;
let mockLoadConfig: ReturnType<typeof vi.fn>;
let mockReadMemory: ReturnType<typeof vi.fn>;

vi.mock('../../src/main/llm/loop', () => ({
  runAgenticLoop: (...args: unknown[]) => mockRunLoop(...args),
}));

vi.mock('../../src/main/bots/policy', () => ({
  loadConfigIntoSystemPrompt: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock('../../src/main/bots/memory', () => ({
  readMemory: (...args: unknown[]) => mockReadMemory(...args),
  injectMemorySuffix: (base: string, _md: string, _facts: unknown) => base,
}));

// eslint-disable-next-line import/first
import { dispatchWsMessage, _activeRunCount, __resetWsRuns } from '../../src/main/network/handlers';

function makeFakeReq(): http.IncomingMessage {
  return { url: '/', headers: {} } as unknown as http.IncomingMessage;
}

beforeEach(() => {
  mockRunLoop = vi.fn(async () => ({ text: '', toolCalls: [], blocks: [], turns: 1 }));
  mockLoadConfig = vi.fn(async (bot: string) => ({
    config: { id: bot, name: bot, persona: '' },
    system: `system-for-${bot}`,
  }));
  mockReadMemory = vi.fn(async () => ({ markdown: '', facts: {} }));
  __resetWsRuns();
});

describe('ws_handlers — dispatchWsMessage', () => {
  it('Case A: sendMessage round-trip — messageStarted + token + messageDone are sent in order', async () => {
    // The mock drives runAgenticLoop to invoke onToken + resolve.
    mockRunLoop = vi.fn(async (opts) => {
      // Yield a token synchronously to make the sent[] ordering assertable.
      opts.onToken('Hi');
      // Then resolve (mirrors a successful chat completion).
      return { text: 'Hi', toolCalls: [], blocks: [], turns: 1 };
    });

    const fx = makeMockWs();
    void dispatchWsMessage(fx.ws, makeFakeReq()).catch(() => undefined);
    fx.fireMessage(JSON.stringify({ type: 'sendMessage', msgId: 'm1', content: 'hello', bot: 'default' }));

    // Allow microtasks to flush (handlers.ts awaits loadConfigIntoSystemPrompt).
    await new Promise((r) => setTimeout(r, 50));

    const types = fx.sent.map((s) => s.type);
    expect(types[0]).toBe('messageStarted');
    // token arrived (assert presence).
    expect(types).toContain('token');
    expect(types[types.length - 1]).toBe('messageDone');

    // The signal was cleaned up — _activeRunCount back to 0 after completion.
    expect(_activeRunCount()).toBe(0);
  });

  it('Case B: cancel mid-stream — AbortController is aborted when cancel frame arrives', async () => {
    let capturedSignal: AbortSignal | undefined;
    // runAgenticLoop awaits a deferred promise so the test can fire a
    // cancel frame mid-flight.
    let resolveLoop: ((v: unknown) => void) | undefined;
    mockRunLoop = vi.fn(async (opts) => {
      capturedSignal = opts.signal;
      await new Promise<unknown>((resolve) => { resolveLoop = resolve; });
      // After abort, opts.signal.aborted is true.
      if (opts.signal.aborted) {
        const err = new Error('aborted') as Error & { code: string };
        err.code = 'aborted';
        throw err;
      }
      return { text: '', toolCalls: [], blocks: [], turns: 1 };
    });

    const fx = makeMockWs();
    void dispatchWsMessage(fx.ws, makeFakeReq()).catch(() => undefined);

    fx.fireMessage(JSON.stringify({ type: 'sendMessage', msgId: 'm2', content: 'go', bot: 'default' }));
    // Wait for the runAgenticLoop call to land so capturedSignal is set.
    await new Promise((r) => setTimeout(r, 50));
    expect(capturedSignal).toBeDefined();

    // Fire the cancel frame.
    fx.fireMessage(JSON.stringify({ type: 'cancel', msgId: 'm2' }));
    // Allow the abort handler to fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedSignal?.aborted).toBe(true);

    // Resolve the suspended runAgenticLoop; the abort path in the mock
    // throws, which causes handlers.ts to send `messageError`.
    (resolveLoop as unknown as (v: unknown) => void)(undefined);
    await new Promise((r) => setTimeout(r, 30));

    expect(fx.sent.map((s) => s.type)).toContain('messageError');
    expect(_activeRunCount()).toBe(0);
  });

  it('Case C: malformed JSON dropped silently (no message sent)', async () => {
    const fx = makeMockWs();
    void dispatchWsMessage(fx.ws, makeFakeReq()).catch(() => undefined);

    fx.fireMessage('not-json');
    await new Promise((r) => setTimeout(r, 30));

    expect(fx.sent).toHaveLength(0);
  });

  it('Case D: unknown msg.type dropped — no sendMessage envelope emitted', async () => {
    const fx = makeMockWs();
    void dispatchWsMessage(fx.ws, makeFakeReq()).catch(() => undefined);

    fx.fireMessage(JSON.stringify({ type: 'totally-unknown', msgId: 'm3', content: 'x' }));
    await new Promise((r) => setTimeout(r, 30));

    expect(fx.sent).toHaveLength(0);
    expect(mockRunLoop).not.toHaveBeenCalled();
  });

  it('Case E: missing msgId drops the frame', async () => {
    const fx = makeMockWs();
    void dispatchWsMessage(fx.ws, makeFakeReq()).catch(() => undefined);

    fx.fireMessage(JSON.stringify({ type: 'sendMessage', content: 'hi' }));
    await new Promise((r) => setTimeout(r, 30));

    expect(fx.sent).toHaveLength(0);
    expect(mockRunLoop).not.toHaveBeenCalled();
  });

  it('Case F: content >= 4097 chars drops the frame (DoS hardening)', async () => {
    const fx = makeMockWs();
    void dispatchWsMessage(fx.ws, makeFakeReq()).catch(() => undefined);

    const big = 'x'.repeat(4097);
    fx.fireMessage(JSON.stringify({ type: 'sendMessage', msgId: 'm6', content: big, bot: 'default' }));
    await new Promise((r) => setTimeout(r, 30));

    expect(fx.sent).toHaveLength(0);
    expect(mockRunLoop).not.toHaveBeenCalled();
  });

  it('Case G: empty content drops the frame', async () => {
    const fx = makeMockWs();
    void dispatchWsMessage(fx.ws, makeFakeReq()).catch(() => undefined);

    fx.fireMessage(JSON.stringify({ type: 'sendMessage', msgId: 'm7', content: '', bot: 'default' }));
    await new Promise((r) => setTimeout(r, 30));

    expect(fx.sent).toHaveLength(0);
    expect(mockRunLoop).not.toHaveBeenCalled();
  });

  it('Case H: ws.close aborts in-flight runAgenticLoop via signal.aborted', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockRunLoop = vi.fn(async (opts) => {
      capturedSignal = opts.signal;
      // Suspend forever; close() will abort the signal.
      await new Promise(() => undefined);
      return { text: '', toolCalls: [], blocks: [], turns: 1 };
    });

    const fx = makeMockWs();
    void dispatchWsMessage(fx.ws, makeFakeReq()).catch(() => undefined);

    fx.fireMessage(JSON.stringify({ type: 'sendMessage', msgId: 'm8', content: 'in-flight', bot: 'default' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(capturedSignal).toBeDefined();

    fx.fireClose();
    await new Promise((r) => setTimeout(r, 30));

    expect(capturedSignal?.aborted).toBe(true);
    // After close, no controllers are left in the active map.
    expect(_activeRunCount()).toBe(0);
  });

  it('Case I: bot falls back to "default" when omited (mirrors IPC behavior)', async () => {
    mockRunLoop = vi.fn(async (opts) => {
      // Verify the bot default is propagated to runAgenticLoop.
      expect(opts.bot).toBe('default');
      return { text: '', toolCalls: [], blocks: [], turns: 1 };
    });

    const fx = makeMockWs();
    void dispatchWsMessage(fx.ws, makeFakeReq()).catch(() => undefined);

    // Omit bot field entirely.
    fx.fireMessage(JSON.stringify({ type: 'sendMessage', msgId: 'm9', content: 'hi' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(mockRunLoop).toHaveBeenCalledTimes(1);
    expect(fx.sent.map((s) => s.type)).toContain('messageStarted');
    expect(fx.sent[0]?.bot).toBe('default');
  });
});
