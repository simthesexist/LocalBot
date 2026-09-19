// Unit tests for daemon/vault/wikilink.cjs.
// Run with: npm test
//
// Phase 7 Plan 2: covers the 4 wikilink grammar variants
// ([[T]], [[T|A]], [[T#S]], [[T#S|A]]), buildVaultIndex traversal
// (.obsidian / .trash / node_modules skips + .md collection),
// case-fold resolution, missing-key behavior, and the empty-text
// degenerate case. Uses real fs against a mkdtemp vault root.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  parseWikilinks,
  buildVaultIndex,
  resolveWikilink,
} = require_('../../daemon/vault/wikilink.cjs') as {
  parseWikilinks: (text: string) => Array<{ title: string; section: string | null; alias: string | null }>;
  buildVaultIndex: (vaultRoot: string) => Promise<Map<string, string>>;
  resolveWikilink: (index: Map<string, string>, name: string) => string | null;
};

let vaultRoot: string;

beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-vault-wikilink-'));
  fs.mkdirSync(path.join(vaultRoot, 'Projects'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'Projects', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'Daily'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, '.obsidian'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, '.trash'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'Projects', 'sub', 'node_modules'), { recursive: true });

  fs.writeFileSync(path.join(vaultRoot, 'Projects', 'foo.md'), '# Foo\n');
  fs.writeFileSync(path.join(vaultRoot, 'Projects', 'sub', 'bar.md'), '# Bar\n');
  fs.writeFileSync(path.join(vaultRoot, 'Daily', '2026-09-19.md'), '# Daily\n');
  // Files that should be skipped (hidden + node_modules).
  fs.writeFileSync(path.join(vaultRoot, '.obsidian', 'config.json'), '{}');
  fs.writeFileSync(path.join(vaultRoot, '.trash', 'old.md'), 'deleted note\n');
  fs.writeFileSync(path.join(vaultRoot, 'node_modules', 'readme.md'), 'should be skipped\n');
  fs.writeFileSync(path.join(vaultRoot, 'Projects', 'sub', 'node_modules', 'readme.md'), 'should be skipped\n');
});

afterEach(() => {
  try {
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('parseWikilinks — grammar variants', () => {
  it('parses [[Title]] and [[Title|Alias]]', () => {
    const result = parseWikilinks('See [[Note Name]] and [[Other Note|alias]] for details.');
    expect(result).toEqual([
      { title: 'Note Name', section: null, alias: null },
      { title: 'Other Note', section: null, alias: 'alias' },
    ]);
  });

  it('parses [[Title#Section]] and [[Title#Section|Alias]]', () => {
    const result = parseWikilinks('See [[Note#Section]] and [[Note#Section|Alias]] for details.');
    expect(result).toEqual([
      { title: 'Note', section: 'Section', alias: null },
      { title: 'Note', section: 'Section', alias: 'Alias' },
    ]);
  });

  it('returns [] for text without any [[ ]] substrings', () => {
    expect(parseWikilinks('hello world, no links here')).toEqual([]);
  });

  it('handles the same title twice (duplicates allowed)', () => {
    const result = parseWikilinks('[[Dup]] and [[Dup]]');
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Dup');
    expect(result[1].title).toBe('Dup');
  });

  it('returns [] for empty input', () => {
    expect(parseWikilinks('')).toEqual([]);
  });
});

describe('buildVaultIndex + resolveWiki — traversal + case-fold', () => {
  it('indexes .md files and skips hidden dirs + node_modules', async () => {
    const idx = await buildVaultIndex(vaultRoot);
    const keys = Array.from(idx.keys()).sort();
    expect(keys).toEqual(['2026-09-19', 'bar', 'foo']);
    // Verify hidden dirs were skipped — '.obsidian/config.json' must
    // not appear, and 'old' (in .trash) must not appear.
    expect(keys).not.toContain('config');
    expect(keys).not.toContain('old');
  });

  it('resolves wikilinks case-insensitively', async () => {
    const idx = await buildVaultIndex(vaultRoot);
    const fooAbs = path.join(vaultRoot, 'Projects', 'foo.md');
    expect(resolveWikilink(idx, 'FOO')).toBe(fooAbs);
    expect(resolveWikilink(idx, 'Foo')).toBe(fooAbs);
    expect(resolveWikilink(idx, 'foo')).toBe(fooAbs);
    // Case-fold applies to the LAST write-wins stem; verify a deeply
    // nested note also resolves.
    expect(resolveWikilink(idx, 'BAR')).toBe(path.join(vaultRoot, 'Projects', 'sub', 'bar.md'));
  });

  it('returns null for wikilinks missing from the index', async () => {
    const idx = await buildVaultIndex(vaultRoot);
    expect(resolveWikilink(idx, 'nonexistent')).toBeNull();
  });
});