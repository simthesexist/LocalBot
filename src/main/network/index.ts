// Phase 9 Plan 1+2: barrel for the network control-plane.
//
// Public surface for `src/main/index.ts` and the unit-test suite:
//   - `registerNetworkHandlers`        — wires IPC channels
//   - `startNetworkServer` + `rebindServer` — bind + rebind the
//                                          http+ws server (Wave 2
//                                          adds the rebind path for
//                                          the bind-mode toggle UX)
//   - `servePhoneBundle`              — re-exported from ./static
//   - `dispatchWsMessage`             — re-exported from ./handlers
//   - `currentNetworkHandle`          — module-scope singleton (Wave 2)
//   - `subscribeReachInfo`            — Wave 2 fan-out helper so main
//                                          can re-broadcast reach info
//                                          to all renderer windows
//                                          without duplicating the
//                                          Tailscale-detect call.

import { appendAuditLine } from '../audit/logger';
import { phoneBundleDir } from '../paths';
import type { ReachInfo } from '../../shared/types';

export { startNetworkServer, rebindServer } from './server';
export type { NetworkServerHandle, StartNetworkServerOptions } from './server';

export { dispatchWsMessage, _activeRunCount, __resetWsRuns } from './handlers';

export { servePhoneBundle } from './static';

export { registerNetworkHandlers } from '../ipc/network';

import type { NetworkServerHandle } from './server';

/**
 * Wave 2: module-scope singleton so the IPC handler in
 * `src/main/ipc/network.ts` can call `rebindServer(currentHandle, ...)`
 * when the renderer flips bindMode. Updated atomically inside
 * `rebindServer` (success path) and `startNetworkServer` (initial bind).
 */
let currentNetworkHandle: NetworkServerHandle | null = null;

export function setCurrentNetworkHandle(handle: NetworkServerHandle | null): void {
  currentNetworkHandle = handle;
}

export function getCurrentNetworkHandle(): NetworkServerHandle | null {
  return currentNetworkHandle;
}

/**
 * Wave 2: high-level rebind that resolves host/port from the persisted
 * config + bindMode, looks up the current handle, and invokes the
 * server's rebind path. Returns a structured `{ok, error?}` so the IPC
 * handler can surface failures inline in the NetworkSettingsModal.
 */
export async function rebindNetworkServer(
  newHost: string,
  newPort: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!currentNetworkHandle) {
    return { ok: false, error: 'no_active_server' };
  }
  try {
    await currentNetworkHandle.rebind(newHost, newPort);
    await appendAuditLine({
      bot: '__system__',
      tool: 'lifecycle',
      params: { event: 'network.bind_change', host: newHost, port: newPort },
      outcome: 'ok',
      durationMs: 0,
    });
    return { ok: true };
  } catch (err) {
    const message = (err instanceof Error) ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Wave 2: fan-out helper for reach-info changes. `src/main/index.ts`
 * subscribes once on app-ready and forwards each `ReachInfo` to every
 * `BrowserWindow` via `EVENT_REACH_INFO_UPDATED`. Subscribers are
 * notified synchronously; an exception in one listener does not break
 * the others.
 */
let reachInfoSubscribers: Array<(info: ReachInfo) => void> = [];

export function subscribeReachInfo(fn: (info: ReachInfo) => void): () => void {
  reachInfoSubscribers.push(fn);
  return () => {
    reachInfoSubscribers = reachInfoSubscribers.filter((s) => s !== fn);
  };
}

export function broadcastReachInfo(info: ReachInfo): void {
  for (const s of reachInfoSubscribers.slice()) {
    try {
      s(info);
    } catch {
      /* ignore — a dead subscriber must not break the rest */
    }
  }
}

// phoneBundleDir() is re-exported as a convenience for the IPC handler
// that needs to pass the bundle dir into `rebindServer`. The server.ts
// rebind path uses the same `phoneBundleDir` that the initial bind used.
export { phoneBundleDir };