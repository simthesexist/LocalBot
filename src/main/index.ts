// Electron main entry.

import { app, protocol, BrowserWindow } from 'electron';
import { createMainWindow } from './window';
import { registerKeyHandlers } from './ipc/key';
import { registerChatHandlers } from './ipc/chat';
import { registerHistoryHandlers } from './ipc/history';
import { registerMemoryHandlers } from './ipc/memory';
import { registerTreeHandlers } from './ipc/tree';
import { registerBotHandlers } from './ipc/bots';
// Phase 7 Plan 1: Obsidian vault config IPC handlers (VAULT_GET_CONFIG +
// VAULT_SET_CONFIG + EVENT_VAULT_CONFIG_UPDATED broadcast).
import { registerVaultHandlers } from './ipc/vault';
// Phase 8 Plan 2: browser IPC handlers (BROWSER_GET_SCREENSHOT +
// BROWSER_DELETE_CONTEXT) + app:// custom protocol handler for serving
// screenshot PNGs to the renderer.
import { registerBrowserHandlers } from './ipc/browser';
// Phase 9 Plan 1: phone-reach + ship. registerNetworkHandlers is a pure
// IPC channel registration (no I/O); startNetworkServer binds the HTTP +
// WS control plane on the persisted host:port (default 127.0.0.1:7878).
import {
  registerNetworkHandlers,
  startNetworkServer,
  subscribeReachInfo,
  broadcastReachInfo,
  setCurrentNetworkHandle,
} from './network';
import { initUpdater } from './network/updater';
import { detectReach, clearCache } from './network/tailscale';
import { spawnDaemon, stopDaemon } from './daemon/spawn';
import { ensureUserDataDirs, phoneBundleDir, ensurePhoneBundleDir } from './paths';
import { CHANNELS } from '../shared/ipc-channels';
import { appendAuditLine } from './audit/logger';
import { ensureTreeWatcherStarted } from './tree/list';

// Phase 8 Plan 2: register `app://` as a privileged scheme BEFORE
// app.whenReady(). Electron requires scheme privileges to be declared
// before `protocol.handle` is called, and that handler can only run
// after ready. Failing to register this here means protocol.handle('app')
// throws ERR_INVALID_SCHEME at runtime (Pitfall 8: must be top-level
// before any ready handlers).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      // stream: true → the handler may return a Response with a stream body.
      // We use Response with raw Buffer (PNG bytes) — declared here so
      // Chromium does not reject the response at the network layer.
      stream: true,
      // bypassCSP: false (default) — keep CSP enforcement on.
      bypassCSP: false,
      corsEnabled: false,
    },
  },
]);

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
  registerBotHandlers();
  // Phase 7 Plan 1: vault config IPC.
  registerVaultHandlers();
  // Phase 8 Plan 2: browser IPC + app:// protocol handler. Must be
  // called inside whenReady (the protocol.handle call inside
  // registerBrowserHandlers requires app to be ready) but AFTER the
  // scheme registration above (top-level).
  registerBrowserHandlers();
  // Phase 9 Plan 1: network config IPC. Pure channel registration; no
  // side effects.
  registerNetworkHandlers();

  createMainWindow();

  // Spawn daemon last so it doesn't block window boot.
  void spawnDaemon();
  // Wire the daemon's tree:refresh notifications to the renderer's
  // EVENT_TREE_REFRESH broadcast.
  ensureTreeWatcherStarted();

  // Phase 9 Plan 1: bind the HTTP+WS control plane AFTER the daemon
  // spawn resolves (so `network/get_config` is reachable if the renderer
  // fires it on first paint). The promise is fire-and-forget here so a
  // bind failure (port collision, etc.) doesn't block window boot; the
  // bind error is logged via the audit row inside startNetworkServer.
  // The network handle is stashed on `app` so the module-level
  // `before-quit` handler below can close it on shutdown.
  void (async () => {
    try {
      await ensurePhoneBundleDir();
      const handle = await startNetworkServer({ phoneBundleDir: phoneBundleDir() });
      setCurrentNetworkHandle(handle);
      // Stash the handle on `app` so the app-level before-quit teardown
      // can close it (only one before-quit handler — keeps Electron's
      // async-handler ordering simpler than registering two).
      (app as unknown as { __networkHandle?: typeof handle }).__networkHandle = handle;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[network] startNetworkServer failed', err);
    }
  })();

  // Phase 9 Plan 2: subscribe to reach-info broadcasts and forward each
  // ReachInfo to every BrowserWindow via EVENT_REACH_INFO_UPDATED.
  // Periodic 5s refresh matches the tailscale cache TTL — pushes a fresh
  // value when the Tailscale state changes without flooding IPC.
  const unsubscribeReach = subscribeReachInfo((info) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(CHANNELS.EVENT_REACH_INFO_UPDATED, { ...info, at: Date.now() });
      }
    }
  });

  // Phase 9 Plan 3: initialize electron-updater (manual flow) and forward
  // each status change to every BrowserWindow via EVENT_UPDATE_STATUS_CHANGED.
  // initUpdater sets autoDownload=false + autoInstallOnAppQuit=false +
  // channel from network.json (Pitfall 6 mitigation) BEFORE registering
  // any autoUpdater.on() handlers.
  void initUpdater((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(CHANNELS.EVENT_UPDATE_STATUS_CHANGED, status);
      }
    }
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[updater] initUpdater failed', err);
  });
  const reachInterval = setInterval(() => {
    void (async () => {
      try {
        clearCache();
        const info = await detectReach();
        broadcastReachInfo(info);
      } catch {
        /* swallow — periodic refresh must never crash main */
      }
    })();
  }, 5000);
  app.on('before-quit', () => {
    try { unsubscribeReach(); } catch { /* ignore */ }
    try { clearInterval(reachInterval); } catch { /* ignore */ }
  });

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
  // Phase 9 Plan 1: close the WS endpoint BEFORE stopping the daemon so
  // an in-flight sendMessage aborts cleanly (otherwise its on('close')
  // handler tries to forward to a dead daemon).
  const handle = (app as unknown as { __networkHandle?: { close: () => Promise<void> } }).__networkHandle;
  if (handle) {
    try { await handle.close(); } catch { /* ignore */ }
  }
  await stopDaemon();
});