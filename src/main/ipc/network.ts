// Phase 9 Plan 1+2+3: network IPC bridge.
//
// Wires NETWORK_GET_CONFIG + NETWORK_SET_CONFIG + NETWORK_GET_REACH_INFO
// + NETWORK_CHECK_FOR_UPDATE + NETWORK_DOWNLOAD_UPDATE + NETWORK_INSTALL_UPDATE
// invoke channels to:
//   - the daemon's matching JSON-RPC methods (network/get_config +
//     network/set_config), via `callBot` in src/main/daemon/spawn.ts
//   - the Wave 2 Tailscale detector (tailscale.detectReach) for
//     NETWORK_GET_REACH_INFO
//   - the Wave 3 electron-updater manual flow (updater.checkNow /
//     downloadNow / installNow) for the three update channels; status
//     changes broadcast via EVENT_UPDATE_STATUS_CHANGED from main/index.ts.
//
// Validation mirrors the daemon's network/set_config shape check: port
// integer [1,65535], bindMode ∈ {localhost,lan},
// updateChannel ∈ {latest,beta,nightly}. The daemon re-validates; this
// check is defense in depth so the renderer sees a clean error instead
// of an opaque daemon-side `invalid_network_config`.
//
// Wave 2 changes:
//   - NETWORK_GET_REACH_INFO now calls tailscale.detectReach() instead of
//     returning the Wave 1 placeholder.
//   - NETWORK_SET_CONFIG on a bindMode/port change invokes
//     rebindNetworkServer from src/main/network/index.ts (which opens
//     the NEW server before closing the OLD — Pitfall 2 mitigation).
//   - On a successful setConfig + rebind, main broadcasts
//     EVENT_NETWORK_CONFIG_UPDATED so the renderer's ReachInfoPill +
//     NetworkSettingsModal can hydrate without a manual refresh.

import { ipcMain, BrowserWindow } from 'electron';
import { CHANNELS } from '../../shared/ipc-channels';
import { callBot } from '../daemon/spawn';
import { appendAuditLine } from '../audit/logger';
import { detectReach } from '../network/tailscale';
import { rebindNetworkServer, phoneBundleDir } from '../network';
import {
  checkNow,
  downloadNow,
  installNow,
} from '../network/updater';
import type {
  NetworkConfig,
  NetworkConfigResult,
  ReachInfo,
} from '../../shared/types';

// Track the last config we bound against so we can decide whether to
// trigger a rebind on the next setConfig. Module-scope is fine — this
// file is a singleton inside main and runs single-threaded.
let lastBoundConfig: NetworkConfig | null = null;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function isNetworkConfig(value: unknown): value is NetworkConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const port = candidate.port;
  if (!Number.isInteger(port)) return false;
  if ((port as number) < 1 || (port as number) > 65535) return false;
  if (candidate.bindMode !== 'localhost' && candidate.bindMode !== 'lan') return false;
  if (
    candidate.updateChannel !== 'latest' &&
    candidate.updateChannel !== 'beta' &&
    candidate.updateChannel !== 'nightly'
  ) return false;
  return true;
}

/**
 * Resolve the bind target for a config. Mirrors `resolveBindTarget` in
 * src/main/network/server.ts — local helper because importing that
 * internal function would create a cycle.
 */
function resolveHost(cfg: NetworkConfig): string {
  return cfg.bindMode === 'lan' ? '0.0.0.0' : '127.0.0.1';
}

export function registerNetworkHandlers(): void {
  ipcMain.handle(CHANNELS.NETWORK_GET_CONFIG, async (): Promise<NetworkConfigResult> => {
    try {
      const result = (await callBot('network/get_config', {})) as {
        ok?: boolean;
        config?: NetworkConfig;
        error?: string;
      };
      // Remember what the daemon has on disk so we can drive rebind
      // decisions in NETWORK_SET_CONFIG without re-reading the file.
      if (result?.ok && result.config) {
        lastBoundConfig = result.config;
      }
      return {
        ok: result?.ok === true,
        config: result?.config,
        error: result?.error,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(
    CHANNELS.NETWORK_SET_CONFIG,
    async (_evt, req: unknown): Promise<NetworkConfigResult> => {
      // Defense in depth: validate the shape here so the renderer sees a
      // clean error instead of an opaque daemon-side `invalid_network_config`.
      if (!isNetworkConfig(req)) {
        return { ok: false, error: 'invalid_network_config' };
      }
      try {
        // Forward only the canonical shape (no extra fields).
        const args: Record<string, unknown> = {
          port: req.port,
          bindMode: req.bindMode,
          updateChannel: req.updateChannel,
        };
        const result = (await callBot('network/set_config', args)) as {
          ok?: boolean;
          config?: NetworkConfig;
          error?: string;
        };
        if (!result?.ok || !result.config) {
          return {
            ok: false,
            config: result?.config,
            error: result?.error ?? 'failed to save network config',
          };
        }

        await appendAuditLine({
          bot: '__system__',
          tool: 'lifecycle',
          params: {
            event: 'network.config_updated',
            bindMode: result.config.bindMode,
            updateChannel: result.config.updateChannel,
          },
          outcome: 'ok',
          durationMs: 0,
        });

        // Wave 2: rebind whenever bindMode OR port changes. Holding the
        // existing bind when only the updateChannel flips is intentional
        // (channel selection does not affect the listening socket).
        const needsRebind =
          !lastBoundConfig ||
          lastBoundConfig.bindMode !== result.config.bindMode ||
          lastBoundConfig.port !== result.config.port;

        if (needsRebind) {
          const newHost = resolveHost(result.config);
          const newPort = result.config.port;
          const rebindResult = await rebindNetworkServer(newHost, newPort);
          if (!rebindResult.ok) {
            return {
              ok: false,
              config: result.config,
              error: `rebind_failed:${rebindResult.error ?? 'unknown'}`,
            };
          }
          lastBoundConfig = result.config;
        }

        // Broadcast so the renderer's NetworkSettingsModal + ReachInfoPill
        // can rehydrate from the new config without polling getConfig.
        broadcast(CHANNELS.EVENT_NETWORK_CONFIG_UPDATED, { config: result.config });

        return {
          ok: true,
          config: result.config,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(CHANNELS.NETWORK_GET_REACH_INFO, async (): Promise<ReachInfo> => {
    try {
      const info = await detectReach();
      return info;
    } catch (err) {
      return { tailscale: false, lanIps: [], error: (err as Error).message };
    }
  });

  // Phase 9 Plan 3: electron-updater manual check/drain/install channels.
  // Status changes broadcast via EVENT_UPDATE_STATUS_CHANGED from main/index.ts
  // (initUpdater's onChange callback); these handlers just proxy to
  // electron-updater and return ok to the renderer.
  ipcMain.handle(CHANNELS.NETWORK_CHECK_FOR_UPDATE, async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      await checkNow();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(CHANNELS.NETWORK_DOWNLOAD_UPDATE, async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      await downloadNow();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(CHANNELS.NETWORK_INSTALL_UPDATE, async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      installNow();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}

// re-export `phoneBundleDir` so callers that need to recompute the bundle
// path on rebind don't have to re-import from src/main/paths.
export { phoneBundleDir };