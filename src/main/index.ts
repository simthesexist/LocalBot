// Electron main entry.

import { app } from 'electron';
import { createMainWindow } from './window';
import { registerKeyHandlers } from './ipc/key';
import { registerChatHandlers } from './ipc/chat';
import { registerHistoryHandlers } from './ipc/history';
import { registerMemoryHandlers } from './ipc/memory';
import { registerTreeHandlers } from './ipc/tree';
import { spawnDaemon, stopDaemon } from './daemon/spawn';
import { ensureUserDataDirs } from './paths';
import { appendAuditLine } from './audit/logger';

// Enforce single instance.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  // Focus existing window.
  const windows = require('electron').BrowserWindow.getAllWindows();
  if (windows.length > 0) {
    const w = windows[0];
    if (w.isMinimized()) w.restore();
    w.focus();
  }
});

void app.whenReady().then(async () => {
  try {
    await ensureUserDataDirs();
    await appendAuditLine({
      bot: '__system__',
      tool: 'lifecycle',
      params: { event: 'start' },
      outcome: 'ok',
      durationMs: 0,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('ensureUserDataDirs failed', err);
  }

  // Register IPC handlers BEFORE creating the window so app:init payload resolves correctly.
  registerKeyHandlers();
  registerChatHandlers();
  registerHistoryHandlers();
  registerMemoryHandlers();
  registerTreeHandlers();

  createMainWindow();

  // Spawn daemon last so it doesn't block window boot.
  void spawnDaemon();

  app.on('activate', () => {
    if (require('electron').BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  await stopDaemon();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  await stopDaemon();
});
