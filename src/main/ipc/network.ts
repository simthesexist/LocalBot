// Phase 9 Plan 1: network IPC bridge.
//
// Wires NETWORK_GET_CONFIG + NETWORK_SET_CONFIG + NETWORK_GET_REACH_INFO
// invoke channels to:
//   - the daemon's matching JSON-RPC methods (network/get_config +
//     network/set_config), via `callBot` in src/main/daemon/spawn.ts
//   - a Wave 1 placeholder for REACH info (Wave 2 Tailscale detector fills
//     in `tailscale` + `magicDnsName` + `lanIps`)
//
// Validation mirrors the daemon's network/set_config shape check: port
// integer [1,65535], bindMode ∈ {localhost,lan},
// updateChannel ∈ {latest,beta,nightly}. The daemon re-validates; this
// check is defense in depth so the renderer sees a clean error instead
// of an opaque daemon-side `invalid_network_config`.
//
// No event channels in this wave. The REACH_INFO_UPDATED broadcast is a
// Wave 2 addition — the renderer doesn't subscribe to network state yet.

import { ipcMain, BrowserWindow } from 'electron';
import { CHANNELS } from '../../shared/ipc-channels';
import { callBot } from '../daemon/spawn';
import { appendAuditLine } from '../audit/logger';
import type {
  NetworkConfig,
  NetworkConfigResult,
  ReachInfo,
} from '../../shared/types';

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

export function registerNetworkHandlers(): void {
  ipcMain.handle(CHANNELS.NETWORK_GET_CONFIG, async (): Promise<NetworkConfigResult> => {
    try {
      const result = (await callBot('network/get_config', {})) as {
        ok?: boolean;
        config?: NetworkConfig;
        error?: string;
      };
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
        // Emit a separate audit row for the bind-mode change (T-9-04
        // minimization: NO host/port, ONLY the mode + channel). Wave 2
        // will trigger a server.rebind() here for LAN opt-in.
        if (result?.ok && result.config) {
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
          // Wave 2 will also broadcast EVENT_NETWORK_CONFIG_UPDATED here.
          // Wave 1 keeps the surface minimal — only `getConfig` is needed
          // for the Wave 1 tracer acceptance criteria.
          void broadcast;
        }
        return {
          ok: result?.ok === true,
          config: result?.config,
          error: result?.error,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(CHANNELS.NETWORK_GET_REACH_INFO, async (): Promise<ReachInfo> => {
    // Wave 1 placeholder — Tailscale detection lands in Wave 2 along
    // with ReachInfoPill + NetworkSettingsModal. Today the renderer
    // receives an empty reachable-info envelope so NetworkSettingsModal
    // (Wave 2) can mount without a second IPC surface.
    return { tailscale: false, lanIps: [], error: undefined };
  });
}
