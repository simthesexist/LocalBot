// BrowserWindow factory.

import { BrowserWindow, app } from 'electron';
import path from 'node:path';
import { appendAuditLine } from './audit/logger';
import { CHANNELS } from '../shared/ipc-channels';
import { hasStoredKey } from './ipc/key';
import { loadSession } from './sessions/jsonl';

const isDev = !app.isPackaged;

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

  if (isDev) {
    void win.loadURL('http://localhost:5173');
  } else {
    const indexPath = path.join(__dirname, '..', '..', 'renderer', 'index.html');
    void win.loadFile(indexPath);
  }

  return win;
}
