// Phase 9 Plan 2: renderer-side network config store.
//
// Mirrors src/renderer/state/vault.ts (module-scope state + subscribers +
// throttled refresh). The renderer NEVER computes reach surface itself —
// it only renders what main resolved through `window.localbot.network.*`
// and forwards EVENT_NETWORK_CONFIG_UPDATED + EVENT_REACH_INFO_UPDATED
// broadcasts from main.
//
// Throttle (REFRESH_MIN_INTERVAL_MS = 250) prevents IPC floods when
// the renderer mounts ReachInfoPill + NetworkSettingsModal in the same
// frame.

import { useCallback, useEffect, useState } from 'react';
import type {
  NetworkConfig,
  NetworkConfigResult,
  ReachInfo,
} from '../../shared/types';

export interface NetworkConfigState {
  config: NetworkConfig | null;
  reachInfo: (ReachInfo & { at?: number }) | null;
  loading: boolean;
  error: string | null;
}

interface State {
  config: NetworkConfig | null;
  reachInfo: (ReachInfo & { at?: number }) | null;
  loading: boolean;
  error: string | null;
}

const state: State = {
  config: null,
  reachInfo: null,
  loading: false,
  error: null,
};

const subscribers = new Set<() => void>();
let mountedCount = 0;
let subscribedToDaemon = false;
let lastRefreshAt = 0;
const REFRESH_MIN_INTERVAL_MS = 250;

function notify(): void {
  for (const cb of Array.from(subscribers)) {
    try {
      cb();
    } catch {
      /* ignore */
    }
  }
}

function ensureDaemonSubscription(): void {
  if (subscribedToDaemon) return;
  subscribedToDaemon = true;
  if (typeof window === 'undefined' || !window.localbot) return;
  const offCfg = window.localbot.on('network:config:updated', () => {
    void refresh();
  });
  const offReach = window.localbot.on('network:reach:updated', (payload) => {
    state.reachInfo = payload as ReachInfo & { at?: number };
    notify();
  });
  if (typeof window !== 'undefined') {
    window.addEventListener(
      'beforeunload',
      () => {
        try { offCfg(); } catch { /* ignore */ }
        try { offReach(); } catch { /* ignore */ }
      },
      { once: true },
    );
  }
  void refresh();
  void refreshReach();
}

async function refresh(): Promise<void> {
  const now = Date.now();
  if (lastRefreshAt > 0 && now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return;
  lastRefreshAt = now;
  if (typeof window === 'undefined' || !window.localbot) return;
  state.loading = true;
  state.error = null;
  notify();
  try {
    const res = (await window.localbot.network.getConfig()) as NetworkConfigResult;
    if (!res || !res.ok) {
      state.error = (res && res.error) || 'failed to load network config';
      state.config = null;
    } else {
      state.config = res.config ?? null;
    }
  } catch (e) {
    state.error = (e as Error).message;
    state.config = null;
  } finally {
    state.loading = false;
    notify();
  }
}

async function refreshReach(): Promise<void> {
  if (typeof window === 'undefined' || !window.localbot) return;
  try {
    const r = (await window.localbot.network.getReachInfo()) as ReachInfo;
    state.reachInfo = r;
    notify();
  } catch {
    /* swallow — initial hydration is best-effort */
  }
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getSnapshot(): NetworkConfigState {
  return {
    config: state.config,
    reachInfo: state.reachInfo,
    loading: state.loading,
    error: state.error,
  };
}

export function useNetworkConfig(): NetworkConfigState & {
  refresh: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<NetworkConfigState>(getSnapshot);
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

export const networkActions = {
  async refresh(): Promise<void> {
    await refresh();
  },
  async setConfig(cfg: NetworkConfig): Promise<NetworkConfigResult> {
    if (typeof window === 'undefined' || !window.localbot) {
      return { ok: false, error: 'localbot not available' };
    }
    const res = (await window.localbot.network.setConfig(cfg)) as NetworkConfigResult;
    if (res && res.ok) {
      state.config = res.config ?? state.config;
      notify();
    }
    return res ?? { ok: false, error: 'no response' };
  },
  async getReachInfo(): Promise<ReachInfo> {
    const r = (await window.localbot.network.getReachInfo()) as ReachInfo;
    state.reachInfo = r;
    notify();
    return r;
  },
};

export const __test__ = {
  getSnapshot,
  subscribe,
  notify,
  state,
  reset(): void {
    state.config = null;
    state.reachInfo = null;
    state.loading = false;
    state.error = null;
    subscribers.clear();
    mountedCount = 0;
    subscribedToDaemon = false;
    lastRefreshAt = 0;
    notify();
  },
};