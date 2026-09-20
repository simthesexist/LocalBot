// Unit tests for daemon/network/config.cjs — network control-plane config.
//
// Phase 9 Plan 1: covers atomic tmp+rename + corrupt JSON fallback + shape
// validation + persistQueue concurrent serialization. Mirrors the
// vault_config.test.ts structure (mkdtemp workspace + createRequire +
// CJS module loading) so the existing tooling handles it natively.
//
// The defensive-default invariant is the security baseline for NET-03 v1:
// every defensive-fallback path MUST return
// `{port:7878, bindMode:'localhost', updateChannel:'latest'}` and MUST
// NEVER widen the bind to `lan` (0.0.0.0) by accident.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const networkConfig = require_('../../daemon/network/config.cjs') as {
  loadNetworkConfig: (userDataDir: string) => {
    port: number;
    bindMode: 'localhost' | 'lan';
    updateChannel: 'latest' | 'beta' | 'nightly';
  };
  saveNetworkConfig: (
    userDataDir: string,
    cfg: {
      port: number;
      bindMode: 'localhost' | 'lan';
      updateChannel: 'latest' | 'beta' | 'nightly';
    },
  ) => Promise<{
    port: number;
    bindMode: 'localhost' | 'lan';
    updateChannel: 'latest' | 'beta' | 'nightly';
  }>;
  networkConfigPath: (userDataDir: string) => string;
  defaultNetworkConfig: () => {
    port: number;
    bindMode: 'localhost' | 'lan';
    updateChannel: 'latest' | 'beta' | 'nightly';
  };
};

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-net-cfg-'));
}

let userDataDir: string;
beforeEach(() => {
  userDataDir = mkTmp();
});
afterEach(() => {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('network.config — networkConfigPath', () => {
  it('returns <userData>/network.json', () => {
    expect(networkConfig.networkConfigPath(userDataDir)).toBe(
      path.join(userDataDir, 'network.json'),
    );
  });
});

describe('network.config — defaultNetworkConfig', () => {
  it('returns the defensive default shape (port=7878, localhost, latest)', () => {
    expect(networkConfig.defaultNetworkConfig()).toEqual({
      port: 7878,
      bindMode: 'localhost',
      updateChannel: 'latest',
    });
  });
});

describe('network.config — loadNetworkConfig', () => {
  it('returns the defensive default when the file is missing (ENOENT)', () => {
    const cfg = networkConfig.loadNetworkConfig(userDataDir);
    expect(cfg).toEqual({ port: 7878, bindMode: 'localhost', updateChannel: 'latest' });
  });

  it('falls back to the defensive default when JSON is corrupt', () => {
    fs.writeFileSync(path.join(userDataDir, 'network.json'), '{not-json oops', 'utf8');
    const cfg = networkConfig.loadNetworkConfig(userDataDir);
    expect(cfg).toEqual({ port: 7878, bindMode: 'localhost', updateChannel: 'latest' });
  });

  it('falls back when port is not an integer (shape drift)', () => {
    fs.writeFileSync(
      path.join(userDataDir, 'network.json'),
      JSON.stringify({ port: '7878', bindMode: 'localhost', updateChannel: 'latest' }),
      'utf8',
    );
    const cfg = networkConfig.loadNetworkConfig(userDataDir);
    expect(cfg).toEqual({ port: 7878, bindMode: 'localhost', updateChannel: 'latest' });
  });

  it('falls back when bindMode is invalid (shape drift)', () => {
    fs.writeFileSync(
      path.join(userDataDir, 'network.json'),
      JSON.stringify({ port: 7878, bindMode: 'public', updateChannel: 'latest' }),
      'utf8',
    );
    // Most critical invariant: invalid bindMode MUST NOT come back as 'lan'.
    const cfg = networkConfig.loadNetworkConfig(userDataDir);
    expect(cfg.bindMode).toBe('localhost');
  });

  it('falls back when updateChannel is invalid (shape drift)', () => {
    fs.writeFileSync(
      path.join(userDataDir, 'network.json'),
      JSON.stringify({ port: 7878, bindMode: 'localhost', updateChannel: 'release-candidate' }),
      'utf8',
    );
    const cfg = networkConfig.loadNetworkConfig(userDataDir);
    expect(cfg.updateChannel).toBe('latest');
  });

  it('falls back when port is out of range (<1 or >65535)', () => {
    fs.writeFileSync(
      path.join(userDataDir, 'network.json'),
      JSON.stringify({ port: 99999, bindMode: 'localhost', updateChannel: 'latest' }),
      'utf8',
    );
    const cfg = networkConfig.loadNetworkConfig(userDataDir);
    expect(cfg.port).toBe(7878);
  });

  it('reads back a valid shape exactly as written', () => {
    const written = { port: 9999, bindMode: 'lan', updateChannel: 'beta' };
    fs.writeFileSync(path.join(userDataDir, 'network.json'), JSON.stringify(written), 'utf8');
    const cfg = networkConfig.loadNetworkConfig(userDataDir);
    expect(cfg).toEqual(written);
  });
});

describe('network.config — saveNetworkConfig', () => {
  it('round-trips a valid config (write then load returns the same shape)', async () => {
    const cfg = { port: 9999, bindMode: 'lan', updateChannel: 'beta' };
    const written = await networkConfig.saveNetworkConfig(userDataDir, cfg);
    expect(written).toEqual(cfg);
    const reread = networkConfig.loadNetworkConfig(userDataDir);
    expect(reread).toEqual(cfg);
  });

  it('rejects a non-integer port with code:invalid_network_config', async () => {
    await expect(
      networkConfig.saveNetworkConfig(userDataDir, {
        port: '7878' as unknown as number,
        bindMode: 'localhost',
        updateChannel: 'latest',
      }),
    ).rejects.toMatchObject({ code: 'invalid_network_config' });
    expect(fs.existsSync(path.join(userDataDir, 'network.json'))).toBe(false);
  });

  it('rejects a port outside [1,65535] with code:invalid_network_config', async () => {
    await expect(
      networkConfig.saveNetworkConfig(userDataDir, {
        port: 70000,
        bindMode: 'localhost',
        updateChannel: 'latest',
      }),
    ).rejects.toMatchObject({ code: 'invalid_network_config' });
    expect(fs.existsSync(path.join(userDataDir, 'network.json'))).toBe(false);
  });

  it('rejects an invalid bindMode with code:invalid_network_config', async () => {
    await expect(
      networkConfig.saveNetworkConfig(userDataDir, {
        port: 7878,
        bindMode: 'public' as unknown as 'lan',
        updateChannel: 'latest',
      }),
    ).rejects.toMatchObject({ code: 'invalid_network_config' });
    expect(fs.existsSync(path.join(userDataDir, 'network.json'))).toBe(false);
  });

  it('rejects an invalid updateChannel with code:invalid_network_config', async () => {
    await expect(
      networkConfig.saveNetworkConfig(userDataDir, {
        port: 7878,
        bindMode: 'localhost',
        updateChannel: 'release-candidate' as unknown as 'beta',
      }),
    ).rejects.toMatchObject({ code: 'invalid_network_config' });
    expect(fs.existsSync(path.join(userDataDir, 'network.json'))).toBe(false);
  });

  it('concurrent saves (5 in parallel) all resolve and final file is one of the writers', async () => {
    const saves = [
      networkConfig.saveNetworkConfig(userDataDir, { port: 1001, bindMode: 'localhost', updateChannel: 'latest' }),
      networkConfig.saveNetworkConfig(userDataDir, { port: 1002, bindMode: 'localhost', updateChannel: 'latest' }),
      networkConfig.saveNetworkConfig(userDataDir, { port: 1003, bindMode: 'localhost', updateChannel: 'latest' }),
      networkConfig.saveNetworkConfig(userDataDir, { port: 1004, bindMode: 'localhost', updateChannel: 'latest' }),
      networkConfig.saveNetworkConfig(userDataDir, { port: 1005, bindMode: 'localhost', updateChannel: 'latest' }),
    ];
    await Promise.all(saves);
    const final = networkConfig.loadNetworkConfig(userDataDir);
    expect([1001, 1002, 1003, 1004, 1005]).toContain(final.port);
  });

  it('rejection on bad shape does not poison subsequent saves in the persistQueue chain', async () => {
    // First save has invalid bindMode; second is valid. Bad rejects, good
    // resolves; chain stays alive.
    const bad = networkConfig.saveNetworkConfig(userDataDir, {
      port: 7878,
      bindMode: 'public' as unknown as 'lan',
      updateChannel: 'latest',
    });
    const good = networkConfig.saveNetworkConfig(userDataDir, {
      port: 7878,
      bindMode: 'lan',
      updateChannel: 'beta',
    });
    await expect(bad).rejects.toMatchObject({ code: 'invalid_network_config' });
    await expect(good).resolves.toMatchObject({
      port: 7878,
      bindMode: 'lan',
      updateChannel: 'beta',
    });
    const final = networkConfig.loadNetworkConfig(userDataDir);
    expect(final).toEqual({ port: 7878, bindMode: 'lan', updateChannel: 'beta' });
  });

  it('atomic write leaves no partial file: read after write is valid JSON', async () => {
    await networkConfig.saveNetworkConfig(userDataDir, {
      port: 7777,
      bindMode: 'localhost',
      updateChannel: 'latest',
    });
    const text = fs.readFileSync(path.join(userDataDir, 'network.json'), 'utf8');
    expect(() => JSON.parse(text)).not.toThrow();
    const parsed = JSON.parse(text);
    expect(parsed.port).toBe(7777);
  });
});
