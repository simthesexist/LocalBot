// Unit tests for daemon/vault/glob.cjs — picomatch deny-wins pipeline.
// Run with: npm test
//
// Phase 7 Plan 1: covers the deny-wins precedence invariant (Pitfall 5),
// empty-allowlist blocking, dotfile matching (Pitfall Open Q #2), and the
// defensive makeMatcher shape (non-array / empty / non-string entries).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const vaultGlob = require_('../../daemon/vault/glob.cjs') as {
  makeMatcher: (patterns: unknown) => (relPath: string) => boolean;
  checkVaultAccess: (req: {
    globalDeny?: unknown;
    vaultDeny?: unknown;
    vaultAllow?: unknown;
    relativePath: string;
  }) => { allowed: boolean; reason?: string; pattern?: string };
};

describe('vault.glob — makeMatcher defensive shape', () => {
  it('returns () => false for non-array input', () => {
    const m = vaultGlob.makeMatcher('Private/**');
    expect(m('Private/secret.md')).toBe(false);
  });

  it('returns () => false for empty array input', () => {
    const m = vaultGlob.makeMatcher([]);
    expect(m('anything.md')).toBe(false);
  });

  it('returns () => false for null/undefined input', () => {
    expect(vaultGlob.makeMatcher(null)('foo')).toBe(false);
    expect(vaultGlob.makeMatcher(undefined)('foo')).toBe(false);
  });

  it('matches a simple path against a single pattern', () => {
    const m = vaultGlob.makeMatcher(['Projects/**']);
    expect(m('Projects/foo.md')).toBe(true);
    expect(m('Daily/2026-09-19.md')).toBe(false);
  });

  it('skips non-string entries inside the array', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = vaultGlob.makeMatcher(['Projects/**', 42 as any, null as any]);
    expect(m('Projects/foo.md')).toBe(true);
    expect(m('Daily/x.md')).toBe(false);
  });
});

describe('vault.glob — checkVaultAccess pipeline', () => {
  it('globalDeny match wins (Pitfall 5)', () => {
    const r = vaultGlob.checkVaultAccess({
      globalDeny: ['Private/**'],
      vaultDeny: [],
      vaultAllow: ['**/*'],
      relativePath: 'Private/secret.md',
    });
    expect(r).toEqual({ allowed: false, reason: 'global_deny', pattern: 'Private/**' });
  });

  it('vaultDeny match after globalDeny passes', () => {
    const r = vaultGlob.checkVaultAccess({
      globalDeny: [],
      vaultDeny: ['Daily/**'],
      vaultAllow: ['**/*'],
      relativePath: 'Daily/2026-09-19.md',
    });
    expect(r).toEqual({ allowed: false, reason: 'vault_deny', pattern: 'Daily/**' });
  });

  it('not_in_allowlist when path matches neither globalDeny nor vaultDeny nor vaultAllow', () => {
    const r = vaultGlob.checkVaultAccess({
      globalDeny: [],
      vaultDeny: [],
      vaultAllow: ['Projects/**'],
      relativePath: 'Daily/2026-09-19.md',
    });
    expect(r).toEqual({ allowed: false, reason: 'not_in_allowlist' });
  });

  it('no_allowlist when vaultAllow is empty/undefined', () => {
    expect(
      vaultGlob.checkVaultAccess({ vaultAllow: [], relativePath: 'Projects/foo.md' }),
    ).toEqual({ allowed: false, reason: 'no_allowlist' });
    expect(
      vaultGlob.checkVaultAccess({ vaultAllow: undefined, relativePath: 'Projects/foo.md' }),
    ).toEqual({ allowed: false, reason: 'no_allowlist' });
  });

  it('globalDeny wins over vaultAllow when path matches both', () => {
    const r = vaultGlob.checkVaultAccess({
      globalDeny: ['Private/**'],
      vaultDeny: [],
      vaultAllow: ['**/*'],
      relativePath: 'Private/notes.md',
    });
    expect(r.reason).toBe('global_deny');
  });

  it('order invariant: globalDeny checked FIRST even when vaultDeny would also match', () => {
    const r = vaultGlob.checkVaultAccess({
      globalDeny: ['Shared/**'],
      vaultDeny: ['Shared/**'],
      vaultAllow: ['**/*'],
      relativePath: 'Shared/note.md',
    });
    expect(r.reason).toBe('global_deny');
  });

  it('allows a dotfile when vaultAllow matches ** (dot:true honored)', () => {
    const r = vaultGlob.checkVaultAccess({
      globalDeny: [],
      vaultDeny: [],
      vaultAllow: ['**/*'],
      relativePath: '.obsidian/workspace.json',
    });
    expect(r.allowed).toBe(true);
  });

  it('case-sensitive matching: uppercase path does not match lower-case glob', () => {
    const r = vaultGlob.checkVaultAccess({
      globalDeny: [],
      vaultDeny: [],
      vaultAllow: ['Projects/**'],
      relativePath: 'projects/foo.md',
    });
    // picomatch with nocase:false is case-sensitive.
    expect(r.reason).toBe('not_in_allowlist');
  });

  it('brace-expansion in vaultAllow matches any branch', () => {
    const r = vaultGlob.checkVaultAccess({
      globalDeny: [],
      vaultDeny: [],
      vaultAllow: ['Projects/{foo,bar}/**'],
      relativePath: 'Projects/bar/baz.md',
    });
    expect(r.allowed).toBe(true);
  });

  it('returns invalid_path for empty / non-string relativePath', () => {
    expect(
      vaultGlob.checkVaultAccess({ vaultAllow: ['**/*'], relativePath: '' }),
    ).toEqual({ allowed: false, reason: 'invalid_path' });
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vaultGlob.checkVaultAccess({ vaultAllow: ['**/*'], relativePath: 42 as any }),
    ).toEqual({ allowed: false, reason: 'invalid_path' });
  });

  it('happy path: allow matches, no deny', () => {
    const r = vaultGlob.checkVaultAccess({
      globalDeny: ['Private/**'],
      vaultDeny: [],
      vaultAllow: ['Projects/**', 'Daily/**'],
      relativePath: 'Projects/foo.md',
    });
    expect(r).toEqual({ allowed: true });
  });

  it('first-matching pattern is returned for the matched list', () => {
    const r = vaultGlob.checkVaultAccess({
      globalDeny: ['Private/**', 'Credentials/**'],
      vaultDeny: [],
      vaultAllow: ['**/*'],
      relativePath: 'Credentials/tokens.md',
    });
    expect(r.reason).toBe('global_deny');
    expect(r.pattern).toBe('Credentials/**');
  });
});
