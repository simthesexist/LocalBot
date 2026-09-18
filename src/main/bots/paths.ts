// Phase 4 Wave 1: filesystem paths for per-bot metadata + runs (audit) data.
//
// Paths live under <userData>/bots/<id>/config.json (metadata) and
// <userData>/runs/<id>.jsonl (Wave 2 run ledger). These helpers are the
// single source of truth for main-side paths; the daemon has its own
// equivalent module (daemon/bots/loader.cjs) so it never has to import
// from src/main.

import path from 'node:path';
import { botsDir, userDataDir } from '../paths';

/**
 * Absolute path to a bot's config.json. Main never writes to this path
 * directly — it always routes through the daemon's bots/{create,delete}
 * JSON-RPC methods — but it does read the file when bootstrapping the
 * initial bot list shipped with app:init (so the sidebar can hydrate
 * synchronously without an extra IPC roundtrip).
 */
export function configPath(botId: string): string {
  return path.join(botsDir(), botId, 'config.json');
}

/**
 * Directory holding run JSONL files for a bot. Wave 2 introduces the run
 * writer; Wave 1 only ensures the directory exists so a freshly-created
 * bot doesn't 404 when the run trigger eventually fires.
 */
export function runsDir(botId: string): string {
  return path.join(userDataDir(), 'runs', botId);
}

/**
 * Single-run JSONL path. The runs writer appends one line per call/site
 * (start, tool, end). Wave 1 doesn't write runs, but exposing the path
 * here keeps the run trigger's Wave 2 implementation trivial.
 */
export function runsFilePath(botId: string, runId: string): string {
  return path.join(runsDir(botId), `${runId}.jsonl`);
}

/**
 * Ensure the runs directory exists for `botId`. Returns the absolute
 * path. Idempotent — safe to call from any IPC handler.
 */
export async function ensureRunsDir(botId: string): Promise<string> {
  const dir = runsDir(botId);
  const fs = await import('node:fs/promises');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
