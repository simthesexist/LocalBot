// Phase 7 Plan 2: wikilink parser + vault index + case-fold resolver.
//
// Implements the 4-variant Obsidian wikilink grammar:
//
//   [[Title]]
//   [[Title|Alias]]
//   [[Title#Section]]
//   [[Title#Section|Alias]]
//
// Threat model coverage:
//   - T-7-12: regex uses negated classes [^\\]|]+ so the regex is
//     ReDoS-safe (no nested quantifiers, no catastrophic backtracking).
//   - T-7-14: buildVaultIndex skips .obsidian, .trash, node_modules so
//     Obsidian config / trash / third-party trees never leak into the
//     resolver. Case-fold lookup defeats case-sensitivity attacks on
//     Windows / macOS / Linux (Pitfall 1).

const fs = require('node:fs/promises');
const path = require('node:path');

// Reset lastIndex so repeated calls share the module-scope RegExp.
//
// Title class EXCLUDES `#` so `[[Note#Section]]` MUST parse #Section as
// the section (not fold it into the title). The plan's draft regex
// `[^\[\]|]+` greedily ate `#Section` as the title; this corrected form
// uses `[^\[\]|#]+` so the section branch is forced (Pitfall 8).
const WIKILINK_RE = /\[\[([^\[\]|#]+)(?:#([^\[\]|]+))?(?:\|([^\[\]]+))?\]\]/g;

function parseWikilinks(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  // Reset the module-scope regex so repeated calls don't drift past
  // lastIndex from a prior call (V8 would otherwise skip matches at
  // index 0 of subsequent strings).
  WIKILINK_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    out.push({
      title: m[1].trim(),
      section: m[2] ? m[2].trim() : null,
      alias: m[3] ? m[3].trim() : null,
    });
    // Guard against zero-length matches (defensive — regex is well-formed
    // but defensive programming here is cheap).
    if (m.index === WIKILINK_RE.lastIndex) WIKILINK_RE.lastIndex++;
  }
  return out;
}

async function buildVaultIndex(vaultRoot) {
  const idx = new Map();

  async function walk(dir) {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Per-directory read failure (permission, vanished, etc.) → skip.
      // We never want one unreadable subdirectory to abort the entire
      // index build (Pitfall: vault indexing must be best-effort).
      return;
    }
    for (const e of dirents) {
      // Skip hidden directories (covers .obsidian, .trash, .git) — but
      // allow a file literally named ".md" through (Obsidian can have
      // dotfiles at the top level).
      if (e.isDirectory() && e.name.startsWith('.')) continue;
      // Skip node_modules regardless of nesting depth (third-party trees
      // can hide huge dependency graphs).
      if (e.isDirectory() && e.name === 'node_modules') continue;
      if (e.isDirectory()) {
        await walk(path.join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      if (!e.name.toLowerCase().endsWith('.md')) continue;
      const stem = e.name.slice(0, -3); // strip ".md"
      // Pitfall 1: case-fold the key so [[Foo]], [[foo]], and [[FOO]]
      // all resolve to the same entry. Last-write-wins on duplicates is
      // acceptable — the resolver cannot pick a "winner" among same-stem
      // files anyway (it's an inherent ambiguity on case-insensitive
      // filesystems).
      idx.set(stem.toLowerCase(), path.join(dir, e.name));
    }
  }

  await walk(vaultRoot);
  return idx;
}

function resolveWikilink(index, name) {
  if (!(index instanceof Map)) return null;
  if (typeof name !== 'string' || name.length === 0) return null;
  return index.get(name.toLowerCase()) ?? null;
}

module.exports = {
  parseWikilinks,
  buildVaultIndex,
  resolveWikilink,
  // Test seams — exposed so unit tests can probe internal invariants.
  __test__: { WIKILINK_RE },
};