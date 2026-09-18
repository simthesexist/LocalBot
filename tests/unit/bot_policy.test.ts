// Unit tests for daemon/bots/policy.cjs — per-bot allowlist loader that
// replaces Phase 3's hardcoded DEFAULT_POLICY.
//
// Phase 4 Wave 1: Wave 0 tests required by 04-VALIDATION.md to prove
// T-P4-02 (unknown_bot on bad id) + T-P4-03 (no caching across calls).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const policy = require_('../../daemon/bots/policy.cjs') as {
  getPolicy: (botId: string, ctx: { userDataDir?: string }) => { allowlist: Set<string>; denylist: Set<string> };
  makePolicyFromConfig: (cfg: { allowlist?: unknown }) => { allowlist: Set<string>; denylist: Set<string> };
};
const defaultPolicy = require_('../../daemon/bots/default.cjs') as {
  DEFAULT_POLICY: { allowlist: Set<string>; denylist: Set<string> };
};
const loader = require_('../../daemon/bots/loader.cjs') as {
  writeConfig: (userDataDir: string, bot: string, cfg: Record<string, unknown>) => unknown;
  writeConfigPatch: (userDataDir: string, bot: string, patch: Record<string, unknown>) => unknown;
};

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-bot-policy-'));
}

describe('getPolicy for a bot with a config.json', () => {
  it('reads the allowlist from config.json#allowlist', () => {
    const dir = mkTmp();
    try {
      loader.writeConfig(dir, 'policy-bot', {
        id: 'policy-bot',
        name: 'Policy Bot',
        schemaVersion: 1,
        allowlist: ['read_file'],
      });
      const out = policy.getPolicy('policy-bot', { userDataDir: dir });
      expect(out.allowlist).toBeInstanceOf(Set);
      expect(out.allowlist.has('read_file')).toBe(true);
      expect(out.allowlist.has('write_file')).toBe(false);
      expect(out.denylist.size).toBe(0);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('returns a fresh policy on every call (no caching across updates)', () => {
    const dir = mkTmp();
    try {
      loader.writeConfig(dir, 'no-cache', {
        id: 'no-cache',
        name: 'No Cache',
        schemaVersion: 1,
        allowlist: ['read_file'],
      });
      const before = policy.getPolicy('no-cache', { userDataDir: dir });
      expect(before.allowlist.has('read_file')).toBe(true);

      // Update the bot's allowlist by re-writing config.json.
      loader.writeConfig(dir, 'no-cache', {
        id: 'no-cache',
        name: 'No Cache',
        schemaVersion: 1,
        allowlist: ['write_file'],
      });
      const after = policy.getPolicy('no-cache', { userDataDir: dir });
      // T-P4-03 / Pitfall 1: a freshly-read policy must reflect the update.
      expect(after.allowlist.has('read_file')).toBe(false);
      expect(after.allowlist.has('write_file')).toBe(true);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('getPolicy for the implicit `default` bot', () => {
  it('falls back to DEFAULT_POLICY when no config.json exists', () => {
    const dir = mkTmp();
    try {
      const out = policy.getPolicy('default', { userDataDir: dir });
      expect(out.allowlist).toEqual(defaultPolicy.DEFAULT_POLICY.allowlist);
      expect(out.denylist).toEqual(defaultPolicy.DEFAULT_POLICY.denylist);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('returns the config allowlist when the default bot HAS a config.json', () => {
    const dir = mkTmp();
    try {
      loader.writeConfig(dir, 'default', {
        id: 'default',
        name: 'Default bot',
        schemaVersion: 1,
        allowlist: ['read_file'], // narrow set; overrides the broad DEFAULT_POLICY
      });
      const out = policy.getPolicy('default', { userDataDir: dir });
      expect(out.allowlist.has('read_file')).toBe(true);
      expect(out.allowlist.has('write_file')).toBe(false);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('getPolicy for unknown bots', () => {
  it('throws unknown_bot when the bot has no config.json', () => {
    const dir = mkTmp();
    try {
      expect(() => policy.getPolicy('does-not-exist', { userDataDir: dir })).toThrowError(
        expect.objectContaining({ code: 'unknown_bot' }),
      );
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('throws daemon_not_initialized when ctx.userDataDir is missing', () => {
    expect(() => policy.getPolicy('anything', {})).toThrowError(
      expect.objectContaining({ code: 'daemon_not_initialized' }),
    );
  });

  it('returns DEFAULT_POLICY for _system regardless of config', () => {
    const dir = mkTmp();
    try {
      const out = policy.getPolicy('_system', { userDataDir: dir });
      expect(out.allowlist).toEqual(defaultPolicy.DEFAULT_POLICY.allowlist);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('makePolicyFromConfig', () => {
  it('returns an empty allowlist Set when allowlist is missing or non-array', () => {
    const out = policy.makePolicyFromConfig({});
    expect(out.allowlist).toBeInstanceOf(Set);
    expect(out.allowlist.size).toBe(0);
  });

  it('returns the allowlist as a Set when provided as an array', () => {
    const out = policy.makePolicyFromConfig({ allowlist: ['a', 'b', 'c'] });
    expect(out.allowlist.has('a')).toBe(true);
    expect(out.allowlist.has('b')).toBe(true);
    expect(out.allowlist.has('c')).toBe(true);
    expect(out.allowlist.size).toBe(3);
  });
});

describe('getPolicy reflects bots/update allowlist changes immediately (Pitfall 1)', () => {
  it('reads the UPDATED config after bots/update reloads the allowlist', () => {
    const dir = mkTmp();
    try {
      loader.writeConfig(dir, 'reload-bot', {
        id: 'reload-bot',
        name: 'Reload Bot',
        schemaVersion: 1,
        allowlist: ['read_file'],
      });
      const before = policy.getPolicy('reload-bot', { userDataDir: dir });
      expect(before.allowlist.has('read_file')).toBe(true);
      expect(before.allowlist.has('write_file')).toBe(false);

      // Simulate bots/update via writeConfigPatch.
      loader.writeConfigPatch(dir, 'reload-bot', { allowlist: ['read_file', 'write_file'] });

      const after = policy.getPolicy('reload-bot', { userDataDir: dir });
      // T-P4-18 / Pitfall 1: a freshly-read policy must reflect the update.
      expect(after.allowlist.has('read_file')).toBe(true);
      expect(after.allowlist.has('write_file')).toBe(true);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('removes a tool from the allowlist after bots/update narrows it', () => {
    const dir = mkTmp();
    try {
      loader.writeConfig(dir, 'narrow-bot', {
        id: 'narrow-bot',
        name: 'Narrow Bot',
        schemaVersion: 1,
        allowlist: ['read_file', 'write_file'],
      });
      const before = policy.getPolicy('narrow-bot', { userDataDir: dir });
      expect(before.allowlist.has('write_file')).toBe(true);

      loader.writeConfigPatch(dir, 'narrow-bot', { allowlist: ['read_file'] });

      const after = policy.getPolicy('narrow-bot', { userDataDir: dir });
      expect(after.allowlist.has('write_file')).toBe(false);
      expect(after.allowlist.has('read_file')).toBe(true);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
