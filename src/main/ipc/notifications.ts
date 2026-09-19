// Phase 6 Wave 2: bridge the daemon's `notification:scheduled-error` to an
// Electron Notification toast, and route the click back to the renderer via
// `event:navigate-to-bot`. This is the canonical toast constructor for the
// app — the renderer never constructs toasts directly.
//
// Flow:
//   daemon croner tick -> sendNotification('notification:scheduled-error', payload)
//     -> daemon NDJSON -> main spawn.ts dispatchLine
//     -> onNotification listener registered below
//     -> broadcast(EVENT_NOTIFICATION_SCHEDULED_ERROR) to all renderers
//     -> handleScheduledError constructs Notification + .show()
//     -> Notification.on('click') -> focus window + webContents.send(EVENT_NAVIGATE_TO_BOT)
//     -> renderer setActiveBotId(botId)
//
// Threat model (06-02 threat register):
//   T-P6-09 (spoofing): only the daemon can emit notification:scheduled-error.
//     Renderer is sandboxed and cannot synthesize toasts.
//   T-P6-10 (DoS): 60s per-bot debounce. Different bots can still notify.
//   T-P6-11 (info disclosure): errorMessage.slice(0, 120) caps body length.
//   T-P6-13 (DoS): click handler wraps webContents.send in try/catch.
//   T-P6-15 (headless): Notification.isSupported() === false falls back to
//     console.warn only — no throw, no UI.

import { BrowserWindow, Notification, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { CHANNELS } from '../../shared/ipc-channels';
import type { ScheduledErrorEvent } from '../../shared/types';
import { onNotification } from '../daemon/spawn';

export const DEFAULT_APP_USER_MODEL_ID = 'com.localbot.app';
const TOAST_DEBOUNCE_MS = 60_000;
const TOAST_BODY_MAX_CHARS = 120;

/**
 * Module-scope debounce state, keyed by bot id. Per-bot only — different
 * bots can still notify concurrently. Tests reset via __test__._resetForTest.
 */
const lastToastAt: Map<string, number> = new Map();

/**
 * Module-scope guard so app.setAppUserModelId is called exactly once per
 * process — Pitfall 6 mitigation (Windows Action Center grouping breaks
 * without it).
 */
let appUserModelIdSet = false;

function setAppUserModelIdOnce(): void {
  if (appUserModelIdSet) return;
  appUserModelIdSet = true;
  try {
    app.setAppUserModelId(DEFAULT_APP_USER_MODEL_ID);
  } catch {
    // Headless / sandboxed environments may throw on setAppUserModelId.
    // The toast still works; grouping under Localbot just degrades.
  }
}

/**
 * Best-effort: read the bot's display name from its config.json. Falls back
 * to the bot id (which is what the daemon emitted) when the file is missing,
 * unreadable, or fails to parse. The daemon's bot-loader is authoritative;
 * this is purely cosmetic.
 */
function resolveBotDisplayName(botId: string): string {
  try {
    const userData = process.env.LOCALBOT_USER_DATA_DIR || app.getPath('userData');
    const cfgPath = path.join(userData, 'bots', botId, 'config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (parsed && typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
      return parsed.name;
    }
  } catch {
    // Fall through to botId fallback.
  }
  return botId;
}

/**
 * Construct + show the Windows toast for a scheduled-error event.
 *
 * Behavior:
 *   - Drops the toast when Notification.isSupported() === false (headless
 *     Linux without libnotify, CI runner). Logs a console.warn instead.
 *   - Per-bot 60s debounce so a flapping cron doesn't spam Action Center.
 *   - Truncates the body to 120 chars to minimize disclosure (the full
 *     error stack remains in the run history + audit JSONL on the daemon).
 *   - Attaches a click handler that focuses the main window (or creates
 *     one if missing/destroyed) and emits EVENT_NAVIGATE_TO_BOT.
 *
 * Exported so tests can drive it directly without going through the
 * onNotification listener registration.
 */
export function handleScheduledError(
  payload: ScheduledErrorEvent,
  deps: {
    getMainWindow: () => BrowserWindow | null;
    createMainWindow: () => BrowserWindow;
  } = {
    getMainWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
    createMainWindow: () => {
      // Lazy require to avoid a circular import (window.ts imports ipc/notifications).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('../window').createMainWindow();
    },
  },
): void {
  setAppUserModelIdOnce();

  if (!Notification.isSupported()) {
    // eslint-disable-next-line no-console
    console.warn(
      `[notifications] Notification API not supported; skipping toast for bot="${payload.bot}"`,
    );
    return;
  }

  const now = Date.now();
  const last = lastToastAt.get(payload.bot) ?? 0;
  if (now - last < TOAST_DEBOUNCE_MS) {
    return;
  }
  lastToastAt.set(payload.bot, now);

  const botName = resolveBotDisplayName(payload.bot);
  const body = (payload.errorMessage ?? '').slice(0, TOAST_BODY_MAX_CHARS);

  const notification = new Notification({
    title: `Bot errored: ${botName}`,
    body,
    silent: false,
  });

  notification.on('click', () => {
    let win = deps.getMainWindow();
    try {
      if (!win || win.isDestroyed()) {
        win = deps.createMainWindow();
      }
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch {
      // Window could not be focused — fall through; we still try to emit
      // the navigate event so the renderer's next paint can switch panes
      // even if the window remained hidden.
    }
    try {
      win?.webContents.send(CHANNELS.EVENT_NAVIGATE_TO_BOT, { botId: payload.bot });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[notifications] webContents.send(EVENT_NAVIGATE_TO_BOT) failed', err);
    }
  });

  notification.show();
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/**
 * Register the onNotification listener for the daemon's
 * `notification:scheduled-error` method. Safe to call multiple times —
 * the onNotification set is keyed by method string so re-registration
 * overwrites the prior listener without leaking.
 *
 * Also fires the app.setAppUserModelId guard so the toast groups under
 * "Localbot" in Windows Action Center on the very first scheduled error.
 */
export function registerNotificationHandlers(): void {
  setAppUserModelIdOnce();
  onNotification('notification:scheduled-error', (params) => {
    try {
      const payload = params as ScheduledErrorEvent;
      broadcast(CHANNELS.EVENT_NOTIFICATION_SCHEDULED_ERROR, payload);
      handleScheduledError(payload);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[notifications] failed to handle scheduled-error', err);
    }
  });
}

// Test seams — exposed so unit tests can drive debounce + reset state
// without depending on Electron's runtime. Not part of the public API.
export const __test__ = {
  TOAST_DEBOUNCE_MS,
  TOAST_BODY_MAX_CHARS,
  DEFAULT_APP_USER_MODEL_ID,
  lastToastAt,
  isAppUserModelIdSet: () => appUserModelIdSet,
  _resetForTest(): void {
    lastToastAt.clear();
    appUserModelIdSet = false;
  },
};
