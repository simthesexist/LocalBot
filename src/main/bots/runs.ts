// Phase 4 Wave 2: typed wrappers for the run history NDJSON writer.
//
// Swallows ENOENT and unexpected errors so the renderer never sees raw
// fs errors — the IPC bridge returns {ok:false, error} envelopes.

import { appendRun, listRuns } from '../runs/jsonl';
import type { RunRecord } from '../../shared/types';

export async function appendRunRecord(bot: string, record: RunRecord): Promise<{ ok: boolean; error?: string }> {
  try {
    await appendRun(bot, record);
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[bots/runs] appendRunRecord failed for bot=${bot}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

export async function listRunRecords(
  bot: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<RunRecord[]> {
  try {
    return await listRuns(bot, opts.limit, opts.offset);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[bots/runs] listRunRecords failed for bot=${bot}: ${(err as Error).message}`);
    return [];
  }
}
