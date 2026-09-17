// safeStorage-backed key persistence — IPC handlers + small probe helper.
// The encrypt/decrypt primitives live in `../keychain` so unit tests can
// import them without instantiating ipcMain.

import { ipcMain, BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { CHANNELS } from '../../shared/ipc-channels';
import { keyFilePath } from '../paths';
import { encryptToFile, decryptFromFile, KeychainError } from '../keychain';
import { classifyError } from '../errors';
import type { KeyClearResult, KeyGetResult, KeyProbeResult, KeySetResult } from '../../shared/types';

export async function hasStoredKey(): Promise<boolean> {
  return existsSync(keyFilePath());
}

export async function readDecryptedKey(): Promise<string | null> {
  return decryptFromFile(keyFilePath());
}

export async function clearStoredKey(): Promise<void> {
  if (existsSync(keyFilePath())) {
    const fs = await import('node:fs/promises');
    await fs.unlink(keyFilePath());
  }
}

async function probeKey(rawKey: string): Promise<KeyProbeResult> {
  try {
    const client = new Anthropic({
      apiKey: rawKey,
      baseURL: process.env.M3_API_BASE || 'https://api.MiniMax.io/v1',
    });
    await client.messages.create({
      model: process.env.M3_MODEL || 'MiniMax/M3',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { ok: true };
  } catch (err) {
    const classified = classifyError(err);
    return { ok: false, error: classified.message, category: classified.category };
  }
}

export function registerKeyHandlers(): void {
  ipcMain.handle(CHANNELS.KEY_GET, async (): Promise<KeyGetResult> => {
    return { hasKey: await hasStoredKey() };
  });

  ipcMain.handle(CHANNELS.KEY_SET, async (_evt, payload: { key: string }): Promise<KeySetResult> => {
    if (!payload?.key || typeof payload.key !== 'string') {
      return { ok: false, error: 'missing key' };
    }
    try {
      await encryptToFile(keyFilePath(), payload.key);
      return { ok: true };
    } catch (err) {
      if (err instanceof KeychainError) {
        return { ok: false, error: err.message };
      }
      return { ok: false, error: (err as Error).message ?? 'unknown error' };
    }
  });

  ipcMain.handle(CHANNELS.KEY_PROBE, async (_evt, payload: { key: string }): Promise<KeyProbeResult> => {
    return probeKey(payload?.key ?? '');
  });

  ipcMain.handle(CHANNELS.KEY_CLEAR, async (): Promise<KeyClearResult> => {
    await clearStoredKey();
    // Tell every window to re-show the modal.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('app:init', { hasKey: false });
    }
    return { ok: true };
  });
}
