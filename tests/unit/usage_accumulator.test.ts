// Unit tests for src/main/llm/usageAccumulator.ts.
//
// Tracks message_start (input + cache tokens) and message_delta (output +
// cache tokens) stream events. `total()` sums all four buckets; `clear()`
// drops the per-msgId row.

import { describe, it, expect, beforeEach } from 'vitest';
import * as accumulator from '../../src/main/llm/usageAccumulator';
import type Anthropic from '@anthropic-ai/sdk';

function messageStart(inputTokens: number): Anthropic.Messages.MessageStreamEvent {
  // Shape from @anthropic-ai/sdk's MessageStartEvent. Only `usage` is read
  // by the accumulator; other fields are typed-as-unknown below.
  return {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'm3',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 7,
        output_tokens: 0,
      },
    } as unknown as Anthropic.Messages.Message,
  } as unknown as Anthropic.Messages.MessageStreamEvent;
}

function messageDelta(outputTokens: number): Anthropic.Messages.MessageStreamEvent {
  return {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null } as Anthropic.Messages.MessageDelta,
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 11,
      cache_read_input_tokens: 13,
      output_tokens: outputTokens,
    } as Anthropic.Messages.Usage,
  } as unknown as Anthropic.Messages.MessageStreamEvent;
}

beforeEach(() => {
  accumulator.__resetForTests();
});

describe('usageAccumulator', () => {
  it('message_start captures input + cache buckets', () => {
    accumulator.accumulate('msg-1', messageStart(120));
    const snap = accumulator.snapshot('msg-1');
    expect(snap).toEqual({ input: 120, output: 0, cacheCreation: 5, cacheRead: 7 });
  });

  it('message_delta captures output tokens on top of the start row', () => {
    accumulator.accumulate('msg-2', messageStart(50));
    accumulator.accumulate('msg-2', messageDelta(80));
    const total = accumulator.total('msg-2');
    // 50 input + 80 output + 11 cacheCreation + 13 cacheRead
    expect(total).toBe(50 + 80 + 11 + 13);
  });

  it('clear() removes the row so subsequent total() is 0', () => {
    accumulator.accumulate('msg-3', messageStart(40));
    // 40 input + 5 cacheCreation + 7 cacheRead = 52
    expect(accumulator.total('msg-3')).toBe(52);
    accumulator.clear('msg-3');
    expect(accumulator.total('msg-3')).toBe(0);
    expect(accumulator.snapshot('msg-3')).toBeUndefined();
  });

  it('two msgIds are tracked independently', () => {
    accumulator.accumulate('msg-A', messageStart(10));
    accumulator.accumulate('msg-B', messageStart(20));
    // 10 input + 5 cacheCreation + 7 cacheRead = 22
    expect(accumulator.total('msg-A')).toBe(22);
    // 20 input + 5 cacheCreation + 7 cacheRead = 32
    expect(accumulator.total('msg-B')).toBe(32);
  });

  it('empty/unknown msgId is ignored', () => {
    accumulator.accumulate('', messageStart(5));
    expect(accumulator.snapshot('')).toBeUndefined();
  });

  it('subsequent message_start on the same msgId overwrites input (last-write-wins, SDK resets usage)', () => {
    accumulator.accumulate('msg-4', messageStart(100));
    accumulator.accumulate('msg-4', messageStart(200));
    const snap = accumulator.snapshot('msg-4');
    expect(snap?.input).toBe(200);
  });
});
