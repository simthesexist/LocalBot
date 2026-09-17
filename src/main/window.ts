// BrowserWindow factory.

import { BrowserWindow, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { appendAuditLine } from './audit/logger';
import { CHANNELS } from '../shared/ipc-channels';
import { hasStoredKey } from './ipc/key';
import { loadSession } from './sessions/jsonl';

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
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.webContents.on('did-finish-load', async () => {
    try {
      const [hasKey, messages] = await Promise.all([hasStoredKey(), loadSession()]);
      win.webContents.send(CHANNELS.EVENT_APP_INIT, {
        hasKey,
        messages,
      });
    } catch (err) {
      win.webContents.send(CHANNELS.EVENT_APP_INIT, { hasKey: false, messages: [] });
    }
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
