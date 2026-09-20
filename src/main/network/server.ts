// Phase 9 Plan 1: HTTP + WebSocket control plane.
//
// `startNetworkServer({phoneBundleDir})` reads the persisted network config
// from `<userData>/network.json` (via `daemon/network/config.cjs` — the
// daemon is the single source of truth for `network.json`; main may also
// read it for fast-path lookups but NEVER writes it from this process).
// It binds an http.createServer that wraps:
//
//   - servePhoneBundle for GET / + GET /assets/* (path-traversal guarded)
//   - a WebSocketServer for ws:// connections, where each ws connection
//     hands off to `dispatchWsMessage` from ./handlers.
//
// Wave 2 adds `rebindServer(handle, newHost, newPort, phoneBundleDir)`:
// the bind-mode toggle UX in the renderer calls `network/set_config` with
// `bindMode:'lan'`, main proxies to the daemon which persists the change,
// then main invokes `rebindServer` so the listening socket flips from
// 127.0.0.1 → 0.0.0.0 without a full Electron restart. The swap uses the
// "open-new-before-closing-old" pattern (Pitfall 2 mitigation) so there is
// NEVER a window of ECONNREFUSED for the connected phone.
//
// Security baseline:
//   - Localhost-only default (NET-03 v1). `bindMode === 'lan'` is the only
//     way to opt into 0.0.0.0 binding, and the persisted config is
//     shape-validated by `loadNetworkConfig` BEFORE this file reads it.
//   - Wave 1 has NO auth. The README threat model (Pitfall 1, T-9-08) is
//     the only access control; Wave 2 adds Tailscale MagicDNS detection
//     + a `networkAuthToken` field.
//
// Audit minimization (T-9-04): the lifecycle audit row for `network.bind`
// carries ONLY `{event:'network.bind', host, port}`. No bindMode, no client
// address, no per-connection metadata. (bindMode is implied by `host`
// already; if host===0.0.0.0 the audit row itself signals the LAN opt-in.)

import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import { dispatchWsMessage } from './handlers';
import { servePhoneBundle } from './static';
import { appendAuditLine } from '../audit/logger';
import { userDataDir } from '../paths';

const _require = createRequire(__filename);

function loadDaemonNetworkConfig(): {
  loadNetworkConfig: (userDataDir: string) => {
    port: number;
    bindMode: 'localhost' | 'lan';
    updateChannel: 'latest' | 'beta' | 'nightly';
  };
} {
  // Probe a sequence of candidate paths. The first one that resolves wins.
  // Order: dist/runtime first (production), then source-relative (vitest).
  const candidates = [
    path.join(__dirname, '..', '..', 'daemon', 'network', 'config.cjs'),         // dist/main/network → dist/main/daemon/network
    path.join(__dirname, '..', '..', '..', 'daemon', 'network', 'config.cjs'),   // src/main/network → daemon/network
  ];
  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      return _require(candidate) as ReturnType<typeof loadDaemonNetworkConfig>;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `Could not load daemon/network/config.cjs from any candidate path. Last error: ${(lastErr as Error)?.message ?? lastErr}`,
  );
}

const networkConfig = loadDaemonNetworkConfig();

export interface NetworkServerHandle {
  host: string;
  port: number;
  close: () => Promise<void>;
  /**
   * Wave 2: rebind the listening socket to (newHost, newPort). The actual
   * implementation lives in `rebindServer` below; this field is a closure
   * so the handle can rebind itself recursively (toggle localhost → lan
   * → localhost without going back to the singleton).
   */
  rebind: (newHost: string, newPort: number) => Promise<void>;
  /**
   * Internal test seam: not exported. Used by `rebindServer` to swap
   * the underlying http.Server instance after a successful new bind.
   */
  _internalServerRef: { current: http.Server | null };
  _internalWssRef: { current: WebSocketServer | null };
}

export interface StartNetworkServerOptions {
  phoneBundleDir: string;
}

/**
 * Resolve the bind target. `config.bindMode === 'lan'` widens to 0.0.0.0;
 * everything else (including corrupted-but-defensively-defaulted values)
 * binds 127.0.0.1 only.
 */
function resolveBindTarget(config: { bindMode: 'localhost' | 'lan'; port: number }): { host: string; port: number } {
  const host = config.bindMode === 'lan' ? '0.0.0.0' : '127.0.0.1';
  const port = Number.isInteger(config.port) && config.port >= 1 && config.port <= 65535
    ? config.port
    : 7878;
  return { host, port };
}

/**
 * Bind a fresh http.Server + WebSocketServer on (host, port). Used by
 * both `startNetworkServer` (initial bind) and `rebindServer` (toggle).
 * Returns the bare resources; the caller is responsible for error cleanup
 * on bind failure.
 */
async function bindOnce(host: string, port: number, phoneBundleDir: string): Promise<{
  server: http.Server;
  wss: WebSocketServer;
}> {
  const server = http.createServer((req, res) => {
    servePhoneBundle(req, res, phoneBundleDir);
  });
  const wss = new WebSocketServer({ server });
  wss.on('error', () => { /* keep ws server alive on per-connection errors */ });
  wss.on('connection', (ws, req) => {
    void dispatchWsMessage(ws, req);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        if (settled) return;
        settled = true;
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  } catch (err) {
    try { server.close(); } catch { /* ignore */ }
    try { wss.close(); } catch { /* ignore */ }
    throw err;
  }
  return { server, wss };
}

export async function startNetworkServer(opts: StartNetworkServerOptions): Promise<NetworkServerHandle> {
  // Read the persisted config defensively. loadNetworkConfig returns the
  // safe default {port:7878, bindMode:'localhost', updateChannel:'latest'}
  // on missing file / corrupt JSON / shape drift — so a fresh install is
  // localhost-only out of the box.
  const cfg = networkConfig.loadNetworkConfig(userDataDir());
  const { host, port } = resolveBindTarget(cfg);

  const { server, wss } = await bindOnce(host, port, opts.phoneBundleDir);

  // Audit row for the bind event (T-9-04 minimization).
  // `host` carries the bind intent (127.0.0.1 vs 0.0.0.0) but NEVER the
  // bindMode label or any client identifier.
  await appendAuditLine({
    bot: '__system__',
    tool: 'lifecycle',
    params: { event: 'network.bind', host, port },
    outcome: 'ok',
    durationMs: 0,
  });

  // eslint-disable-next-line no-console
  console.info(`[network] bound on ${host}:${port}`);

  const serverRef: { current: http.Server | null } = { current: server };
  const wssRef: { current: WebSocketServer | null } = { current: wss };

  const handle: NetworkServerHandle = {
    host,
    port,
    close: () => new Promise<void>((resolve) => {
      const cur = wssRef.current;
      const srv = serverRef.current;
      wssRef.current = null;
      serverRef.current = null;
      const finish = () => {
        if (srv) {
          srv.close(() => resolve());
        } else {
          resolve();
        }
      };
      if (cur) {
        cur.close(() => finish());
      } else {
        finish();
      }
    }),
    rebind: async (newHost: string, newPort: number) => {
      await rebindServer(handle, newHost, newPort, opts.phoneBundleDir);
    },
    _internalServerRef: serverRef,
    _internalWssRef: wssRef,
  };
  return handle;
}

/**
 * Rebind the listening socket to (newHost, newPort) without dropping the
 * phone's WebSocket connection. The flow is:
 *
 *   1. Open a NEW http.Server + WebSocketServer on (newHost, newPort).
 *   2. If step 1 fails (EADDRINUSE, EACCES, etc.) — keep the OLD server
 *      alive, return the error to the caller. The caller surfaces the
 *      failure in the NetworkSettingsModal inline.
 *   3. ONLY after step 1 succeeds — close the OLD server (which drops
 *      the previous bind). Any in-flight WS connections on the old port
 *      are aborted; this is acceptable because the WS handler is keyed
 *      by msgId (Pitfall 1) and a port-flip implies the client should
 *      reconnect to the new URL anyway.
 *
 * This ordering (open-new-first, close-old-on-success) is the Pitfall 2
 * mitigation: ECONNREFUSED during the swap window is avoided because the
 * NEW server is accepting connections BEFORE the OLD server is closed.
 *
 * On success the handle's `_internalServerRef.current` and
 * `_internalWssRef.current` are swapped atomically so subsequent
 * `close()` and `rebind()` calls operate on the new resources.
 */
export async function rebindServer(
  handle: NetworkServerHandle,
  newHost: string,
  newPort: number,
  phoneBundleDir: string,
): Promise<NetworkServerHandle> {
  const oldServer = handle._internalServerRef.current;
  const oldWss = handle._internalWssRef.current;

  // Step 1: open the NEW server. If this fails, the old server stays
  // untouched.
  const { server: newServer, wss: newWss } = await bindOnce(newHost, newPort, phoneBundleDir);

  // Step 2: audit the bind change (T-9-04 minimization: only host/port).
  await appendAuditLine({
    bot: '__system__',
    tool: 'lifecycle',
    params: { event: 'network.bind_change', host: newHost, port: newPort },
    outcome: 'ok',
    durationMs: 0,
  });

  // eslint-disable-next-line no-console
  console.info(`[network] rebound on ${newHost}:${newPort}`);

  // Step 3: swap the refs BEFORE closing the old server so the handle's
  // close() operates on the new resources.
  handle._internalServerRef.current = newServer;
  handle._internalWssRef.current = newWss;
  (handle as { host: string }).host = newHost;
  (handle as { port: number }).port = newPort;

  // Step 4: close the OLD server + ws (fire-and-forget — the phone will
  // reconnect to the new URL on its exponential-backoff loop).
  if (oldWss) {
    try { oldWss.close(); } catch { /* ignore */ }
  }
  if (oldServer) {
    try { oldServer.close(); } catch { /* ignore */ }
  }

  return handle;
}