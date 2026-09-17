// Optional Layer 2: real Electron safeStorage round-trip.
//
// This test only runs when ELECTRON_REAL_SAFESTORAGE=1 is set in the env AND
// vitest is launched under `electron` so the `electron` module resolves to the
// real Electron entry point (DPAPI / Keychain / libsecret under the hood).
//
//   ELECTRON_REAL_SAFESTORAGE=1 ./node_modules/.bin/electron \
//     node_modules/vitest/vitest.mjs run tests/unit/safeStorage.real.test.ts
//
// Requires a desktop session on Windows.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const describeIf = process.env.ELECTRON_REAL_SAFESTORAGE ? describe : describe.skip;

describeIf('safeStorage (real electron runtime)', () => {
  it('round-trips a string via the real OS keychain', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron');
    if (!electron.safeStorage?.isEncryptionAvailable()) {
      throw new Error('safeStorage not available on this OS session');
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { encryptToFile, decryptFromFile } = require('../../src/main/keychain');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-keychain-real-'));
    try {
      const file = path.join(tempDir, 'api-key-real.bin');
      const secret = 'sk-real-electron-safeStorage-test';
      await encryptToFile(file, secret);
      expect(await decryptFromFile(file)).toBe(secret);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
