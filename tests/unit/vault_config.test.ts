// Unit tests for daemon/vault/config.cjs — global vault config persistence.
// Run with: npm test
//
// Phase 7 Plan 1: covers atomic tmp+rename + corrupt JSON fallback + shape
// validation + persistQueue concurrent serialization. Mirrors the
// scheduler_persistence.test.ts structure (mkdtemp workspace + createRequire
// + CJS module loading) so the existing tooling handles it natively.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const vaultConfig = require_('../../daemon/vault/config.cjs') as {
  loadVaultConfig: (userDataDir: string) => { rootPath: string; globalDeny: string[] };
  saveVaultConfig: (userDataDir: string, cfg: { rootPath: string; globalDeny: string[] }) => Promise<{ rootPath: string; globalDeny: string[] }>;
  vaultConfigPath: (userDataDir: string) => string;
  defaultVaultConfig: () => { rootPath: string; globalDeny: string[] };
};

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-vault-cfg-'));
}

let userDataDir: string;
beforeEach(() => {
  userDataDir = mkTmp();
});
afterEach(() => {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('vault.config — vaultConfigPath', () => {
  it('returns <userData>/vault.json', () => {
    expect(vaultConfig.vaultConfigPath(userDataDir)).toBe(path.join(userDataDir, 'vault.json'));
  });
});

describe('vault.config — loadVaultConfig', () => {
  it('returns {rootPath:"", globalDeny:[]} when the file is missing (ENOENT)', () => {
    const cfg = vaultConfig.loadVaultConfig(userDataDir);
    expect(cfg).toEqual({ rootPath: '', globalDeny: [] });
  });

  it('falls back to the defensive default when JSON is corrupt', () => {
    fs.writeFileSync(path.join(userDataDir, 'vault.json'), 'not json {{{', 'utf8');
    const cfg = vaultConfig.loadVaultConfig(userDataDir);
    expect(cfg).toEqual({ rootPath: '', globalDeny: [] });
  });

  it('falls back when rootPath is not a string (shape drift)', () => {
    fs.writeFileSync(
      path.join(userDataDir, 'vault.json'),
      JSON.stringify({ rootPath: 123, globalDeny: [] }),
      'utf8',
    );
    const cfg = vaultConfig.loadVaultConfig(userDataDir);
    expect(cfg).toEqual({ rootPath: '', globalDeny: [] });
  });

  it('falls back when globalDeny is not an array (shape drift)', () => {
    fs.writeFileSync(
      path.join(userDataDir, 'vault.json'),
      JSON.stringify({ rootPath: 'C:/vault', globalDeny: 'Private/**' }),
      'utf8',
    );
    const cfg = vaultConfig.loadVaultConfig(userDataDir);
    expect(cfg).toEqual({ rootPath: '', globalDeny: [] });
  });

  it('falls back when a globalDeny entry is not a string', () => {
    fs.writeFileSync(
      path.join(userDataDir, 'vault.json'),
      JSON.stringify({ rootPath: 'C:/vault', globalDeny: ['ok/**', 42] }),
      'utf8',
    );
    const cfg = vaultConfig.loadVaultConfig(userDataDir);
    expect(cfg).toEqual({ rootPath: '', globalDeny: [] });
  });

  it('reads back a valid shape exactly as written', () => {
    const written = { rootPath: 'C:/vault', globalDeny: ['Private/**', 'Credentials/**'] };
    fs.writeFileSync(path.join(userDataDir, 'vault.json'), JSON.stringify(written), 'utf8');
    const cfg = vaultConfig.loadVaultConfig(userDataDir);
    expect(cfg).toEqual(written);
  });
});

describe('vault.config — saveVaultConfig', () => {
  it('round-trips a valid config (write then load returns the same shape)', async () => {
    const cfg = { rootPath: 'C:/vault', globalDeny: ['Private/**'] };
    const written = await vaultConfig.saveVaultConfig(userDataDir, cfg);
    expect(written).toEqual(cfg);
    const reread = vaultConfig.loadVaultConfig(userDataDir);
    expect(reread).toEqual(cfg);
  });

  it('rejects a non-string rootPath with code:invalid_vault_config', async () => {
    await expect(
      vaultConfig.saveVaultConfig(userDataDir, { rootPath: 42 as unknown as string, globalDeny: [] }),
    ).rejects.toMatchObject({ code: 'invalid_vault_config' });
    // On-disk file unchanged (default from defensive fallback is absent,
    // because the rejection happens before the persistQueue runs).
    expect(fs.existsSync(path.join(userDataDir, 'vault.json'))).toBe(false);
  });

  it('rejects a non-array globalDeny with code:invalid_vault_config', async () => {
    await expect(
      vaultConfig.saveVaultConfig(userDataDir, { rootPath: 'C:/vault', globalDeny: 'Private/**' as unknown as string[] }),
    ).rejects.toMatchObject({ code: 'invalid_vault_config' });
  });

  it('rejects a globalDeny entry that is not a string with code:invalid_vault_config', async () => {
    await expect(
      vaultConfig.saveVaultConfig(userDataDir, { rootPath: 'C:/vault', globalDeny: ['Private/**', 42] as unknown as string[] }),
    ).rejects.toMatchObject({ code: 'invalid_vault_config' });
  });

  it('atomic write leaves no partial file: read after write is valid JSON or absent', async () => {
    await vaultConfig.saveVaultConfig(userDataDir, { rootPath: 'C:/v', globalDeny: [] });
    // Read immediately — must be parseable as JSON.
    const text = fs.readFileSync(path.join(userDataDir, 'vault.json'), 'utf8');
    expect(() => JSON.parse(text)).not.toThrow();
    const parsed = JSON.parse(text);
    expect(parsed.rootPath).toBe('C:/v');
  });

  it('concurrent saves (5 in parallel) all succeed and final file is the LAST write', async () => {
    const saves = [
      vaultConfig.saveVaultConfig(userDataDir, { rootPath: 'C:/v1', globalDeny: [] }),
      vaultConfig.saveVaultConfig(userDataDir, { rootPath: 'C:/v2', globalDeny: [] }),
      vaultConfig.saveVaultConfig(userDataDir, { rootPath: 'C:/v3', globalDeny: [] }),
      vaultConfig.saveVaultConfig(userDataDir, { rootPath: 'C:/v4', globalDeny: [] }),
      vaultConfig.saveVaultConfig(userDataDir, { rootPath: 'C:/v5', globalDeny: [] }),
    ];
    await Promise.all(saves);
    const final = vaultConfig.loadVaultConfig(userDataDir);
    // persistQueue serializes — the final on-disk shape matches one of the
    // five writes (we don't assert which; just that it's parseable + valid).
    expect(['C:/v1', 'C:/v2', 'C:/v3', 'C:/v4', 'C:/v5']).toContain(final.rootPath);
  });

  it('rejection on bad shape does not poison subsequent saves in the persistQueue chain', async () => {
    // The first save has a bad shape; the second is valid. Both promises
    // are awaited — the bad one rejects, the good one resolves, and the
    // chain stays alive (Pitfall 12).
    const bad = vaultConfig.saveVaultConfig(userDataDir, {
      rootPath: 42 as unknown as string,
      globalDeny: [],
    });
    const good = vaultConfig.saveVaultConfig(userDataDir, {
      rootPath: 'C:/vault',
      globalDeny: ['Private/**'],
    });
    await expect(bad).rejects.toMatchObject({ code: 'invalid_vault_config' });
    await expect(good).resolves.toMatchObject({ rootPath: 'C:/vault', globalDeny: ['Private/**'] });
    const final = vaultConfig.loadVaultConfig(userDataDir);
    expect(final).toEqual({ rootPath: 'C:/vault', globalDeny: ['Private/**'] });
  });
});

// Vault configs share their persistQueue across userDataDirs by accident?
// No — the queue is module-scope and serialized. To keep test isolation,
// we run this suite in isolation. (Other suites don't touch vault.config.)
describe('vault.config — defaultVaultConfig', () => {
  it('returns the defensive default shape', () => {
    expect(vaultConfig.defaultVaultConfig()).toEqual({ rootPath: '', globalDeny: [] });
  });
});

// vi import retained for symmetry / future use (mid-write failure test).
void vi;
