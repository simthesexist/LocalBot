// BrowserWindow factory.

import { BrowserWindow, app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { appendAuditLine } from './audit/logger';
import { CHANNELS } from '../shared/ipc-channels';
import { hasStoredKey } from './ipc/key';
import { loadSession } from './sessions/jsonl';

// Per-window app:init trigger so the renderer can ASK main to re-send the
// payload after its React useEffect has registered the listener. This
// closes the race window between Electron's `did-finish-load` (which fires
// the initial send) and the renderer's first effect commit. Without this,
// the listener can be registered after the event was already sent, leaving
// `hasKey` stuck at `null` and the renderer permanently on "Loading…".
const appInitTriggers = new Map<number, () => Promise<void>>();

// Registered exactly once at module load — createMainWindow can be called
// multiple times (e.g. macOS app reactivation), but the IPC channel only
// needs one handler. The handler looks up the per-window trigger by the
// sender's webContents.id.
ipcMain.on(CHANNELS.REQUEST_APP_INIT, (evt) => {
  const trigger = appInitTriggers.get(evt.sender.id);
  if (trigger) void trigger();
});

export type RendererTarget =
  | { kind: 'built'; path: string }
  | { kind: 'dev'; url: string };

/**
 * Resolve which renderer entry point to load.
 *
 * Branch on whether a built renderer file exists on disk — not on the packaged
 * flag from electron's app module, which is unreliable when both `electron .`
 * (dev) and `electron dist/main/index.js` (npm start) run unpackaged on a
 * single-machine Windows workflow.
 *
 * - built branch → `win.loadFile(target.path)`
 * - dev   branch → `win.loadURL(target.url)`  (default: http://localhost:5173)
 */
export function resolveRendererUrl(opts: {
  builtIndexPath: string;
  devUrl?: string;
}): RendererTarget {
  if (fs.existsSync(opts.builtIndexPath)) {
    return { kind: 'built', path: opts.builtIndexPath };
  }
  return { kind: 'dev', url: opts.devUrl ?? 'http://localhost:5173' };
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: 'Localbot',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#222',
      height: 32,
    },
    backgroundColor: '#ffffff',
    icon: path.join(app.getAppPath(), 'resources', 'icon.svg'),
    show: false,
    webPreferences: {
      // window.js lives in dist/main/, so the preload sits next to it in
      // dist/main/preload/index.js — NOT dist/preload/index.js (which
      // would be one level too high and would silently fail to load,
      // leaving the renderer without window.localbot and stuck on
      // "Loading…"). This was the original app:init race root cause —
      // without a working preload bridge, EVENT_APP_INIT had no listener.
      preload: path.join(__dirname, 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  // Build the app:init payload once and reuse the same closure if the
  // renderer requests a re-send via REQUEST_APP_INIT (see module-level
  // handler above). The `did-finish-load` send is kept as the primary path;
  // the pull-request path is a backstop for the case where React's
  // useEffect registers the listener after main already sent.
  const sendAppInit = async () => {
    try {
      const [hasKey, session] = await Promise.all([hasStoredKey(), loadSession('default')]);
      win.webContents.send(CHANNELS.EVENT_APP_INIT, {
        hasKey,
        messages: session.messages,
        headSummary: session.headSummary,
      });
    } catch (err) {
      win.webContents.send(CHANNELS.EVENT_APP_INIT, { hasKey: false, messages: [], headSummary: null });
    }
  };
  appInitTriggers.set(win.webContents.id, sendAppInit);

  win.webContents.on('did-finish-load', () => {
    void sendAppInit();
  });

  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    void appendAuditLine({
      bot: '__system__',
      tool: 'did_fail_load',
      params: { errorCode, errorDescription, validatedURL },
      outcome: 'error',
      durationMs: 0,
      error: { code: 'load_failure', message: errorDescription },
    });
  });

  const builtIndexPath = path.join(__dirname, '..', 'renderer', 'index.html');
  const target = resolveRendererUrl({ builtIndexPath });
  if (target.kind === 'dev') {
    void win.loadURL(target.url);
  } else {
    void win.loadFile(target.path);
  }

  return win;
}
