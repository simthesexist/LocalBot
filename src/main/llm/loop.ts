// Agentic loop. Streams one Anthropic turn, and if stop_reason === 'tool_use',
// dispatches each tool call via the daemon, appends the resulting
// tool_result block, and re-invokes the SDK. Capped at `maxTurns` (default 10)
// per Plan 02-01 §"Pattern 2" so a runaway tool chain surfaces as a fatal
// error instead of looping forever.
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
  bot?: string;          // default 'default'
  maxTurns?: number;     // default 10
}

export interface AgenticLoopResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: unknown; output: string; isError: boolean }>;
  blocks: MessageBlock[];
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

export async function runAgenticLoop(opts: AgenticLoopOptions): Promise<AgenticLoopResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const bot = opts.bot ?? 'default';
  const messages: ChatMessage[] = [...opts.messages];
  const blocks: MessageBlock[] = [];
  const toolCalls: AgenticLoopResult['toolCalls'] = [];
  let fullText = '';

  for (let turn = 0; turn < maxTurns; turn++) {
    // Reset per-turn text accumulator (the renderer owns the streaming UI).
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
        // No-op — loop waits on the awaited streamChat promise.
      },
      onError: (e) => {
        // Re-throw via classifyError so the caller (chat.ts) can surface
        // auth/transient/network/fatal appropriately. Tool errors don't
        // pass through here (Pitfall 7).
        throw e;
      },
    });

    // The returned `blocks` carry text + tool_use blocks in arrival order.
    // For tool_use blocks, copy them into our MessageBlock mirror.
    for (const cb of turnResult.blocks) {
      if (cb.type === 'text') {
        // Text content is already streamed via onToken; we don't mirror it
        // into `blocks` because the renderer owns the streaming text.
      } else if (cb.type === 'tool_use') {
        blocks.push({ kind: 'tool_use', id: cb.id, name: cb.name, input: cb.input });
      }
    }

    // Final turn — no tool_use; append the assistant text block and return.
    if (turnResult.stopReason !== 'tool_use') {
      blocks.push({ kind: 'text', text: fullText });
      return { text: fullText, toolCalls, blocks };
    }

    // Append the assistant turn's content blocks to `messages` so the next
    // SDK call sees them. Use the Anthropic-shaped ContentBlock[] (text +
    // tool_use) under the `anthropicBlocks` typed carrier.
    const assistantContent: Anthropic.Messages.ContentBlock[] = turnResult.blocks.map((cb) => cb);
    messages.push({
      ts: Date.now(),
      role: 'assistant',
      content: '',
      anthropicBlocks: assistantContent,
    });

    // Dispatch each tool_use, collect tool_result blocks, append to messages.
    const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const cb of turnResult.blocks) {
      if (cb.type !== 'tool_use') continue;

      let output = '';
      let isError = false;
      try {
        const resp = await callTool(
          cb.name,
          (cb.input ?? {}) as Record<string, unknown>,
          { toolCallId: cb.id, bot },
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

      toolCalls.push({ id: cb.id, name: cb.name, input: cb.input, output, isError });
      blocks.push({ kind: 'tool_result', toolUseId: cb.id, content: output, isError });
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: cb.id,
        content: output,
        is_error: isError,
      });
      opts.onToolResult({ toolUseId: cb.id, content: output, isError });
    }

    // Append a synthetic user turn carrying the tool_results back to the LLM.
    messages.push({
      ts: Date.now(),
      role: 'user',
      content: '',
      anthropicBlocks: toolResultBlocks as unknown as Anthropic.Messages.ContentBlock[],
    });
  }

  // If we exit the loop, maxTurns was exceeded while still emitting tool_use.
  // Surface as a fatal error in the error category — caller maps this to
  // EVENT_MESSAGE_ERROR {category:'fatal', retryable:false}.
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
  throw wrapped;
}
