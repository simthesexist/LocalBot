// Phase 9 Plan 1: barrel for the network control-plane.
//
// Public surface for `src/main/index.ts` and the unit-test suite:
//   - `registerNetworkHandlers` — wires IPC channels for
//     `network:get_config` / `network:set_config` / `network:get_reach_info`
//     via `src/main/ipc/network.ts`.
//   - `startNetworkServer`       — binds the http+ws server on the configured
//     port and host (default 127.0.0.1:7878).
//   - `servePhoneBundle`         — re-exported from ./static for the
//     path-traversal test cases.
//   - `dispatchWsMessage`        — re-exported from ./handlers for the
//     WS handler test cases.
//
// Test seam: `__test__` exposes the internal reset hook so test suites can
// wipe `activeWsRuns` between cases without depending on a fresh module load.

export { startNetworkServer } from './server';
export type { NetworkServerHandle, StartNetworkServerOptions } from './server';

export { dispatchWsMessage, _activeRunCount, __resetWsRuns } from './handlers';

export { servePhoneBundle } from './static';

export { registerNetworkHandlers } from '../ipc/network';
