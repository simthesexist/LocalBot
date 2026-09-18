// Phase 4 Wave 3: per-bot run history cache + EVENT_BOT_STATUS push refresh.
//
// Module-scope Map<bot, RunHistoryCache> holds the cached rows + cursor so
// every consumer (currently RunHistoryTable inside BotSettingsPage) shares
// the same stale-while-revalidate snapshot. The hook also subscribes to
// `bot:status` events for the same bot and re-fetches the first page so a
// run that just completed appears immediately. A 5s polling fallback fires
// when the consumer hasn't received a push in a while (e.g. status events
// missed because the renderer was unmounted).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotStatusEvent, RunRecord } from '../../shared/types';

interface RunHistoryCache {
  runs: RunRecord[];
  cursor: number;
  loading: boolean;
  hasMore: boolean;
  error: string | null;
}

interface RunHistoryCacheInternal extends RunHistoryCache {
  /** Monotonic counter bumped on every refresh — lets us drop stale fetches. */
  epoch: number;
}

const DEFAULT_PAGE_SIZE = 50;
const POLL_INTERVAL_MS = 5_000;

const cache = new Map<string, RunHistoryCacheInternal>();
const subscribers = new Map<string, Set<() => void>>();
let mountedCount = 0;

function get(bot: string): RunHistoryCacheInternal {
  let c = cache.get(bot);
  if (!c) {
    c = { runs: [], cursor: 0, loading: false, hasMore: false, error: null, epoch: 0 };
    cache.set(bot, c);
  }
  return c;
}

function notify(bot: string): void {
  const set = subscribers.get(bot);
  if (!set) return;
  for (const cb of Array.from(set)) {
    try { cb(); } catch { /* ignore */ }
  }
}

function subscribe(bot: string, cb: () => void): () => void {
  let set = subscribers.get(bot);
  if (!set) {
    set = new Set();
    subscribers.set(bot, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) subscribers.delete(bot);
  };
}

async function refresh(bot: string): Promise<void> {
  const c = get(bot);
  c.epoch++;
  const epoch = c.epoch;
  c.loading = true;
  c.error = null;
  notify(bot);
  try {
    if (!window.localbot) throw new Error('localbot not available');
    const res = (await window.localbot.bot.runs({ bot, limit: DEFAULT_PAGE_SIZE })) as {
      ok: boolean; runs?: RunRecord[]; hasMore?: boolean; error?: string;
    };
    // Drop stale fetches.
    if (epoch !== get(bot).epoch) return;
    if (!res.ok) {
      c.error = res.error ?? 'failed to load run history';
    } else {
      c.runs = Array.isArray(res.runs) ? res.runs : [];
      c.hasMore = !!res.hasMore;
      c.cursor = c.runs.length;
    }
  } catch (e) {
    if (epoch !== get(bot).epoch) return;
    c.error = (e as Error).message;
  } finally {
    if (epoch === get(bot).epoch) {
      c.loading = false;
      notify(bot);
    }
  }
}

async function loadMore(bot: string, pageSize: number): Promise<void> {
  const c = get(bot);
  if (!c.hasMore || c.loading) return;
  c.epoch++;
  const epoch = c.epoch;
  c.loading = true;
  c.error = null;
  notify(bot);
  try {
    if (!window.localbot) throw new Error('localbot not available');
    const res = (await window.localbot.bot.runs({
      bot,
      limit: pageSize,
      offset: c.cursor,
    })) as { ok: boolean; runs?: RunRecord[]; hasMore?: boolean; error?: string };
    if (epoch !== get(bot).epoch) return;
    if (!res.ok) {
      c.error = res.error ?? 'failed to load more';
    } else {
      const next = Array.isArray(res.runs) ? res.runs : [];
      c.runs = [...c.runs, ...next];
      c.hasMore = !!res.hasMore;
      c.cursor = c.runs.length;
    }
  } catch (e) {
    if (epoch !== get(bot).epoch) return;
    c.error = (e as Error).message;
  } finally {
    if (epoch === get(bot).epoch) {
      c.loading = false;
      notify(bot);
    }
  }
}

/** Drop the cached rows for a bot — invoked by EVENT_BOT_LIST_UPDATED
 *  with reason === 'delete' so a re-created bot starts fresh. */
export function clearRunHistory(bot: string): void {
  cache.delete(bot);
  notify(bot);
}

export interface UseRunHistoryOpts {
  initialLimit?: number;
  pageSize?: number;
  /** Disable the 5s polling fallback (default false = poll). */
  polling?: boolean;
}

export interface UseRunHistoryResult {
  runs: RunRecord[];
  loading: boolean;
  hasMore: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useRunHistory(bot: string, opts: UseRunHistoryOpts = {}): UseRunHistoryResult {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const [snapshot, setSnapshot] = useState<RunHistoryCache>(() => ({ ...get(bot) }));
  const lastPushAtRef = useRef<number>(0);

  useEffect(() => {
    mountedCount++;
    const off = subscribe(bot, () => setSnapshot({ ...get(bot) }));
    // Prime on first mount (idempotent — the cache may already have rows
    // from a previous unmount, but `refresh()` is safe to call regardless).
    void refresh(bot);
    // Subscribe to EVENT_BOT_STATUS pushes for the same bot.
    let offStatus: (() => void) | undefined;
    if (window.localbot) {
      offStatus = window.localbot.on('bot:status', (payload) => {
        const p = payload as Partial<BotStatusEvent>;
        if (p && p.bot === bot) {
          lastPushAtRef.current = Date.now();
          void refresh(bot);
        }
      });
    }
    // 5s polling fallback — only when polling !== false.
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    if (opts.polling !== false) {
      pollTimer = setInterval(() => {
        if (Date.now() - lastPushAtRef.current >= POLL_INTERVAL_MS) {
          void refresh(bot);
        }
      }, POLL_INTERVAL_MS);
    }
    return () => {
      off();
      offStatus?.();
      if (pollTimer) clearInterval(pollTimer);
      mountedCount = Math.max(0, mountedCount - 1);
    };
  }, [bot, opts.polling, pageSize]);

  const loadMoreAction = useCallback(() => loadMore(bot, pageSize), [bot, pageSize]);
  const refreshAction = useCallback(() => refresh(bot), [bot]);
  return {
    runs: snapshot.runs,
    loading: snapshot.loading,
    hasMore: snapshot.hasMore,
    error: snapshot.error,
    loadMore: loadMoreAction,
    refresh: refreshAction,
  };
}

// Test hooks — not part of the public API.
export const __test__ = {
  cache,
  subscribers,
  reset(): void {
    cache.clear();
    subscribers.clear();
    mountedCount = 0;
  },
};
