// Unit tests for src/main/keychain.ts — encryptToFile / decryptFromFile round-trip.
// Run with: `npm test`
//
// vi.mock('electron') shim exercises encrypt/decrypt logic against a fake
// safeStorage that prepends 'enc:' / strips it on decrypt. Runs in pure-Node
// under vitest, no Electron runtime needed.
//
// Layer 2 (real OS keychain) lives in `safeStorage.real.test.ts` and only runs
// when ELECTRON_REAL_SAFESTORAGE=1 is set; vitest is launched under electron
// in that mode so `require('electron')` resolves to the real Electron module.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// vi.mock is hoisted by Vitest's transformer above all imports. The factory
// must NOT reference any outer-scope variables.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (b: Buffer) => {
      const text = b.toString('utf8');
      if (!text.startsWith('enc:')) {
        const err = new Error('bad magic bytes');
        (err as any).code = 'ERR_INVALID_KEY';
        throw err;
      }
      return Buffer.from(text.slice(4), 'utf8').toString();
    },
  },
}));

// eslint-disable-next-line import/first
import { encryptToFile, decryptFromFile, KeychainError } from '../../src/main/keychain';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-keychain-'));
});

afterEach(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('safeStorage (mocked electron.safeStorage)', () => {
  it('round-trips a typical API key through encryptToFile + decryptFromFile', async () => {
    const file = path.join(tempDir, 'api-key.bin');
    const key = 'sk-test-1234567890abcdef';
    await encryptToFile(file, key);
    const out = await decryptFromFile(file);
    expect(out).toBe(key);
  });

  it('handles empty-string round-trip', async () => {
    const file = path.join(tempDir, 'api-key.bin');
    await encryptToFile(file, '');
    expect(await decryptFromFile(file)).toBe('');
  });

  it('decryptFromFile returns null for a missing file', async () => {
    const file = path.join(tempDir, 'does-not-exist.bin');
    expect(await decryptFromFile(file)).toBeNull();
  });

  it('rejects wrong-magic ciphertext by throwing on decrypt', async () => {
    const file = path.join(tempDir, 'bad.bin');
    fs.writeFileSync(file, 'not-enc:hello', 'utf8');
    await expect(decryptFromFile(file)).rejects.toBeInstanceOf(KeychainError);
  });

  it('ciphertext on disk does not contain the plaintext', async () => {
    const file = path.join(tempDir, 'api-key.bin');
    const secret = 'sk-very-secret-DO-NOT-LEAK';
    await encryptToFile(file, secret);
    const onDisk = fs.readFileSync(file, 'utf8');
    expect(onDisk.includes(secret)).toBe(false);
    expect(await decryptFromFile(file)).toBe(secret);
  });

  it('multiple encrypt → decrypt cycles against the same path are stable', async () => {
    const file = path.join(tempDir, 'api-key.bin');
    await encryptToFile(file, 'first');
    expect(await decryptFromFile(file)).toBe('first');
    await encryptToFile(file, 'second');
    expect(await decryptFromFile(file)).toBe('second');
    await encryptToFile(file, 'third');
    expect(await decryptFromFile(file)).toBe('third');
  });
});
