// Per-turn usage accumulator. Phase 3 tracer slice.
//
// Tracks `input_tokens` and `output_tokens` reported by the Anthropic SDK
// across the streamed Message. The accumulator is reset per-turn (per
// msgId); chat.ts builds a fresh one for each sendMessage and asks
// maybeSummarize() whether accumulated.total() > SOFT_CAP.

import type Anthropic from '@anthropic-ai/sdk';

type UsageRow = { input: number; output: number; cacheCreation: number; cacheRead: number };

const rows = new Map<string, UsageRow>();

/**
 * Update the accumulator for `msgId` from a streamed `MessageStreamEvent`.
 * - `message_start` carries `message.usage.input_tokens` (+ optional cache tokens)
 * - `message_delta` carries `usage.output_tokens` (+ optional cache tokens)
 *
 * Cache tokens are added to the `input` bucket so the soft-cap math remains
 * meaningful — the SDK counts them toward the same billing pool.
 */
export function accumulate(msgId: string, event: Anthropic.Messages.MessageStreamEvent): void {
  if (!msgId) return;
  let row = rows.get(msgId);
  if (!row) {
    row = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    rows.set(msgId, row);
  }
  if (event.type === 'message_start') {
    const u = event.message.usage as { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    row.input = u?.input_tokens ?? row.input;
    row.cacheCreation = u?.cache_creation_input_tokens ?? row.cacheCreation;
    row.cacheRead = u?.cache_read_input_tokens ?? row.cacheRead;
    return;
  }
  if (event.type === 'message_delta') {
    const u = (event as Anthropic.Messages.MessageDeltaEvent).usage as
      | { output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
      | undefined;
    if (!u) return;
    if (typeof u.output_tokens === 'number') row.output = u.output_tokens;
    if (typeof u.cache_creation_input_tokens === 'number') {
      row.cacheCreation = u.cache_creation_input_tokens;
    }
    if (typeof u.cache_read_input_tokens === 'number') {
      row.cacheRead = u.cache_read_input_tokens;
    }
  }
}

export function total(msgId: string): number {
  const row = rows.get(msgId);
  if (!row) return 0;
  return row.input + row.output + row.cacheCreation + row.cacheRead;
}

export function snapshot(msgId: string): UsageRow | undefined {
  const row = rows.get(msgId);
  return row ? { ...row } : undefined;
}

export function clear(msgId: string): void {
  rows.delete(msgId);
}

// Test hook — never call from production code.
export function __resetForTests(): void {
  rows.clear();
}