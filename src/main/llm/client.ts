// Streaming chat client. Wraps @anthropic-ai/sdk pointed at M3 base URL.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import { keyFilePath } from '../paths';
import { classifyError, runWithRetry } from '../errors';
import { DEFAULT_SYSTEM_PROMPT } from './prompts';
import type { ChatMessage, MessageBlock } from '../../shared/types';

const M3_API_BASE = process.env.M3_API_BASE || 'https://api.MiniMax.io/v1';
const M3_MODEL = process.env.M3_MODEL || 'MiniMax/M3';

async function readKey(): Promise<string> {
  const file = keyFilePath();
  const buf = await fs.promises.readFile(file);
  const cipherB64 = buf.toString('utf8');
  const cipher = Buffer.from(cipherB64, 'base64');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption unavailable; refusing to read key in plaintext');
  }
  return safeStorage.decryptString(cipher);
}

export interface StreamChatOptions {
  messages: ChatMessage[];
  system?: string;
  tools?: Anthropic.Tool[];                      // NEW (Phase 2)
  signal: AbortSignal;
  onToken: (delta: string) => void;
  onToolUse: (b: MessageBlock & { kind: 'tool_use' }) => void;  // NEW
  onDone: () => void;
  onError: (e: Error) => void;
}

export interface StreamChatResult {
  stopReason: Anthropic.Messages.StopReason | null;
  blocks: Anthropic.Messages.ContentBlock[];
}

/** Convert a ChatMessage into Anthropic's MessageParam shape. */
function toAnthropic(m: ChatMessage): Anthropic.Messages.MessageParam {
  // Phase 2 prefers `anthropicBlocks` (typed carrier) over the legacy
  // `content: string` row. Falls back to a text-only block.
  if (m.anthropicBlocks && m.anthropicBlocks.length > 0) {
    return { role: m.role, content: m.anthropicBlocks as unknown as Anthropic.Messages.MessageParam['content'] };
  }
  return { role: m.role, content: m.content };
}

/**
 * Stream one Anthropic turn. Accumulates `input_json_delta` per tool_use
 * block and only exposes the parsed `input` AFTER `content_block_stop`,
 * per the SDK's documented event order:
 *
 *   content_block_start (index, content_block: {type:'tool_use', id, name, input:''})
 *     input_json_delta (delta.partial_json)
 *     ...
 *   content_block_stop (index)
 *
 * Never parse `partial_json` mid-stream; the assistant typically emits 5-20
 * deltas per tool_use block.
 */
export async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
  const apiKey = await readKey();
  const client = new Anthropic({ apiKey, baseURL: M3_API_BASE });

  let lastStopReason: Anthropic.Messages.StopReason | null = null;
  const outerBlocks: Anthropic.Messages.ContentBlock[] = [];

  await runWithRetry(
    async () => {
      lastStopReason = null;
      const blocks: Anthropic.Messages.ContentBlock[] = [];
      // Per-block accumulator for tool_use partial_json (keyed by index).
      type ToolAcc = { id: string; name: string; inputJson: string };
      const toolAcc = new Map<number, ToolAcc>();

      try {
        const stream = client.messages.stream(
          {
            model: M3_MODEL,
            system: opts.system ?? DEFAULT_SYSTEM_PROMPT,
            messages: opts.messages.map(toAnthropic),
            max_tokens: 4096,
            ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
          },
          { signal: opts.signal },
        );

        for await (const event of stream as AsyncIterable<Anthropic.Messages.MessageStreamEvent>) {
          if (event.type === 'content_block_start') {
            const cb = event.content_block;
            if (cb.type === 'tool_use') {
              toolAcc.set(event.index, { id: cb.id, name: cb.name, inputJson: '' });
              // Reserve the slot with a placeholder; replaced on content_block_stop.
              blocks[event.index] = { type: 'tool_use', id: cb.id, name: cb.name, input: {} };
            } else if (cb.type === 'text') {
              // Cast: SDK's TextBlock type includes an optional `citations` field
              // that we don't track. The downstream renderer only reads `text`.
              blocks[event.index] = { type: 'text', text: '' } as Anthropic.Messages.TextBlock;
            }
            // ThinkingBlock / RedactedThinkingBlock are reserved slots but we
            // don't surface them in the renderer yet (Phase 3+ if needed).
            continue;
          }

          if (event.type === 'content_block_delta') {
            const delta = (event as Anthropic.Messages.ContentBlockDeltaEvent).delta;
            if (delta.type === 'text_delta') {
              opts.onToken(delta.text);
              const slot = blocks[event.index];
              if (slot && slot.type === 'text') {
                // Accumulate text into the slot so the returned array is
                // self-contained even after the loop ends.
                (slot as Anthropic.Messages.TextBlock).text += delta.text;
              }
            } else if (delta.type === 'input_json_delta') {
              const acc = toolAcc.get(event.index);
              if (acc) acc.inputJson += delta.partial_json;
            }
            continue;
          }

          if (event.type === 'content_block_stop') {
            const acc = toolAcc.get(event.index);
            if (acc) {
              let parsed: unknown = {};
              try {
                parsed = acc.inputJson.length > 0 ? JSON.parse(acc.inputJson) : {};
              } catch {
                parsed = {};
              }
              const tu: Anthropic.Messages.ToolUseBlock = {
                type: 'tool_use',
                id: acc.id,
                name: acc.name,
                input: parsed,
              };
              blocks[event.index] = tu;
              opts.onToolUse({ kind: 'tool_use', id: acc.id, name: acc.name, input: parsed });
              toolAcc.delete(event.index);
            }
            continue;
          }

          if (event.type === 'message_delta') {
            const md = event as Anthropic.Messages.MessageDeltaEvent;
            lastStopReason = md.delta.stop_reason;
            continue;
          }
        }

        // Persist the assembled blocks onto the outer scope so the function's
        // return value reflects the latest successful retry.
        for (let i = 0; i < blocks.length; i++) {
          if (blocks[i]) {
            outerBlocks[i] = blocks[i];
          }
        }
        outerBlocks.length = blocks.length;

        opts.onDone();
      } catch (err: any) {
        const classified = classifyError(err);
        const wrapped = new Error(classified.message) as Error & {
          category?: string;
          retryable?: boolean;
        };
        wrapped.category = classified.category;
        wrapped.retryable = classified.retryable;
        opts.onError(wrapped);
        throw err;
      }
    },
    {
      attempts: 3,
      baseDelayMs: 250,
      isRetryable: (e) => (e.category === 'transient' || e.category === 'network') && e.retryable,
    },
  );

  return { stopReason: lastStopReason, blocks: outerBlocks };
}

export const __TESTING__ = { M3_API_BASE, M3_MODEL };
