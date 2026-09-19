// Phase 7 Plan 2: renderer-side vault config store.
//
// Mirrors src/renderer/state/bots.ts (module-scope state + subscribers +
// ensureDaemonSubscription). The renderer NEVER computes vaultRoot itself
// (T-7-13 — threat model) — it only renders what the daemon resolved and
// surfaced through `window.localbot.vault.getConfig`.
//
// Refresh is throttled (REFRESH_MIN_INTERVAL_MS = 200) so a flood of
// EVENT_VAULT_CONFIG_UPDATED events cannot hammer the IPC bridge (Pitfall 4
// — vault subscriptions are debounced, not per-keystroke).

import { useCallback, useEffect, useState } from 'react';
import type { VaultConfigResult, VaultGlobalConfig } from '../../shared/types';

export interface VaultConfigState {
  config: VaultGlobalConfig | null;
  loading: boolean;
  error: string | null;
}

const state: VaultConfigState = {
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
  const off = window.localbot.on('vault:config:updated', () => {
    void refresh();
  });
  if (typeof window !== 'undefined') {
    window.addEventListener(
      'beforeunload',
      () => {
        try {
          off();
        } catch {
          /* ignore */
        }
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
    const res = (await window.localbot.vault.getConfig()) as VaultConfigResult;
    if (!res || !res.ok) {
      state.error = (res && res.error) || 'failed to load vault config';
      state.config = null;
    } else {
      state.config = res.config ?? { rootPath: '', globalDeny: [] };
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

function getSnapshot(): VaultConfigState {
  return {
    config: state.config,
    loading: state.loading,
    error: state.error,
  };
}

/**
 * React hook returning the vault config snapshot. On first mount, primes
 * the daemon subscription exactly once and runs an initial refresh so the
 * settings surfaces can render without waiting for an explicit user action.
 */
export function useVaultConfig(): VaultConfigState & { refresh: () => Promise<void> } {
  const [snapshot, setSnapshot] = useState<VaultConfigState>(getSnapshot);
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
 * Action surface. Mirrors the bots.ts triggerBot / cancelBotRun / updateBot
 * pattern — the renderer never touches window.localbot.vault.* directly.
 */
export const vaultActions = {
  async refresh(): Promise<void> {
    await refresh();
  },
  async setConfig(cfg: VaultGlobalConfig): Promise<VaultConfigResult> {
    if (typeof window === 'undefined' || !window.localbot) {
      return { ok: false, error: 'localbot not available' };
    }
    const res = (await window.localbot.vault.setConfig({
      rootPath: cfg.rootPath,
      globalDeny: cfg.globalDeny.slice(),
    })) as VaultConfigResult;
    if (res && res.ok) {
      await refresh();
    }
    return res ?? { ok: false, error: 'no response' };
  },
};

// Test hooks — exported for unit tests.
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