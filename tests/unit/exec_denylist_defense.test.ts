// Phase 5 Wave 2: defense-in-depth denylist check in daemon/main.cjs.
//
// The exec_command.cjs module's matchesDangerous() at the registry entry is
// the primary gate. main.cjs ALSO calls matchesDangerous() before delegating
// to registry.callTool so a future refactor of exec_command.cjs cannot
// accidentally bypass the global safety net.
//
// We verify the seam by exercising the denylist module's matchesDangerous()
// directly — the test pins down the contract that main.cjs relies on.
// matchesDangerous returns { hit, pattern } not a boolean — distinguishing
// "no match" from "matched but we lost the pattern reference" matters for
// the audit line and for any future deny-list customization.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const denylist = require_('../../daemon/exec/denylist.cjs') as {
  matchesDangerous: (cmd: string) => { hit: boolean; pattern: string | null };
  GLOBAL_DENYLIST: RegExp[];
};

describe('defense-in-depth denylist contract', () => {
  it('matchesDangerous returns hit=true for rm -rf /', () => {
    expect(denylist.matchesDangerous('rm -rf /').hit).toBe(true);
  });

  it('matchesDangerous returns hit=true for sudo rm', () => {
    expect(denylist.matchesDangerous('sudo rm -rf /home').hit).toBe(true);
  });

  it('matchesDangerous returns hit=true for dd if=/dev/zero of=/dev/sda', () => {
    expect(denylist.matchesDangerous('dd if=/dev/zero of=/dev/sda').hit).toBe(true);
  });

  it('matchesDangerous returns hit=true for mkfs.ext4', () => {
    expect(denylist.matchesDangerous('mkfs.ext4 /dev/sdb').hit).toBe(true);
  });

  it('matchesDangerous returns hit=true for remove-item -recurse c:\\', () => {
    expect(denylist.matchesDangerous('remove-item -recurse c:\\foo').hit).toBe(true);
  });

  it('matchesDangerous returns hit=false for benign commands', () => {
    expect(denylist.matchesDangerous('echo hello').hit).toBe(false);
    expect(denylist.matchesDangerous('ls -la').hit).toBe(false);
    expect(denylist.matchesDangerous('git status').hit).toBe(false);
    expect(denylist.matchesDangerous('npm test').hit).toBe(false);
  });

  it('GLOBAL_DENYLIST has at least 10 entries', () => {
    expect(denylist.GLOBAL_DENYLIST.length).toBeGreaterThanOrEqual(10);
  });

  it('every entry in GLOBAL_DENYLIST is a RegExp', () => {
    for (const re of denylist.GLOBAL_DENYLIST) {
      expect(re).toBeInstanceOf(RegExp);
    }
  });

  it('matchesDangerous returns hit=false + pattern=null for empty input', () => {
    const r = denylist.matchesDangerous('');
    expect(r.hit).toBe(false);
    expect(r.pattern).toBeNull();
  });

  it('matchesDangerous returns hit=true with non-null pattern on match', () => {
    const r = denylist.matchesDangerous('rm -rf /');
    expect(r.hit).toBe(true);
    expect(r.pattern).not.toBeNull();
  });
});
