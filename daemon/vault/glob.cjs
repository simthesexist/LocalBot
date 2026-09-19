// Phase 7 Plan 1: vault access glob pipeline.
//
// The vault uses picomatch globs (NOT minimatch; matches Obsidian's own
// ignore semantics) to decide whether a path is readable / writable by a
// given bot. The deny-wins pipeline evaluates in this order:
//
//   1. globalDeny — applied to every bot, cannot be overridden.
//   2. vaultDeny  — per-bot deny list.
//   3. vaultAllow — per-bot allow list. Empty/undefined = blocked.
//
// The `pattern` field on a denied result is the SPECIFIC glob string from
// the list that matched the relative path — surfaced into audit rows so
// operators can see why a path was refused.
//
// Empty / non-array input → makeMatcher returns () => false (defensive).

const picomatch = require('picomatch');

function makeMatcher(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return () => false;
  }
  // Defensive: filter out non-string entries before handing to picomatch.
  // The loader enforces array-of-strings at config-write time; this is a
  // belt-and-braces guard for hand-edited vault.json or in-test injection.
  const cleaned = patterns.filter((p) => typeof p === 'string' && p.length > 0);
  if (cleaned.length === 0) return () => false;
  // dot: true so .obsidian/*.json etc. are matched by '**' globs;
  // nocase: false so users get POSIX-strict matching (Obsidian itself is
  // case-insensitive on case-folded filesystems, but the daemon runs on
  // Windows where paths are already case-insensitive at the OS layer).
  return picomatch(cleaned, { dot: true, nocase: false });
}

function firstMatching(patterns, relPath) {
  if (!Array.isArray(patterns)) return undefined;
  for (const p of patterns) {
    if (typeof p !== 'string') continue;
    if (picomatch.isMatch(relPath, p, { dot: true })) return p;
  }
  return undefined;
}

function checkVaultAccess({ globalDeny, vaultDeny, vaultAllow, relativePath }) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return { allowed: false, reason: 'invalid_path' };
  }
  // Pitfall 5: globalDeny FIRST. A path matching both global and per-bot
  // lists is rejected with reason 'global_deny'.
  if (Array.isArray(globalDeny) && globalDeny.length) {
    const m = makeMatcher(globalDeny);
    if (m(relativePath)) {
      return { allowed: false, reason: 'global_deny', pattern: firstMatching(globalDeny, relativePath) };
    }
  }
  if (Array.isArray(vaultDeny) && vaultDeny.length) {
    const m = makeMatcher(vaultDeny);
    if (m(relativePath)) {
      return { allowed: false, reason: 'vault_deny', pattern: firstMatching(vaultDeny, relativePath) };
    }
  }
  // Empty allow = block by default (Pitfall: never silently allow).
  if (!Array.isArray(vaultAllow) || vaultAllow.length === 0) {
    return { allowed: false, reason: 'no_allowlist' };
  }
  const allow = makeMatcher(vaultAllow);
  if (!allow(relativePath)) {
    return { allowed: false, reason: 'not_in_allowlist' };
  }
  return { allowed: true };
}

module.exports = {
  makeMatcher,
  checkVaultAccess,
  // Test seam
  __test__: { firstMatching },
};
