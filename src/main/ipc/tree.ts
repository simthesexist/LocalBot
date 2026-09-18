// Tree IPC handlers. Phase 3 tracer slice.

import { ipcMain, BrowserWindow } from 'electron';
import { CHANNELS } from '../../shared/ipc-channels';
import { callTree } from '../daemon/spawn';
import type { TreeListRequest, TreeListResult } from '../../shared/types';

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

export function registerTreeHandlers(): void {
  ipcMain.handle(CHANNELS.TREE_LIST, async (_evt, req: TreeListRequest): Promise<TreeListResult> => {
    if (!req || typeof req.path !== 'string') {
      return { entries: [], truncated: false };
    }
    try {
      const result = (await callTree('tree/list', {
        path: req.path,
        ...(typeof req.maxDepth === 'number' ? { maxDepth: req.maxDepth } : {}),
        ...(typeof req.maxEntriesPerDir === 'number' ? { maxEntriesPerDir: req.maxEntriesPerDir } : {}),
        ...(Array.isArray(req.exclude) ? { exclude: req.exclude } : {}),
      })) as TreeListResult;
      broadcast(CHANNELS.EVENT_TREE_REFRESH, {
        bot: 'default',
        rootPath: req.path,
        changedPaths: [],
      });
      return result;
    } catch (err) {
      return { entries: [], truncated: false };
    }
  });
}
