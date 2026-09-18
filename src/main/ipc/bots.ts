// Phase 4 Wave 1: bot metadata IPC handlers.
//
// Wires the BOTS_LIST / BOTS_CREATE / BOTS_DELETE invoke channels to the
// daemon's `bots/list` / `bots/create` / `bots/delete` JSON-RPC methods.
// On any successful mutation we broadcast EVENT_BOT_LIST_UPDATED so the
// sidebar can refresh without polling. The renderer's initial paint reads
// the canonical bot list from `app:init.bots` (window.ts) so it hydrates
// synchronously without an extra IPC roundtrip.

import { ipcMain, BrowserWindow } from 'electron';
import { CHANNELS } from '../../shared/ipc-channels';
import { callBot } from '../daemon/spawn';
import { ensureRunsDir } from '../bots/paths';
import type {
  BotConfig,
  BotCreateRequest,
  BotCreateResult,
  BotDeleteRequest,
  BotDeleteResult,
  BotListResult,
} from '../../shared/types';

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

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
      // Defensive default — never throw to the renderer (Pitfall 5).
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

      // Best-effort: pre-create the runs dir so Wave 2's run trigger can
      // append without an extra mkdir roundtrip. Failure here is
      // non-fatal — runs writer can mkdirSync lazily.
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
}
