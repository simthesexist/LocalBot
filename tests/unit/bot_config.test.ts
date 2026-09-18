// Unit tests for daemon/bots/loader.cjs — read/write/delete config.json,
// schema validation, atomic tmp+rename. Run with: npm test
//
// Phase 4 Wave 1: tests required by 04-VALIDATION.md Wave 0 to prove
// T-P4-01 (id regex + containment), T-P4-06 (atomic rename), and
// T-P4-07 (schema allowlist) without spinning up Electron.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const loader = require_('../../daemon/bots/loader.cjs') as {
  ALLOWED_CONFIG_KEYS: Set<string>;
  SCHEMA_VERSION: number;
  readConfig: (userDataDir: string, bot: string) => Record<string, unknown> | null;
  writeConfig: (userDataDir: string, bot: string, cfg: Record<string, unknown>) => Record<string, unknown>;
  listAllBots: (userDataDir: string) => Array<Record<string, unknown>>;
  deleteBot: (userDataDir: string, bot: string) => void;
  botExists: (userDataDir: string, bot: string) => boolean;
  deriveSlug: (name: string) => string;
  __test__: {
    validateConfig: (cfg: Record<string, unknown>) => void;
    safePathSync: (botDir: string, requested: string) => string;
    synthesizeDefaultBot: () => Record<string, unknown>;
  };
};

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-bot-cfg-'));
}

describe('loader.deriveSlug', () => {
  it('lowercases and dashes a multi-word name', () => {
    expect(loader.deriveSlug('Code Reviewer')).toBe('code-reviewer');
  });

  it('collapses consecutive non-alphanumerics', () => {
    expect(loader.deriveSlug('  Multi  Space  ')).toBe('multi-space');
  });

  it('truncates to 32 characters', () => {
    const long = 'a'.repeat(40);
    expect(loader.deriveSlug(long).length).toBe(32);
  });

  it('throws invalid_id when the result is empty', () => {
    expect(() => loader.deriveSlug('!!')).toThrowError(expect.objectContaining({ code: 'invalid_id' }));
  });

  it('throws invalid_id when name is not a string', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => loader.deriveSlug(undefined as any)).toThrowError(expect.objectContaining({ code: 'invalid_id' }));
  });
});

describe('loader.readConfig', () => {
  it('returns null on ENOENT', () => {
    const dir = mkTmp();
    try {
      expect(loader.readConfig(dir, 'default')).toBeNull();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('rejects unknown keys with code:invalid_config', () => {
    const dir = mkTmp();
    const botDir = path.join(dir, 'bots', 'alpha');
    fs.mkdirSync(botDir, { recursive: true });
    fs.writeFileSync(
      path.join(botDir, 'config.json'),
      JSON.stringify({
        id: 'alpha',
        name: 'Alpha',
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'idle',
        rogue_field: 'should be rejected',
      }),
      'utf8',
    );
    try {
      expect(() => loader.readConfig(dir, 'alpha')).toThrowError(
        expect.objectContaining({ code: 'invalid_config' }),
      );
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('rejects invalid bot id with code:invalid_id', () => {
    const dir = mkTmp();
    try {
      expect(() => loader.readConfig(dir, '../etc')).toThrowError(
        expect.objectContaining({ code: 'invalid_id' }),
      );
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('loader.writeConfig', () => {
  it('roundtrips a full BotConfig shape (write then read)', () => {
    const dir = mkTmp();
    try {
      const cfg = {
        id: 'round-trip',
        name: 'Round Trip',
        persona: 'p',
        workspace: '',
        allowlist: ['read_file', 'memory.update'],
        schemaVersion: 1,
        status: 'idle',
      };
      const written = loader.writeConfig(dir, 'round-trip', cfg);
      expect(written.id).toBe('round-trip');
      expect(written.createdAt).toBeTruthy();
      expect(written.updatedAt).toBeTruthy();
      const read = loader.readConfig(dir, 'round-trip');
      expect(read).not.toBeNull();
      expect(read?.id).toBe('round-trip');
      expect(read?.name).toBe('Round Trip');
      expect(read?.allowlist).toEqual(['read_file', 'memory.update']);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('rejects schemaVersion !== 1', () => {
    const dir = mkTmp();
    try {
      expect(() =>
        loader.writeConfig(
          dir,
          'sv2',
          // @ts-expect-error testing runtime rejection of unknown schema
          { id: 'sv2', name: 'sv2', schemaVersion: 2 },
        ),
      ).toThrowError(expect.objectContaining({ code: 'invalid_config' }));
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('rejects invalid id format on write (../etc)', () => {
    const dir = mkTmp();
    try {
      expect(() =>
        loader.writeConfig(
          dir,
          // @ts-expect-error testing runtime rejection of traversal id
          '../etc',
          { id: '../etc', name: 'bad', schemaVersion: 1 },
        ),
      ).toThrowError(expect.objectContaining({ code: 'invalid_id' }));
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('rejects id with uppercase characters (../etc variant)', () => {
    const dir = mkTmp();
    try {
      expect(() =>
        loader.writeConfig(
          dir,
          // @ts-expect-error testing runtime rejection of uppercase id
          'BAD UPPER',
          { id: 'BAD UPPER', name: 'bad', schemaVersion: 1 },
        ),
      ).toThrowError(expect.objectContaining({ code: 'invalid_id' }));
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('atomic rename failure leaves the original config.json untouched', () => {
    const dir = mkTmp();
    try {
      // Seed an initial config.json that the failing rename must not touch.
      const botDir = path.join(dir, 'bots', 'atomic');
      fs.mkdirSync(botDir, { recursive: true });
      const canonicalPath = path.join(botDir, 'config.json');
      const original = JSON.stringify({ id: 'atomic', name: 'Original', schemaVersion: 1, allowlist: ['read_file'] });
      fs.writeFileSync(canonicalPath, original, 'utf8');

      // Stub fs.renameSync so every rename throws — writeConfig must surface
      // the error AND the original file content stays byte-identical.
      const realRename = fs.renameSync;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('rename failed');
      });
      try {
        expect(() =>
          loader.writeConfig(dir, 'atomic', {
            id: 'atomic',
            name: 'New',
            schemaVersion: 1,
            allowlist: ['write_file'],
          }),
        ).toThrow();
        const after = fs.readFileSync(canonicalPath, 'utf8');
        expect(after).toBe(original);
      } finally {
        renameSpy.mockRestore();
        void realRename;
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('loader.listAllBots', () => {
  it('synthesizes the implicit default bot when bots dir is missing', () => {
    const dir = mkTmp();
    try {
      const list = loader.listAllBots(dir);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('default');
      expect(list[0].name).toBe('Default bot');
      expect(list[0].schemaVersion).toBe(loader.SCHEMA_VERSION);
      expect(list[0].status).toBe('idle');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('returns bots sorted by name ascending', () => {
    const dir = mkTmp();
    try {
      // Seed bots in a deliberately scrambled order to confirm the sort.
      loader.writeConfig(dir, 'z-bot', { id: 'z-bot', name: 'Zebra', schemaVersion: 1 });
      loader.writeConfig(dir, 'a-bot', { id: 'a-bot', name: 'Apple', schemaVersion: 1 });
      loader.writeConfig(dir, 'm-bot', { id: 'm-bot', name: 'Mango', schemaVersion: 1 });
      const list = loader.listAllBots(dir);
      expect(list.map((b) => b.name)).toEqual(['Apple', 'Mango', 'Zebra']);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('returns the synthesized default bot when no bot dirs exist', () => {
    const dir = mkTmp();
    try {
      const list = loader.listAllBots(dir);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('default');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('loader.deleteBot', () => {
  it('throws unknown_bot when the dir is missing', () => {
    const dir = mkTmp();
    try {
      expect(() => loader.deleteBot(dir, 'no-such-bot')).toThrowError(
        expect.objectContaining({ code: 'unknown_bot' }),
      );
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('removes the bot directory on success', () => {
    const dir = mkTmp();
    try {
      loader.writeConfig(dir, 'tmp', { id: 'tmp', name: 'Tmp', schemaVersion: 1 });
      expect(loader.botExists(dir, 'tmp')).toBe(true);
      loader.deleteBot(dir, 'tmp');
      expect(loader.botExists(dir, 'tmp')).toBe(false);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('loader.ALLOWED_CONFIG_KEYS (schema surface)', () => {
  it('exposes the 14 canonical keys from the plan', () => {
    expect(loader.ALLOWED_CONFIG_KEYS.size).toBe(14);
    expect(loader.ALLOWED_CONFIG_KEYS.has('id')).toBe(true);
    expect(loader.ALLOWED_CONFIG_KEYS.has('schemaVersion')).toBe(true);
    expect(loader.ALLOWED_CONFIG_KEYS.has('allowlist')).toBe(true);
  });
});
