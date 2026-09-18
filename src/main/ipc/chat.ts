// Chat IPC: sendMessage + cancel. Per-msgId AbortController map.
//
// Phase 3 tracer slice:
//   - Per-bot sessionId generation; new session for every message group.
//   - JSONL append routes to <sessionsDir>/<bot>/<sessionId>.jsonl (Pitfall 3
//     migration runs once on first sendMessage).
//   - System prompt is built from DEFAULT_SYSTEM_PROMPT + a memory suffix
//     injected from the bot's memory.md + facts.json. The renderer never
//     sees the memory payload directly.
//   - usageAccumulator tracks input/output/cache tokens across the loop.
//   - When the running total crosses SOFT_CAP, maybeSummarize runs a
//     dedicated turn against the M3 API, prepends the summary row to the
//     JSONL, and broadcasts EVENT_HISTORY_APPENDED.
//
// Phase 4 Wave 2: routes by `req.bot` (replacing the hardcoded 'default')
// and rebuilds the system prompt with both persona + memory suffixes per
// turn via loadConfigIntoSystemPrompt.

import { ipcMain, BrowserWindow } from 'electron';
import { CHANNELS } from '../../shared/ipc-channels';
import { runAgenticLoop } from '../llm/loop';
import { readMemory, injectMemorySuffix, mergeFacts } from '../bots/memory';
import { callMemory } from '../daemon/spawn';
import {
  appendMessage,
  generateSessionId,
  loadSession,
  migrateLegacyGlobalJsonl,
  prependSummary,
  SessionContext,
} from '../sessions/jsonl';
import * as usageAccumulator from '../llm/usageAccumulator';
import { runSummarizer } from '../llm/summarize';
import { classifyError } from '../errors';
import { cancelToolCall, getActiveToolCallId } from '../daemon/spawn';
import { TOOL_SCHEMAS } from '../llm/tools';
import { DEFAULT_SYSTEM_PROMPT_BASE } from '../llm/prompts';
import { loadConfigIntoSystemPrompt } from '../bots/policy';
import type { SendMessageRequest, ChatMessage } from '../../shared/types';

const activeStreams = new Map<string, AbortController>();

/**
 * Soft cap on accumulated usage tokens. When the running total crosses this
 * number, the next sendMessage call runs runSummarizer before streaming the
 * answer. Overridable via `LOCALBOT_SOFT_CAP_TOKENS` for local tuning.
 */
const SOFT_CAP = Number(process.env.LOCALBOT_SOFT_CAP_TOKENS) || 100_000;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function broadcastHistoryAppended(bot: string, sessionId: string, msgId?: string): void {
  broadcast(CHANNELS.EVENT_HISTORY_APPENDED, {
    kind: 'message',
    bot,
    sessionId,
    msgId,
  });
}

/**
 * Try the soft-cap summarizer. Returns true when summarization ran (caller
 * should re-read the session if it needs the head summary). The summarizer
 * uses its own retry budget + child AbortSignal; failures are swallowed so
 * the chat flow can still proceed without a summary.
 *
 * Phase 3 Wave 2 (RESEARCH.md §"Pitfall 4"): the user's outer signal (the
 * per-msgId `AbortController`) is NEVER touched from this path. When the
 * user clicks Stop, we abort a CHILD controller instead, so cancelling
 * mid-summary aborts only the summary SDK call — the outer streamChat retry
 * is bypassed.
 */
async function maybeSummarize(
  ctx: SessionContext,
  messages: ChatMessage[],
  outerSignal: AbortSignal,
): Promise<boolean> {
  if (messages.length < 4) return false;

  // Per-call child controller. When the outer signal aborts, linkAbort
  // forwards the abort to the child; the outer controller itself is owned
  // by the cancel IPC handler and is NEVER touched from this path.
  const childController = new AbortController();
  const linkAbort = () => {
    try { childController.abort(); } catch { /* ignore */ }
  };
  outerSignal.addEventListener('abort', linkAbort, { once: true });

  try {
    const result = await runSummarizer(messages, {
      outerSignal,
      childSignal: childController.signal,
    });
    if (!result.summary || result.summary.length === 0) return false;
    await prependSummary(ctx.bot, ctx.sessionId, {
      summary: result.summary,
      turnsFolded: messages.length,
      ranAt: new Date().toISOString(),
      msgId: `summary-${Date.now()}`,
    });
    if (result.factsDelta && Object.keys(result.factsDelta).length > 0) {
      try {
        const current = await readMemory(ctx.bot);
        const merged = mergeFacts(current.facts, result.factsDelta);
        await callMemory('memory/write', {
          bot: ctx.bot,
          markdown: current.markdown,
          facts: merged,
        });
      } catch (factsErr) {
        // eslint-disable-next-line no-console
        console.warn('[memory] facts merge failed', factsErr);
      }
    }
    broadcast(CHANNELS.EVENT_HISTORY_APPENDED, {
      kind: 'summary',
      bot: ctx.bot,
      sessionId: ctx.sessionId,
    });
    return true;
  } catch (err) {
    // SummarizeAbortError (outer cancelled mid-summary) is the ONLY error
    // path that fires from cancel — outer is unchanged.
    const code = (err as { code?: string }).code;
    if (code === 'aborted') {
      broadcast(CHANNELS.EVENT_HISTORY_APPENDED, {
        kind: 'summary',
        bot: ctx.bot,
        sessionId: ctx.sessionId,
        aborted: true,
      });
    }
    // eslint-disable-next-line no-console
    console.warn('[summarize] failed; continuing without summary', (err as Error).message);
    return false;
  } finally {
    outerSignal.removeEventListener('abort', linkAbort);
  }
}

export function registerChatHandlers(): void {
  ipcMain.handle(CHANNELS.SEND_MESSAGE, async (_evt, req: SendMessageRequest) => {
    if (!req || !req.msgId || typeof req.content !== 'string') {
      return { ok: false, error: 'invalid request' };
    }

    const ac = new AbortController();
    activeStreams.set(req.msgId, ac);

    // Phase 4 Wave 2: route by req.bot (defaults to 'default' for Phase 3 back-compat).
    const bot = (typeof req.bot === 'string' && req.bot.length > 0) ? req.bot : 'default';
    const sessionId = generateSessionId();
    const sessionCtx: SessionContext = { bot, sessionId };

    let aggregated = '';
    let cancelled = false;
    let lastError: { error: string; retryable: boolean; category: 'auth' | 'network' | 'transient' | 'fatal' } | null = null;

    try {
      // One-shot legacy migration on first launch.
      await migrateLegacyGlobalJsonl(bot);

      // Read existing session (or fall back to empty). This is what the
      // summary block at the head of the JSONL looks like when summarization
      // has run.
      const existing = await loadSession(bot, sessionId);
      const priorMessages: ChatMessage[] = existing.messages;

      // Persist the user turn BEFORE the loop so the renderer reload on
      // cancel still has the user's prompt on disk.
      await appendMessage({ role: 'user', content: req.content, msgId: req.msgId }, sessionCtx);
      broadcastHistoryAppended(bot, sessionId, req.msgId);

      // Build the system prompt with persona + memory suffixes.
      let personaSystem = DEFAULT_SYSTEM_PROMPT_BASE;
      try {
        const loaded = await loadConfigIntoSystemPrompt(bot);
        personaSystem = loaded.system;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[chat] loadConfigIntoSystemPrompt failed for bot=${bot}: ${(err as Error).message}`);
      }
      const mem = await readMemory(bot);
      const system = injectMemorySuffix(personaSystem, mem.markdown, mem.facts);

      // Soft-cap summarization. Token usage is checked across the running
      // session; summarization only kicks in once the bot has accumulated
      // more than SOFT_CAP tokens worth of history.
      const runningTotal = priorMessages.reduce((sum, m) => {
        // We don't have token counts per row — emit the soft-cap check on
        // message-count as a coarse proxy. The accumulator provides exact
        // counts for future plans.
        return sum + (typeof m.content === 'string' ? m.content.length : 0);
      }, 0) / 4;
      if (runningTotal > SOFT_CAP) {
        await maybeSummarize(sessionCtx, priorMessages, ac.signal);
      }

      const loopResult = await runAgenticLoop({
        messages: [...priorMessages, { ts: Date.now(), role: 'user', content: req.content }],
        system,
        tools: TOOL_SCHEMAS,
        signal: ac.signal,
        bot,
        onUsage: (event) => {
          // Phase 3: accumulate per-message usage. We key by the SDK's
          // message id when available; otherwise fall back to our msgId.
          const sdkMsgId = (event as { message?: { id?: string } }).message?.id ?? req.msgId;
          usageAccumulator.accumulate(sdkMsgId, event);
        },
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
      });

      // Persist the assistant turn on natural completion with full blocks.
      if (!cancelled && (aggregated.length > 0 || loopResult.blocks.length > 0)) {
        await appendMessage({
          role: 'assistant',
          content: aggregated,
          blocks: loopResult.blocks,
          msgId: req.msgId,
        }, sessionCtx);
        broadcastHistoryAppended(bot, sessionId, req.msgId);
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
          }, sessionCtx);
          broadcastHistoryAppended(bot, sessionId, req.msgId);
        }
        lastError = { error: 'cancelled', retryable: false, category: 'network' };
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
