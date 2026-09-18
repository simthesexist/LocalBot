// Tree watcher bridge. Phase 3 Wave 2.
//
// Subscribes to the daemon's `tree:refresh` notification (emitted by
// `daemon/watcher.cjs` after a debounced chokidar event window) and
// broadcasts it to all renderer windows as `EVENT_TREE_REFRESH`.
//
// The daemon emits notifications as `{jsonrpc:"2.0", method, params}` over
// its stdout (same NDJSON pipe as request/response). The spawn bridge in
// `daemon/spawn.ts` forwards both envelopes — request/response stays on the
// pending-map path; notifications with no `id` are dispatched to listeners
// registered via `spawn.onNotification()`.

import { BrowserWindow } from 'electron';
import { CHANNELS } from '../../shared/ipc-channels';
import { onNotification } from '../daemon/spawn';

let started = false;
let unsubscribe: (() => void) | null = null;

function broadcastTreeRefresh(payload: { rootPath: string; changedPaths: string[] }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNELS.EVENT_TREE_REFRESH, {
      bot: 'default',
      rootPath: payload.rootPath,
      changedPaths: payload.changedPaths ?? [],
    });
  }
}

/**
 * Subscribe to the daemon's tree:refresh notifications. Idempotent — a second
 * call returns the existing unsubscribe without registering twice.
 */
export function startTreeWatcher(): () => void {
  if (started) {
    return unsubscribe ?? (() => {});
  }
  unsubscribe = onNotification('tree:refresh', (params) => {
    const p = params as { rootPath?: string; changedPaths?: string[] } | undefined;
    if (!p || typeof p.rootPath !== 'string') return;
    broadcastTreeRefresh({ rootPath: p.rootPath, changedPaths: p.changedPaths ?? [] });
  });
  started = true;
  return unsubscribe;
}

export function stopTreeWatcher(): void {
  if (unsubscribe) {
    try { unsubscribe(); } catch { /* ignore */ }
    unsubscribe = null;
  }
  started = false;
}
