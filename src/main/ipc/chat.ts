// Chat IPC: sendMessage + cancel. Per-msgId AbortController map.

import { ipcMain, BrowserWindow } from 'electron';
import { CHANNELS } from '../../shared/ipc-channels';
import { streamChat } from '../llm/client';
import { appendMessage } from '../sessions/jsonl';
import { classifyError } from '../errors';
import { cancelToolCall, getActiveToolCallId } from '../daemon/spawn';
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

    try {
      // Persist the user turn immediately.
      await appendMessage({ role: 'user', content: req.content, msgId: req.msgId });

      await streamChat({
        messages: [{ ts: Date.now(), role: 'user', content: req.content }],
        signal: ac.signal,
        onToken: (delta) => {
          aggregated += delta;
          broadcast(CHANNELS.EVENT_MESSAGE_TOKEN, { msgId: req.msgId, delta });
        },
        onDone: () => {
          broadcast(CHANNELS.EVENT_MESSAGE_DONE, { msgId: req.msgId });
        },
        onError: (e: any) => {
          const classified = classifyError(e);
          broadcast(CHANNELS.EVENT_MESSAGE_ERROR, {
            msgId: req.msgId,
            error: classified.message,
            retryable: classified.retryable,
            category: classified.category,
          });
        },
      });

      // Persist the assistant turn on natural completion.
      if (!cancelled && aggregated.length > 0) {
        await appendMessage({ role: 'assistant', content: aggregated, msgId: req.msgId });
      }
    } catch (err: any) {
      const classified = classifyError(err);
      cancelled = classified.message === 'cancelled';
      if (cancelled) {
        // Persist partial + stopped flag.
        if (aggregated.length > 0) {
          await appendMessage({
            role: 'assistant',
            content: aggregated,
            stopped: true,
            msgId: req.msgId,
          });
        }
        broadcast(CHANNELS.EVENT_MESSAGE_ERROR, {
          msgId: req.msgId,
          error: 'cancelled',
          retryable: false,
          category: 'network',
        });
        // If a tool call was in flight, send tools/cancel.
        const toolCallId = getActiveToolCallId();
        if (toolCallId) {
          await cancelToolCall(toolCallId);
        }
      } else {
        broadcast(CHANNELS.EVENT_MESSAGE_ERROR, {
          msgId: req.msgId,
          error: classified.message,
          retryable: classified.retryable,
          category: classified.category,
        });
      }
    } finally {
      activeStreams.delete(req.msgId);
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
