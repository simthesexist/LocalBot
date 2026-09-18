// Phase 4 Wave 1: renderer-side bot metadata store.
//
// Module-scope state (mirrors Phase 3's sessions/memory pattern) so the
// sidebar and any future settings page can share a single source of
// truth for the bot list + active bot. The first mount of `useBots()`
// subscribes to `EVENT_BOT_LIST_UPDATED` exactly once (tracked via
// `mountedCount`) so a re-render of every consumer does not multiply
// the IPC round-trips.

import { useCallback, useEffect, useState } from 'react';
import type { BotConfig } from '../../shared/types';

interface BotsSnapshot {
  bots: BotConfig[];
  activeBotId: string;
  loading: boolean;
  error: string | null;
}

interface BotsState extends BotsSnapshot {
  setBots: (b: BotConfig[]) => void;
  setActiveBotId: (id: string) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
}

const state: BotsState = {
  bots: [],
  activeBotId: 'default',
  loading: false,
  error: null,
  setBots: (b) => {
    state.bots = b;
    notify();
  },
  setActiveBotId: (id) => {
    state.activeBotId = id;
    notify();
  },
  setLoading: (b) => {
    state.loading = b;
    notify();
  },
  setError: (e) => {
    state.error = e;
    notify();
  },
};

const subscribers = new Set<() => void>();
let mountedCount = 0;
let subscribedToDaemon = false;

function notify(): void {
  for (const cb of Array.from(subscribers)) {
    try { cb(); } catch { /* ignore — listener errors must not break other subscribers */ }
  }
}

function ensureDaemonSubscription(): void {
  if (subscribedToDaemon) return;
  subscribedToDaemon = true;
  if (!window.localbot) return;
  const off = window.localbot.on('bot:list:updated', () => {
    void refresh();
  });
  // Best-effort cleanup on window unload — most React apps do not need
  // this but keeps the listener count accurate during HMR reloads.
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      try { off(); } catch { /* ignore */ }
    }, { once: true });
  }
}

async function refresh(): Promise<void> {
  if (!window.localbot) return;
  state.setLoading(true);
  state.setError(null);
  try {
    const res = (await window.localbot.bot.list()) as {
      ok: boolean;
      bots?: BotConfig[];
      error?: string;
    };
    if (!res.ok) {
      state.setError(res.error ?? 'failed to load bots');
    } else {
      state.setBots(Array.isArray(res.bots) ? res.bots : []);
    }
  } catch (e) {
    state.setError((e as Error).message);
  } finally {
    state.setLoading(false);
  }
}

/**
 * Synchronously seed the store with the bot list shipped via
 * `app:init.bots`. Idempotent — only seeds when the store is empty so
 * a late-arriving `app:init` doesn't clobber a fresher `refresh()`
 * result.
 */
export function seedBots(initial: BotConfig[]): void {
  if (state.bots.length === 0 && Array.isArray(initial) && initial.length > 0) {
    state.setBots(initial);
  }
}

/**
 * Subscribe to the bot store snapshot. Returns a stable unsubscribe.
 * Used by `useBots()` + `useActiveBotId()`; exposed for tests.
 */
function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getSnapshot(): BotsSnapshot {
  return {
    bots: state.bots,
    activeBotId: state.activeBotId,
    loading: state.loading,
    error: state.error,
  };
}

/**
 * React hook returning the bot list + active id + lifecycle flags +
 * a `refresh()` action. On first mount, primes the daemon subscription
 * exactly once and runs an initial `refresh()` so the sidebar is
 * populated even when `app:init` arrived with an empty `bots` array
 * (e.g. before the daemon finished initialize).
 */
export function useBots(): {
  bots: BotConfig[];
  activeBotId: string;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<BotsSnapshot>(getSnapshot);

  useEffect(() => {
    mountedCount++;
    ensureDaemonSubscription();
    const off = subscribe(() => setSnapshot(getSnapshot()));
    // Prime the store on first mount so the sidebar hydrates even when
    // the initial `app:init.bots` was empty.
    if (mountedCount === 1 && state.bots.length === 0 && !state.loading) {
      void refresh();
    }
    return () => {
      off();
      mountedCount = Math.max(0, mountedCount - 1);
    };
  }, []);

  const refreshAction = useCallback(() => refresh(), []);
  return { ...snapshot, refresh: refreshAction };
}

export function useActiveBotId(): {
  activeBotId: string;
  setActiveBotId: (id: string) => void;
} {
  const [snapshot, setSnapshot] = useState<BotsSnapshot>(getSnapshot);
  useEffect(() => subscribe(() => setSnapshot(getSnapshot())), []);
  const setActiveBotId = useCallback((id: string) => state.setActiveBotId(id), []);
  return { activeBotId: snapshot.activeBotId, setActiveBotId };
}

// Test hooks — not part of the public API but exported for unit tests.
export const __test__ = {
  getSnapshot,
  subscribe,
  notify,
  state,
  reset(): void {
    state.bots = [];
    state.activeBotId = 'default';
    state.loading = false;
    state.error = null;
    subscribers.clear();
    mountedCount = 0;
    subscribedToDaemon = false;
    notify();
  },
};
