// History IPC handlers. Phase 3 tracer slice.
//
// CHANNEL_HISTORY_LIST: list session files for a bot (newest-first).
// CHANNEL_HISTORY_LOAD: read one session by id, returning messages +
// headSummary (the first summary record if summarization ran).

import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CHANNELS } from '../../shared/ipc-channels';
import { sessionsDir } from '../paths';
import { loadSession } from '../sessions/jsonl';
import type { HistoryListRequest, HistoryLoadRequest, HistoryLoadResult, SessionEntry } from '../../shared/types';

async function listSessionsForBot(bot: string): Promise<SessionEntry[]> {
  const botDir = path.join(sessionsDir(), bot);
  let entries: string[];
  try {
    entries = await fs.readdir(botDir);
  } catch {
    return [];
  }
  const jsonls = entries.filter((e) => e.endsWith('.jsonl'));
  const out: SessionEntry[] = [];
  for (const name of jsonls) {
    const full = path.join(botDir, name);
    let stat;
    try { stat = await fs.stat(full); } catch { continue; }
    let messageCount = 0;
    try {
      const text = await fs.readFile(full, 'utf8');
      for (const line of text.split('\n')) {
        if (line.trim()) messageCount++;
      }
    } catch {
      // unreadable — skip
    }
    const sessionId = name.replace(/\.jsonl$/, '');
    out.push({
      sessionId,
      startedAt: stat.mtime.toISOString(),
      messageCount,
      isActive: false,
    });
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return out;
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

export function registerHistoryHandlers(): void {
  ipcMain.handle(CHANNELS.HISTORY_LIST, async (_evt, req: HistoryListRequest) => {
    if (!req || typeof req.bot !== 'string') {
      return { ok: false, error: 'invalid request' };
    }
    const sessions = await listSessionsForBot(req.bot);
    return { ok: true, sessions };
  });

  ipcMain.handle(CHANNELS.HISTORY_LOAD, async (_evt, req: HistoryLoadRequest): Promise<HistoryLoadResult> => {
    if (!req || typeof req.bot !== 'string' || typeof req.sessionId !== 'string') {
      return { messages: [], headSummary: null };
    }
    const result = await loadSession(req.bot, req.sessionId);
    broadcast(CHANNELS.EVENT_HISTORY_LOADED, {
      bot: req.bot,
      sessionId: req.sessionId,
    });
    return result;
  });
}