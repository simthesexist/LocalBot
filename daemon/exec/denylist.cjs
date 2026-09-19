// Phase 5 Wave 1: global command denylist.
//
// Threat model coverage:
//   - T-05-01 (tampering): matchesDangerous runs FIRST in exec_command.call
//     before any allowlist or approval gate; tested by exec_denylist.test.ts
//     (10 patterns).
//
// The array is intentionally a flat regex list (no glob, no AST) so a single
// linear scan catches each pattern. Each pattern is anchored on the trimmed,
// lowercased command — patterns are intentionally LOWER-CASE ONLY because
// trim+lowercase collapses casing variants.

const DEFAULT_GLOBAL_DENYLIST = [
  // POSIX recursive / system wipe
  /\brm\s+-[a-z0-9]*r[a-z0-9]*f[a-z0-9]*\s+\//i,
  /\bsudo\s+/i,
  /\bmkfs(\.|-)[a-z0-9]+/i,
  /\bdd\s+if=\/dev\/zero/i,
  />\s*\/dev\/sda/i,

  // Pipe-to-shell remote execution
  /\bcurl\b.*\|\s*bash/i,
  /\bwget\b.*\|\s*bash/i,

  // Windows destructive
  /\bremove-item\b.*-recurse\s+c:\\/i,
  /\breg\s+delete\s+hklm\b/i,
  /\bnet\s+user\b.*\/add/i,

  // PowerShell remote execution
  /\binvoke-expression\b.*\(\s*invoke-webrequest/i,
];

let activeDenylist = DEFAULT_GLOBAL_DENYLIST;

function matchesDangerous(command) {
  if (typeof command !== 'string' || command.length === 0) {
    return { hit: false, pattern: null };
  }
  const normalized = command.trim().toLowerCase();
  for (const pattern of activeDenylist) {
    if (pattern.test(normalized)) {
      return { hit: true, pattern: String(pattern) };
    }
  }
  return { hit: false, pattern: null };
}

// Test seam: lets unit tests swap the active denylist (exec_denylist_defense).
function __setDenylistForTest__(arr) {
  activeDenylist = Array.isArray(arr) ? arr : DEFAULT_GLOBAL_DENYLIST;
}

function __getDenylistForTest__() {
  return activeDenylist;
}

module.exports = {
  GLOBAL_DENYLIST: DEFAULT_GLOBAL_DENYLIST,
  matchesDangerous,
  __setDenylistForTest__,
  __getDenylistForTest__,
};