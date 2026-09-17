// Agentic loop. Streams one Anthropic turn, and if stop_reason === 'tool_use',
// dispatches each tool call via the daemon, appends the resulting
// tool_result block, and re-invokes the SDK. Capped at `maxTurns` (default 10)
// per Plan 02-02 §"Pattern 2" so a runaway tool chain surfaces as a fatal
// error instead of looping forever.
//
// Retry layer: the underlying `messages.stream` call (inside `streamChat`)
// already wraps a `runWithRetry` covering transient / network failures
// (Plan 02-01 §T-P2-05). We deliberately do NOT add a second retry layer at
// the loop level — a multi-turn sequence that fails partway through must NOT
// silently re-run all of its `callTool` dispatches, since those have
// side-effects on the workspace and the audit log.
//
// Tool errors (`denied`, `outside_workspace`, `enoent`, `not_implemented`)
// become a `tool_result { content, isError: true }` block — they do NOT route
// through classifyError (Pitfall 7 in RESEARCH.md). The loop continues unless
// the outer LLM call itself errors (auth / transient / network / fatal).

import type Anthropic from '@anthropic-ai/sdk';
import { streamChat } from './client';
import { callTool } from '../daemon/spawn';
import { classifyError } from '../errors';
import type { ChatMessage, MessageBlock } from '../../shared/types';

export interface AgenticLoopOptions {
  messages: ChatMessage[];
  system: string;
  tools: Anthropic.Tool[];
  signal: AbortSignal;
  onToken: (delta: string) => void;
  onToolUse: (b: MessageBlock & { kind: 'tool_use' }) => void;
  onToolResult: (r: { toolUseId: string; content: string; isError: boolean }) => void;
  /**
   * Optional callback fired when the loop encounters an unrecoverable error
   * (maxTurns exceeded, outer streamChat error). Errors are ALSO thrown so
   * the caller can decide how to react. chat.ts currently relies on the
   * throw + try/catch shape; this hook is here for future plans that want
   * a separate channel (e.g. status-bar surfacing).
   */
  onError?: (e: Error) => void;
  bot?: string;          // default 'default'
  maxTurns?: number;     // default 10
}

export interface AgenticLoopResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: unknown; output: string; isError: boolean }>;
  blocks: MessageBlock[];
  /** Number of `messages.stream` calls made (i.e. SDK round-trips). */
  turns: number;
}

const DEFAULT_MAX_TURNS = 10;

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in (err as Record<string, unknown>)) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Stringify a tool result. The daemon's tool files return `{ content: string }`
 * for happy paths. For errors, we synthesize a string the LLM can read.
 */
function stringifyToolResult(result: unknown, isError: boolean): string {
  if (isError) {
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object' && 'message' in (result as Record<string, unknown>)) {
      return String((result as { message: unknown }).message);
    }
    return JSON.stringify(result);
  }
  // Happy path: prefer `content` field, fall back to JSON.
  if (result && typeof result === 'object' && 'content' in (result as Record<string, unknown>)) {
    const c = (result as { content: unknown }).content;
    if (typeof c === 'string') return c;
    return JSON.stringify(c);
  }
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Append the assistant turn's content blocks (text + tool_use) to the
 * messages array under the typed `anthropicBlocks` carrier. The downstream
 * `streamChat` reads `m.anthropicBlocks` ahead of `m.content` (see client.ts
 * `toAnthropic`), so we never need a `(m as any)` cast at the SDK boundary.
 *
 * Thinking / RedactedThinking blocks are skipped — the persisted thread only
 * carries text + tool_use + tool_result shapes the renderer understands.
 */
function appendAssistantBlocks(
  messages: ChatMessage[],
  blocks: Anthropic.Messages.ContentBlock[],
): void {
  const content: Anthropic.Messages.ContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      // SDK's TextBlock requires `citations: Array<TextCitation> | null` on
      // the wire type but TextBlockParam makes it optional. Cast keeps the
      // loop type-check clean without surfacing a `null` citations field
      // on every persisted block. (client.ts uses the same trick.)
      content.push({
        type: 'text',
        text: (b as Anthropic.Messages.TextBlock).text,
      } as unknown as Anthropic.Messages.ContentBlock);
    } else if (b.type === 'tool_use') {
      const tu = b as Anthropic.Messages.ToolUseBlock;
      content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    }
    // thinking / redacted_thinking blocks: intentionally skipped.
  }
  if (content.length === 0) return;
  messages.push({
    ts: Date.now(),
    role: 'assistant',
    content: '',
    anthropicBlocks: content,
  });
}

/**
 * Append a synthetic user turn carrying a single `tool_result` block back to
 * the LLM. Multiple tool_results in one turn are batched into one user
 * message per Anthropic's API (single role, multiple content blocks).
 */
function appendToolResult(
  messages: ChatMessage[],
  results: Anthropic.Messages.ToolResultBlockParam[],
): void {
  if (results.length === 0) return;
  messages.push({
    ts: Date.now(),
    role: 'user',
    content: '',
    anthropicBlocks: results as unknown as Anthropic.Messages.ContentBlock[],
  });
}

export async function runAgenticLoop(opts: AgenticLoopOptions): Promise<AgenticLoopResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const bot = opts.bot ?? 'default';
  const messages: ChatMessage[] = [...opts.messages];
  const blocks: MessageBlock[] = [];
  const toolCalls: AgenticLoopResult['toolCalls'] = [];
  let turns = 0;

  // Initial turn + resume turns. Each iteration:
  //   1. streamChat → blocks + stopReason
  //   2. If stopReason !== 'tool_use' → done.
  //   3. Otherwise, dispatch every tool_use, build tool_result blocks,
  //      append them to `messages`, and continue.
  let stopReason: Anthropic.Messages.StopReason | null = null;
  let lastBlocks: Anthropic.Messages.ContentBlock[] = [];
  let fullText = '';

  while (turns < maxTurns) {
    fullText = '';

    const turnResult = await streamChat({
      messages,
      system: opts.system,
      tools: opts.tools,
      signal: opts.signal,
      onToken: (delta) => {
        fullText += delta;
        opts.onToken(delta);
      },
      onToolUse: (b) => {
        opts.onToolUse(b);
      },
      onDone: () => {
        // No-op — we wait on the awaited streamChat promise.
      },
      onError: (e) => {
        // Re-throw via classifyError so the caller (chat.ts) can surface
        // auth/transient/network/fatal appropriately. Tool errors don't
        // pass through here (Pitfall 7).
        throw e;
      },
    });

    turns++;
    lastBlocks = turnResult.blocks;
    stopReason = turnResult.stopReason;

    // Mirror text + tool_use blocks into the MessageBlock[] we return to the
    // caller. The renderer owns the streaming text (via onToken), so we
    // don't re-push text blocks here; tool_use blocks DO need to be mirrored
    // so the renderer can show inline tool_use pills (per Phase 2 plan).
    for (const cb of turnResult.blocks) {
      if (cb.type === 'tool_use') {
        const tu = cb as Anthropic.Messages.ToolUseBlock;
        blocks.push({ kind: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
      }
    }

    // Append the assistant turn's content blocks to `messages` so the next
    // SDK call sees them. Use the Anthropic-shaped ContentBlock[] under the
    // typed carrier — `appendAssistantBlocks` skips empty arrays.
    appendAssistantBlocks(messages, turnResult.blocks);

    // Final turn — no tool_use; append the assistant text block and return.
    if (stopReason !== 'tool_use') {
      blocks.push({ kind: 'text', text: fullText });
      return { text: fullText, toolCalls, blocks, turns };
    }

    // Dispatch each tool_use, collect tool_result blocks, append to messages.
    const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const cb of turnResult.blocks) {
      if (cb.type !== 'tool_use') continue;
      const tu = cb as Anthropic.Messages.ToolUseBlock;

      let output = '';
      let isError = false;
      try {
        const resp = await callTool(
          tu.name,
          (tu.input ?? {}) as Record<string, unknown>,
          { toolCallId: tu.id, bot },
        );
        // JSON-RPC envelope: result on success, error on failure.
        const err = (resp as { error?: { code?: unknown; message?: unknown } }).error;
        if (err) {
          isError = true;
          output = `Error: ${String(err.message ?? 'tool error')} (code: ${String(err.code ?? 'unknown')})`;
        } else {
          const result = (resp as { result?: unknown }).result;
          output = stringifyToolResult(result, false);
        }
      } catch (e) {
        // Network/daemon failure — also surface as a tool_result with isError
        // so the loop can continue (caller decides when to abort).
        isError = true;
        output = `Error: ${errorMessage(e)}`;
      }

      toolCalls.push({ id: tu.id, name: tu.name, input: tu.input, output, isError });
      blocks.push({ kind: 'tool_result', toolUseId: tu.id, content: output, isError });
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: output,
        is_error: isError,
      });
      opts.onToolResult({ toolUseId: tu.id, content: output, isError });
    }

    // Append a synthetic user turn carrying the tool_results back to the LLM.
    appendToolResult(messages, toolResultBlocks);
  }

  // If we exit the loop, maxTurns was exceeded while still emitting tool_use.
  // Surface as a fatal error in the error category — caller maps this to
  // EVENT_MESSAGE_ERROR {category:'fatal', retryable:false}. The optional
  // onError hook is fired first so future consumers (status bar, log
  // surfaces) can react even when the caller swallows the throw.
  // We also push a final text block with whatever was streamed (likely empty
  // for a runaway loop), so the renderer's blocks table is consistent.
  blocks.push({ kind: 'text', text: fullText });
  void lastBlocks; // lastBlocks is read for symmetry with the natural-completion path
  const fatal = new Error(`agentic loop exceeded maxTurns=${maxTurns}`) as Error & {
    category: string;
    retryable: boolean;
  };
  fatal.category = 'fatal';
  fatal.retryable = false;
  // Classify so callers can switch on category consistently.
  const classified = classifyError(fatal);
  const wrapped = new Error(classified.message) as Error & { category?: string; retryable?: boolean };
  wrapped.category = classified.category;
  wrapped.retryable = classified.retryable;
  if (opts.onError) {
    try {
      opts.onError(wrapped);
    } catch {
      // Never let an onError handler take down the loop; the throw below is
      // the source of truth for maxTurns failure.
    }
  }
  throw wrapped;
}