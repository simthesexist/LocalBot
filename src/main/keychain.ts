// safeStorage-backed key persistence helpers.
// Pure module — no ipcMain registration, no Electron app coupling at import time.
// Lets unit tests exercise encrypt/decrypt against a vi.mock('electron') shim
// without standing up the IPC handler.

import fs from 'node:fs/promises';
import { safeStorage } from 'electron';

export class KeychainError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Encrypt `plaintext` with Electron's safeStorage and write the base64-encoded
 * ciphertext to `path`. Throws `KeychainError('safeStorage_unavailable', ...)`
 * when the OS does not offer an encryption backend.
 */
export async function encryptToFile(path: string, plaintext: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new KeychainError('safeStorage_unavailable', 'safeStorage encryption unavailable on this system');
  }
  const cipher = safeStorage.encryptString(plaintext);
  const cipherB64 = Buffer.from(cipher).toString('base64');
  await fs.writeFile(path, cipherB64, 'utf8');
}

/**
 * Read the base64-encoded ciphertext at `path`, decrypt with safeStorage, and
 * return the original plaintext. Returns null if the file does not exist or
 * safeStorage is unavailable.
 *
 * Throws `KeychainError('invalid_key', ...)` when safeStorage cannot decrypt
 * the payload (corrupted file, wrong OS keychain, etc).
 */
export async function decryptFromFile(path: string): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(path);
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return null;
  }
  const cipherB64 = buf.toString('utf8');
  const cipher = Buffer.from(cipherB64, 'base64');
  try {
    return safeStorage.decryptString(cipher);
  } catch (err: any) {
    throw new KeychainError('invalid_key', err?.message ?? 'safeStorage decryption failed');
  }
}
