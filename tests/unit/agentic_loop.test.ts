// Unit tests for src/main/llm/loop.ts (runAgenticLoop).
// Run with: `npm test`
//
// Stubs the SDK client (streamChat) and the daemon callTool with vi.fn so we
// can script multi-turn flows without hitting a real Anthropic stream or the
// tool daemon. The streamChat mock invokes the onToken / onToolUse callbacks
// to mimic what the real client does on content_block_delta /
// content_block_stop events.
//
// Asserts:
//   1. Single tool_use → dispatch → resume → end_turn (turns=2)
//   2. Tool errors surface as tool_result {isError:true}, do NOT throw
//   3. maxTurns exceeded → throws fatal error
//   4. Pure end_turn (no tool_use) → turns=1

vi.mock('../../src/main/llm/client', () => ({
  streamChat: vi.fn(),
}));
vi.mock('../../src/main/daemon/spawn', () => ({
  callTool: vi.fn(),
}));

import { describe, it, expect, vi } from 'vitest';

import { streamChat } from '../../src/main/llm/client';
import { callTool } from '../../src/main/daemon/spawn';
import { runAgenticLoop } from '../../src/main/llm/loop';

const streamChatMock = streamChat as unknown as ReturnType<typeof vi.fn>;
const callToolMock = callTool as unknown as ReturnType<typeof vi.fn>;

/**
 * Wire the streamChat mock to fire onToken / onToolUse like the real client
 * does, then resolve to the given stopReason + blocks. Tracks the most recent
 * set of callbacks so each mockResolvedValueOnce can re-trigger them.
 */
function scriptedStream(
  plan: Array<{
    stopReason: 'tool_use' | 'end_turn' | null;
    blocks: Array<{ type: string; [k: string]: unknown }>;
  }>,
) {
  plan.forEach((turn) => {
    streamChatMock.mockImplementationOnce(async (opts: any) => {
      // Emit text tokens.
      for (const b of turn.blocks) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
          opts.onToken(b.text);
        } else if (b.type === 'tool_use') {
          opts.onToolUse({ kind: 'tool_use', id: b.id, name: b.name, input: b.input });
        }
      }
      opts.onDone();
      return { stopReason: turn.stopReason, blocks: turn.blocks };
    });
  });
}

function resetMocks() {
  streamChatMock.mockReset();
  callToolMock.mockReset();
}

describe('runAgenticLoop', () => {
  it('dispatches a single tool_use and resumes once', async () => {
    resetMocks();
    scriptedStream([
      {
        stopReason: 'tool_use',
        blocks: [
          { type: 'text', text: 'I will read it.' },
          { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } },
        ],
      },
      {
        stopReason: 'end_turn',
        blocks: [{ type: 'text', text: 'Here it is.' }],
      },
    ]);
    callToolMock.mockResolvedValueOnce({ result: { content: 'hello' } });

    const toolUses: unknown[] = [];
    const toolResults: Array<{ toolUseId: string; content: string; isError: boolean }> = [];
    const tokens: string[] = [];

    const result = await runAgenticLoop({
      messages: [{ ts: 1, role: 'user', content: 'read a.txt' }],
      system: 'system',
      tools: [],
      signal: new AbortController().signal,
      onToken: (d) => tokens.push(d),
      onToolUse: (b) => toolUses.push(b),
      onToolResult: (r) => toolResults.push(r),
    });

    expect(toolUses).toEqual([
      { kind: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } },
    ]);
    expect(toolResults).toEqual([{ toolUseId: 'tu_1', content: 'hello', isError: false }]);
    expect(tokens.join('')).toBe('I will read it.Here it is.');
    expect(result.turns).toBe(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].output).toBe('hello');
    expect(result.toolCalls[0].isError).toBe(false);
  });

  it('surfaces tool errors as tool_result {isError:true} and does not throw', async () => {
    resetMocks();
    scriptedStream([
      {
        stopReason: 'tool_use',
        blocks: [
          { type: 'tool_use', id: 'tu_x', name: 'read_file', input: { path: '../etc/passwd' } },
        ],
      },
      {
        stopReason: 'end_turn',
        blocks: [{ type: 'text', text: 'Denied.' }],
      },
    ]);
    // JSON-RPC error envelope (the shape that spawn.callTool resolves with on
    // a tool rejection).
    callToolMock.mockResolvedValueOnce({
      error: { code: 'outside_workspace', message: 'path escapes workspace: ../etc/passwd' },
    });

    const toolResults: Array<{ toolUseId: string; content: string; isError: boolean }> = [];

    const result = await runAgenticLoop({
      messages: [{ ts: 1, role: 'user', content: 'escape' }],
      system: 'system',
      tools: [],
      signal: new AbortController().signal,
      onToken: () => {},
      onToolUse: () => {},
      onToolResult: (r) => toolResults.push(r),
    });

    expect(toolResults).toEqual([
      { toolUseId: 'tu_x', content: expect.stringMatching(/outside_workspace/), isError: true },
    ]);
    expect(result.turns).toBe(2);
    expect(result.toolCalls[0].isError).toBe(true);
  });

  it('honors maxTurns: emits fatal error when exceeded', async () => {
    resetMocks();
    // Always returns tool_use so we never reach end_turn. Fires onToolUse.
    streamChatMock.mockImplementation(async (opts: any) => {
      opts.onToolUse({ kind: 'tool_use', id: 'loop', name: 'list_dir', input: { path: '.' } });
      opts.onDone();
      return {
        stopReason: 'tool_use',
        blocks: [{ type: 'tool_use', id: 'loop', name: 'list_dir', input: { path: '.' } }],
      };
    });
    callToolMock.mockResolvedValue({ result: { entries: [] } });

    await expect(
      runAgenticLoop({
        messages: [{ ts: 1, role: 'user', content: 'loop' }],
        system: 'system',
        tools: [],
        signal: new AbortController().signal,
        maxTurns: 3,
        onToken: () => {},
        onToolUse: () => {},
        onToolResult: () => {},
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/maxTurns=3/) });
  });

  it('returns turns=1 when the first stream finishes without tool_use', async () => {
    resetMocks();
    scriptedStream([
      {
        stopReason: 'end_turn',
        blocks: [{ type: 'text', text: 'Just a reply.' }],
      },
    ]);

    const result = await runAgenticLoop({
      messages: [{ ts: 1, role: 'user', content: 'hi' }],
      system: 'system',
      tools: [],
      signal: new AbortController().signal,
      onToken: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
    });

    expect(result.turns).toBe(1);
    expect(result.text).toBe('Just a reply.');
    expect(callToolMock).not.toHaveBeenCalled();
  });
});