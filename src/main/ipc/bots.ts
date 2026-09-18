// Phase 4 Wave 1+2: bot metadata IPC handlers.
//
// Wires BOTS_LIST / BOTS_CREATE / BOTS_DELETE / BOTS_UPDATE / BOTS_TRIGGER /
// BOTS_CANCEL invoke channels to the daemon's matching JSON-RPC methods.
// On any successful mutation we broadcast EVENT_BOT_LIST_UPDATED so the
// sidebar can refresh without polling. BOTS_TRIGGER manages a per-runId
// AbortController map (Pitfall 10) and broadcasts EVENT_BOT_STATUS on every
// transition.

import { ipcMain, BrowserWindow } from 'electron';
import crypto from 'node:crypto';
import { CHANNELS } from '../../shared/ipc-channels';
import { callBot } from '../daemon/spawn';
import { ensureRunsDir } from '../bots/paths';
import type {
  BotCancelRequest,
  BotCancelResult,
  BotConfig,
  BotCreateRequest,
  BotCreateResult,
  BotDeleteRequest,
  BotDeleteResult,
  BotListResult,
  BotTriggerRequest,
  BotTriggerResult,
  BotUpdateRequest,
  BotUpdateResult,
} from '../../shared/types';

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

// Per-runId AbortController map (Pitfall 10 — multi-bot cancel races).
const activeRuns = new Map<string, AbortController>();
// msgId → runId so the chat composer can correlate msgId cancels back to
// the per-runId controller (Wave 2 wires msgId = runId-m1).
const activeMsgToRun = new Map<string, string>();

export function registerBotHandlers(): void {
  ipcMain.handle(CHANNELS.BOTS_LIST, async (): Promise<BotListResult> => {
    try {
      const result = (await callBot('bots/list', {})) as { ok?: boolean; bots?: BotConfig[]; error?: string };
      return {
        ok: result?.ok === true,
        bots: Array.isArray(result?.bots) ? result!.bots! : [],
        error: result?.error,
      };
    } catch (err) {
      return { ok: false, bots: [], error: (err as Error).message };
    }
  });

  ipcMain.handle(CHANNELS.BOTS_CREATE, async (_evt, req: BotCreateRequest): Promise<BotCreateResult> => {
    if (!req || typeof req.name !== 'string' || req.name.trim().length === 0) {
      return { ok: false, error: 'name required' };
    }
    if (!Array.isArray(req.allowlist)) {
      return { ok: false, error: 'allowlist must be an array' };
    }
    try {
      const args: Record<string, unknown> = {
        name: req.name,
        persona: typeof req.persona === 'string' ? req.persona : '',
        workspace: typeof req.workspace === 'string' ? req.workspace : '',
        allowlist: req.allowlist,
      };
      if (typeof req.id === 'string' && req.id.length > 0) args.id = req.id;
      if (typeof req.cron === 'string' && req.cron.length > 0) args.cron = req.cron;
      if (typeof req.cronEnabled === 'boolean') args.cronEnabled = req.cronEnabled;
      const result = (await callBot('bots/create', args)) as { ok?: boolean; bot?: BotConfig; error?: string };

      if (result?.ok && result.bot) {
        void ensureRunsDir(result.bot.id).catch(() => { /* ignore */ });
      }

      if (result?.ok) {
        broadcast(CHANNELS.EVENT_BOT_LIST_UPDATED, { reason: 'create', bot: result.bot?.id });
      }
      return {
        ok: result?.ok === true,
        bot: result?.bot,
        error: result?.error,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(CHANNELS.BOTS_DELETE, async (_evt, req: BotDeleteRequest): Promise<BotDeleteResult> => {
    if (!req || typeof req.bot !== 'string' || req.bot.length === 0) {
      return { ok: false, error: 'bot required' };
    }
    try {
      const result = (await callBot('bots/delete', { bot: req.bot })) as { ok?: boolean; error?: string };
      if (result?.ok) {
        broadcast(CHANNELS.EVENT_BOT_LIST_UPDATED, { reason: 'delete', bot: req.bot });
      }
      return {
        ok: result?.ok === true,
        error: result?.error,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(CHANNELS.BOTS_UPDATE, async (_evt, req: BotUpdateRequest): Promise<BotUpdateResult> => {
    if (!req || typeof req.bot !== 'string' || req.bot.length === 0) {
      return { ok: false, error: 'bot required' };
    }
    if (!req.patch || typeof req.patch !== 'object' || Array.isArray(req.patch)) {
      return { ok: false, error: 'patch must be an object' };
    }
    try {
      const result = (await callBot('bots/update', { bot: req.bot, patch: req.patch })) as {
        ok?: boolean; bot?: BotConfig; error?: string;
      };
      if (result?.ok) {
        broadcast(CHANNELS.EVENT_BOT_LIST_UPDATED, { reason: 'update', bot: req.bot });
      }
      return {
        ok: result?.ok === true,
        bot: result?.bot,
        error: result?.error,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(CHANNELS.BOTS_TRIGGER, async (_evt, req: BotTriggerRequest): Promise<BotTriggerResult> => {
    if (!req || typeof req.bot !== 'string' || req.bot.length === 0) {
      return { ok: false, error: 'bot required' };
    }
    if (typeof req.content !== 'string' || req.content.trim().length === 0) {
      return { ok: false, error: 'content required' };
    }
    const runId = crypto.randomUUID();
    const controller = new AbortController();
    activeRuns.set(runId, controller);

    // Pitfall 9 — broadcast running status immediately.
    broadcast(CHANNELS.EVENT_BOT_STATUS, {
      bot: req.bot,
      status: 'running',
      runId,
      ts: new Date().toISOString(),
    });

    try {
      const result = (await callBot('bots/trigger', { bot: req.bot, content: req.content, runId })) as {
        ok?: boolean; runId?: string; exitReason?: 'completed' | 'cancelled' | 'errored'; error?: string;
      };
      const exitReason = result?.exitReason ?? 'completed';
      broadcast(CHANNELS.EVENT_BOT_STATUS, {
        bot: req.bot,
        status: exitReason === 'errored' ? 'errored' : 'idle',
        runId,
        ts: new Date().toISOString(),
      });
      return {
        ok: result?.ok === true,
        runId: result?.runId ?? runId,
        exitReason,
        error: result?.error,
      };
    } catch (err) {
      broadcast(CHANNELS.EVENT_BOT_STATUS, {
        bot: req.bot,
        status: 'errored',
        runId,
        ts: new Date().toISOString(),
      });
      return { ok: false, runId, error: (err as Error).message };
    } finally {
      activeRuns.delete(runId);
      // Best-effort cleanup of any msgId mappings for this runId.
      for (const [msgId, mappedRunId] of Array.from(activeMsgToRun.entries())) {
        if (mappedRunId === runId) activeMsgToRun.delete(msgId);
      }
    }
  });

  ipcMain.handle(CHANNELS.BOTS_CANCEL, async (_evt, req: BotCancelRequest): Promise<BotCancelResult> => {
    if (!req || typeof req.runId !== 'string' || req.runId.length === 0) {
      return { ok: false, error: 'runId required' };
    }
    const ctrl = activeRuns.get(req.runId);
    if (ctrl) {
      try { ctrl.abort(); } catch { /* ignore */ }
    }
    // Also abort any msgId controllers mapped to this runId (Pitfall 10).
    for (const [msgId, mappedRunId] of Array.from(activeMsgToRun.entries())) {
      if (mappedRunId === req.runId) {
        activeMsgToRun.delete(msgId);
      }
    }
    return { ok: true };
  });
}

/**
 * Look up + register the AbortController for a chat composer msgId so
 * bots/cancel can also abort any in-flight chat sendMessage cycle.
 * Wave 2 wires the chat composer's msgId to the per-runId map.
 */
export function registerMsgForRun(msgId: string, runId: string): void {
  activeMsgToRun.set(msgId, runId);
}

export function unregisterMsgForRun(msgId: string): void {
  activeMsgToRun.delete(msgId);
}

export function getAbortControllerForRun(runId: string): AbortController | undefined {
  return activeRuns.get(runId);
}
