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

// CommonJS require for the daemon-side config.cjs. tsc compiles this file
// to dist/main/network/server.js; the daemon/ tree is recursively copied
// to dist/main/daemon/ at build time (see package.json scripts.build:main),
// so the relative path below resolves correctly in BOTH source-relative
// vitest runs AND the production dist bundle.
const _require = createRequire(__filename);
const networkConfig = _require(path.join(__dirname, '..', '..', 'daemon', 'network', 'config.cjs')) as {
  loadNetworkConfig: (userDataDir: string) => {
    port: number;
    bindMode: 'localhost' | 'lan';
    updateChannel: 'latest' | 'beta' | 'nightly';
  };
};

export interface NetworkServerHandle {
  host: string;
  port: number;
  close: () => Promise<void>;
  /**
   * Wave 2 stub. Wave 1 throws — only bindMode flips to 'lan' via
   * `network/set_config` followed by a full app restart (or Wave 2's
   * rebind path lands). Throwing keeps the API forward-compatible while
   * making a misuse a loud failure.
   */
  rebind: (newHost: string, newPort: number) => Promise<void>;
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

export async function startNetworkServer(opts: StartNetworkServerOptions): Promise<NetworkServerHandle> {
  // Read the persisted config defensively. loadNetworkConfig returns the
  // safe default {port:7878, bindMode:'localhost', updateChannel:'latest'}
  // on missing file / corrupt JSON / shape drift — so a fresh install is
  // localhost-only out of the box.
  const cfg = networkConfig.loadNetworkConfig(userDataDir());
  const { host, port } = resolveBindTarget(cfg);

  // Wrap servePhoneBundle for every non-WS request. The plan's phone bundle
  // dir is `<userData>/phone-bundle`; tests pass `opts.phoneBundleDir`
  // pointing at a temp dir.
  const server = http.createServer((req, res) => {
    servePhoneBundle(req, res, opts.phoneBundleDir);
  });

  // WebSocketServer attached to the same http.Server so ws:// and http://
  // share the port.
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    // Fire-and-forget per ws connection. dispatchWsMessage resolves only
    // when the connection closes; we don't await here so a stuck client
    // can't block WebSocketServer's connection loop.
    void dispatchWsMessage(ws, req);
  });

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

  // Single line on bind for at-a-glance status.
  // eslint-disable-next-line no-console
  console.info(`[network] bound on ${host}:${port}`);

  return {
    host,
    port,
    close: () => new Promise<void>((resolve) => {
      // Close the WS endpoint first so no new upgrades come in while we're
      // shutting down the http server.
      wss.close(() => {
        server.close(() => resolve());
      });
    }),
    rebind: async (_newHost: string, _newPort: number) => {
      throw new Error('rebind not implemented in Wave 1');
    },
  };
}
