// Phase 8 Plan 3: renderer-side browser config store.
//
// Mirrors src/renderer/state/vault.ts (module-scope + subscribers +
// ensureDaemonSubscription + 200ms throttle). Per-bot browser settings
// (browserAllow / browserDeny / ssrfAllowInternal) are read from the
// bots/* entries on EVENT_BROWSER_CONFIG_UPDATED; the renderer's BotSettings
// tab patches them via bots/update.
//
// Refresh is throttled (REFRESH_MIN_INTERVAL_MS = 200) so a flood of
// browser config events cannot hammer the IPC bridge (Pitfall 4).
//
// The state is exposed via the useBrowserConfig hook + a browserActions
// helper that wraps the typed window.localbot.browser namespace. The
// renderer never calls window.localbot.browser.* directly.

import { useCallback, useEffect, useState } from 'react';
import type {
  BotConfig,
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
  BrowserDeleteContextRequest,
} from '../../shared/types';

export interface BrowserConfigState {
  /** Resolved per-bot config (or null when not yet loaded). */
  config: BotConfig | null;
  loading: boolean;
  error: string | null;
}

const state: BrowserConfigState = {
  config: null,
  loading: false,
  error: null,
};

const subscribers = new Set<() => void>();
let mountedCount = 0;
let subscribedToDaemon = false;
let lastRefreshAt = 0;
const REFRESH_MIN_INTERVAL_MS = 200;

function notify(): void {
  for (const cb of Array.from(subscribers)) {
    try {
      cb();
    } catch {
      /* ignore — listener errors must not break other subscribers */
    }
  }
}

function ensureDaemonSubscription(): void {
  if (subscribedToDaemon) return;
  subscribedToDaemon = true;
  if (typeof window === 'undefined' || !window.localbot) return;
  // The daemon broadcasts `browser:config:updated` on every bot.update
  // that touches browserAllow / browserDeny / ssrfAllowInternal. We treat
  // this as a "re-pull bots list" trigger because the per-bot config is
  // part of the bots array (not a separate vault-like global config).
  const off = window.localbot.on('browser:config:updated', () => {
    void refresh();
  });
  // The `browser:page:closed` event is informational — the renderer may
  // want to clear cached DOM state, but for the MVP we just re-pull.
  const offClosed = window.localbot.on('browser:page:closed', () => {
    void refresh();
  });
  if (typeof window !== 'undefined') {
    window.addEventListener(
      'beforeunload',
      () => {
        try { off(); } catch { /* ignore */ }
        try { offClosed(); } catch { /* ignore */ }
      },
      { once: true },
    );
  }
  void refresh();
}

async function refresh(): Promise<void> {
  // Throttle refreshes (Pitfall 4 — never IPC-flood). The first call (when
  // lastRefreshAt is 0) bypasses the throttle.
  const now = Date.now();
  if (lastRefreshAt > 0 && now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) {
    return;
  }
  lastRefreshAt = now;

  if (typeof window === 'undefined' || !window.localbot) return;
  state.loading = true;
  state.error = null;
  notify();
  try {
    const res = (await window.localbot.bot.list()) as {
      ok: boolean;
      bots?: BotConfig[];
      error?: string;
    };
    if (!res || !res.ok) {
      state.error = (res && res.error) || 'failed to load bots';
      state.config = null;
    } else {
      // We don't have a notion of "active bot config" in this store (the
      // useBrowserConfig hook is meant to be called by the BotSettingsPage
      // which already has the bot instance). We surface the FIRST bot as
      // a default snapshot so consumers can render an initial value before
      // a specific bot is selected.
      state.config = Array.isArray(res.bots) && res.bots.length > 0 ? res.bots[0] : null;
    }
  } catch (e) {
    state.error = (e as Error).message;
    state.config = null;
  } finally {
    state.loading = false;
    notify();
  }
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getSnapshot(): BrowserConfigState {
  return {
    config: state.config,
    loading: state.loading,
    error: state.error,
  };
}

/**
 * React hook returning the browser config snapshot + a refresh action.
 * On first mount, primes the daemon subscription exactly once and runs
 * an initial refresh so the settings surfaces can render without waiting
 * for an explicit user action.
 */
export function useBrowserConfig(): BrowserConfigState & { refresh: () => Promise<void> } {
  const [snapshot, setSnapshot] = useState<BrowserConfigState>(getSnapshot);
  useEffect(() => {
    mountedCount++;
    ensureDaemonSubscription();
    const off = subscribe(() => setSnapshot(getSnapshot()));
    if (mountedCount === 1 && !state.config && !state.loading) {
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

/**
 * Action surface — wraps the typed window.localbot.browser.* namespace
 * so the renderer never reaches into the global directly. Mirrors the
 * bots.ts triggerBot / cancelBotRun / updateBot pattern.
 */
export const browserActions = {
  async refresh(): Promise<void> {
    await refresh();
  },
  async getScreenshot(req: BrowserScreenshotRequest): Promise<BrowserScreenshotResult> {
    if (typeof window === 'undefined' || !window.localbot) {
      return { ok: false, error: 'no_ipc' };
    }
    try {
      const res = (await window.localbot.browser.getScreenshot(req)) as BrowserScreenshotResult;
      return res ?? { ok: false, error: 'no_response' };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  async deleteContext(req: BrowserDeleteContextRequest): Promise<{ ok: boolean; error?: string }> {
    if (typeof window === 'undefined' || !window.localbot) {
      return { ok: false, error: 'no_ipc' };
    }
    try {
      const res = (await window.localbot.browser.deleteContext(req)) as {
        ok: boolean; error?: string;
      };
      return { ok: !!res?.ok, error: res?.error };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};

// Test hooks — not part of the public API but exported for unit tests.
export const __test__ = {
  getSnapshot,
  subscribe,
  notify,
  state,
  reset(): void {
    state.config = null;
    state.loading = false;
    state.error = null;
    subscribers.clear();
    mountedCount = 0;
    subscribedToDaemon = false;
    lastRefreshAt = 0;
    notify();
  },
};
