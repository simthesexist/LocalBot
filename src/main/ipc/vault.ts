// Phase 7 Plan 1: Obsidian vault config IPC bridge.
//
// Wires VAULT_GET_CONFIG + VAULT_SET_CONFIG invoke channels to the
// daemon's matching JSON-RPC methods. On a successful set_config, main
// broadcasts EVENT_VAULT_CONFIG_UPDATED to every window so renderer
// subscribers (state/vault.ts in Plan 07-02) can refresh without polling.
//
// Validation mirrors the daemon's vault/set_config shape check: rootPath
// must be a string, globalDeny must be a string[]. This is defense in
// depth — the daemon re-validates — but keeping the surface consistent
// means the renderer gets a useful error instead of an opaque JSON-RPC
// code.

import { ipcMain, BrowserWindow } from 'electron';
import { CHANNELS } from '../../shared/ipc-channels';
import { callBot } from '../daemon/spawn';
import type { VaultConfigResult, VaultGlobalConfig } from '../../shared/types';

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function isVaultGlobalConfig(value: unknown): value is VaultGlobalConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.rootPath !== 'string') return false;
  if (!Array.isArray(candidate.globalDeny)) return false;
  for (const g of candidate.globalDeny) {
    if (typeof g !== 'string') return false;
  }
  return true;
}

export function registerVaultHandlers(): void {
  ipcMain.handle(CHANNELS.VAULT_GET_CONFIG, async (): Promise<VaultConfigResult> => {
    try {
      const result = (await callBot('vault/get_config', {})) as {
        ok?: boolean;
        config?: VaultGlobalConfig;
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
    CHANNELS.VAULT_SET_CONFIG,
    async (_evt, req: unknown): Promise<VaultConfigResult> => {
      // Defense in depth: validate the shape here so the renderer sees a
      // clean error instead of an opaque daemon-side `invalid_vault_config`.
      if (!isVaultGlobalConfig(req)) {
        return { ok: false, error: 'invalid_vault_config' };
      }
      try {
        // Forward only the canonical shape (no extra fields).
        const args: Record<string, unknown> = {
          rootPath: req.rootPath,
          globalDeny: req.globalDeny.slice(),
        };
        const result = (await callBot('vault/set_config', args)) as {
          ok?: boolean;
          config?: VaultGlobalConfig;
          error?: string;
        };
        if (result?.ok && result.config) {
          broadcast(CHANNELS.EVENT_VAULT_CONFIG_UPDATED, { config: result.config });
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
}
