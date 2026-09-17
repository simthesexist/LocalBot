// safeStorage-backed key persistence.

import { ipcMain, safeStorage, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { CHANNELS } from '../../shared/ipc-channels';
import { keyFilePath } from '../paths';
import { classifyError } from '../errors';
import type { KeyClearResult, KeyGetResult, KeyProbeResult, KeySetResult } from '../../shared/types';

export async function hasStoredKey(): Promise<boolean> {
  return existsSync(keyFilePath());
}

async function readDecryptedKey(): Promise<string | null> {
  if (!existsSync(keyFilePath())) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  const buf = await fs.readFile(keyFilePath());
  const cipherB64 = buf.toString('utf8');
  const cipher = Buffer.from(cipherB64, 'base64');
  return safeStorage.decryptString(cipher);
}

export async function clearStoredKey(): Promise<void> {
  if (existsSync(keyFilePath())) {
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
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'safeStorage encryption unavailable on this system' };
    }
    const cipher = safeStorage.encryptString(payload.key);
    const cipherB64 = Buffer.from(cipher).toString('base64');
    await fs.writeFile(keyFilePath(), cipherB64, 'utf8');
    return { ok: true };
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

export { readDecryptedKey };
