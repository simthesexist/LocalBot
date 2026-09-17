// Chat IPC: sendMessage + cancel. Per-msgId AbortController map.
//
// Phase 2: replace the direct streamChat call with runAgenticLoop. Tool
// callbacks broadcast EVENT_MESSAGE_TOOL_USE + EVENT_MESSAGE_TOOL_RESULT.
// The assistant turn is persisted with the full `blocks` array so the
// next session reload can re-render the tool surface.

import { ipcMain, BrowserWindow } from 'electron';
import { CHANNELS } from '../../shared/ipc-channels';
import { runAgenticLoop } from '../llm/loop';
import { appendMessage } from '../sessions/jsonl';
import { classifyError } from '../errors';
import { cancelToolCall, getActiveToolCallId } from '../daemon/spawn';
import { TOOL_SCHEMAS } from '../llm/tools';
import { DEFAULT_SYSTEM_PROMPT } from '../llm/prompts';
import type { SendMessageRequest } from '../../shared/types';

const activeStreams = new Map<string, AbortController>();

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

export function registerChatHandlers(): void {
  ipcMain.handle(CHANNELS.SEND_MESSAGE, async (_evt, req: SendMessageRequest) => {
    if (!req || !req.msgId || typeof req.content !== 'string') {
      return { ok: false, error: 'invalid request' };
    }

    const ac = new AbortController();
    activeStreams.set(req.msgId, ac);

    let aggregated = '';
    let cancelled = false;
    let lastError: { error: string; retryable: boolean; category: 'auth' | 'network' | 'transient' | 'fatal' } | null = null;

    try {
      // Persist the user turn immediately.
      await appendMessage({ role: 'user', content: req.content, msgId: req.msgId });

      const loopResult = await runAgenticLoop({
        messages: [{ ts: Date.now(), role: 'user', content: req.content }],
        system: DEFAULT_SYSTEM_PROMPT,
        tools: TOOL_SCHEMAS,
        signal: ac.signal,
        onToken: (delta) => {
          aggregated += delta;
          broadcast(CHANNELS.EVENT_MESSAGE_TOKEN, { msgId: req.msgId, delta });
        },
        onToolUse: (b) => {
          broadcast(CHANNELS.EVENT_MESSAGE_TOOL_USE, {
            msgId: req.msgId,
            toolUseId: b.id,
            name: b.name,
            input: b.input,
          });
        },
        onToolResult: (r) => {
          broadcast(CHANNELS.EVENT_MESSAGE_TOOL_RESULT, {
            msgId: req.msgId,
            toolUseId: r.toolUseId,
            content: r.content,
            isError: r.isError,
          });
        },
        bot: 'default',
      });

      // Persist the assistant turn on natural completion with full blocks.
      if (!cancelled && (aggregated.length > 0 || loopResult.blocks.length > 0)) {
        await appendMessage({
          role: 'assistant',
          content: aggregated,
          blocks: loopResult.blocks,
          msgId: req.msgId,
        });
      }

      broadcast(CHANNELS.EVENT_MESSAGE_DONE, { msgId: req.msgId });
    } catch (err: any) {
      const classified = classifyError(err);
      cancelled = classified.message === 'cancelled';
      if (cancelled) {
        if (aggregated.length > 0) {
          await appendMessage({
            role: 'assistant',
            content: aggregated,
            stopped: true,
            msgId: req.msgId,
          });
        }
        lastError = { error: 'cancelled', retryable: false, category: 'network' };
        // If a tool call was in flight, send tools/cancel.
        const toolCallId = getActiveToolCallId();
        if (toolCallId) {
          await cancelToolCall(toolCallId);
        }
      } else {
        lastError = {
          error: classified.message,
          retryable: classified.retryable,
          category: classified.category,
        };
      }
    } finally {
      activeStreams.delete(req.msgId);
    }

    if (lastError) {
      broadcast(CHANNELS.EVENT_MESSAGE_ERROR, { msgId: req.msgId, ...lastError });
    }

    return { ok: true };
  });

  ipcMain.handle(CHANNELS.CANCEL, async (_evt, msgId: string) => {
    const ac = activeStreams.get(msgId);
    if (ac) {
      ac.abort();
    }
    const toolCallId = getActiveToolCallId();
    if (toolCallId) {
      await cancelToolCall(toolCallId);
    }
    return { ok: true };
  });
}
