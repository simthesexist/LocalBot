// Memory IPC handlers. Phase 3 tracer slice.
//
// The renderer never touches the filesystem or the daemon JSON-RPC
// directly. CHANNEL_MEMORY_READ is invoked with {bot} and returns the same
// shape as the daemon's memory.read result.

import { ipcMain, BrowserWindow } from 'electron';
import { CHANNELS } from '../../shared/ipc-channels';
import { callMemory } from '../daemon/spawn';
import type { MemoryReadRequest, MemoryReadResult } from '../../shared/types';

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

export function registerMemoryHandlers(): void {
  ipcMain.handle(CHANNELS.MEMORY_READ, async (_evt, req: MemoryReadRequest): Promise<MemoryReadResult> => {
    if (!req || typeof req.bot !== 'string') {
      return {
        markdown: '',
        facts: {},
        bytes: 0,
        factCount: 0,
        updatedAt: new Date(0).toISOString(),
      };
    }
    try {
      const result = (await callMemory('memory/read', { bot: req.bot })) as MemoryReadResult;
      broadcast(CHANNELS.EVENT_MEMORY_UPDATED, {
        bot: req.bot,
        factCount: result.factCount ?? 0,
        bytes: result.bytes ?? 0,
        updatedAt: result.updatedAt ?? new Date().toISOString(),
      });
      return result;
    } catch (err) {
      // Defensive default — never throw to the renderer (Pitfall 5).
      return {
        markdown: '',
        facts: {},
        bytes: 0,
        factCount: 0,
        updatedAt: new Date(0).toISOString(),
        parseError: (err as Error).message,
      };
    }
  });
}
