// Phase 4 Wave 2: main-side per-bot run history NDJSON writer.
//
// Mirrors the daemon-side `daemon/runs/jsonl.cjs` shape but uses
// `node:fs/promises`. The per-bot mutex serializes concurrent writes
// (Pitfall 6 ordering: RunRecord append BEFORE status patch).

import fs from 'node:fs/promises';
import path from 'node:path';
import { runsDir } from '../bots/paths';
import type { RunRecord } from '../../shared/types';

const writeMutex = new Map<string, Promise<unknown>>();

export async function appendRun(bot: string, record: RunRecord): Promise<void> {
  if (!bot) throw new Error('bot required');
  await fs.mkdir(runsDir(bot), { recursive: true });
  const file = path.join(runsDir(bot), 'bot.jsonl');
  const line = JSON.stringify(record) + '\n';
  const prev = writeMutex.get(bot) || Promise.resolve();
  const next = prev.then(() => fs.appendFile(file, line, 'utf8'));
  writeMutex.set(bot, next);
  // Don't poison the chain on errors — surface to caller.
  return next;
}

export async function listRuns(bot: string, limit?: number): Promise<RunRecord[]> {
  const cap = typeof limit === 'number' && limit > 0 ? limit : 50;
  const file = path.join(runsDir(bot), 'bot.jsonl');
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const out: RunRecord[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
    try {
      out.push(JSON.parse(lines[i]) as RunRecord);
    } catch { /* skip malformed */ }
  }
  return out;
}
