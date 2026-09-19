// vault.list tool — list entries in a vault directory.
//
// Mirrors daemon/tools/list_dir.cjs with the vault-specific differences:
//   1. ctx.vaultRoot replaces ctx.workspaceRoot.
//   2. The listed dir's vault-relative path is filtered through
//      checkVaultAccess BEFORE returning entries (Plan 07-02
//      prohibition #4 — the listed dir must pass the glob pipeline).
//   3. Hidden dirs (.obsidian, .trash) are skipped by default unless
//      args.includeHidden is true.
//   4. Result carries {path: relativePath, entries, entryCount} so
//      audit minimization can record path + entryCount without leaking
//      the entry list itself.

const fs = require('node:fs/promises');
const path = require('node:path');
const { safePath } = require('./safe_path.cjs');
const { checkVaultAccess } = require('../vault/index.cjs');

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function call(args, ctx) {
  const requested = (args && typeof args.path === 'string' && args.path.length > 0) ? args.path : '.';
  if (!ctx || typeof ctx.vaultRoot !== 'string' || ctx.vaultRoot.length === 0) {
    throw err('vault_not_configured', 'vault path not configured (per-bot or global)');
  }

  // safePath realpaths + ancestor walk; throws `outside_workspace` for
  // ../ and symlink escape. After this call, `resolved` is guaranteed
  // to live inside ctx.vaultRoot.
  const resolved = await safePath(ctx.vaultRoot, requested);

  // Normalize to forward-slash vault-relative for the glob check +
  // audit. path.relative uses platform separator (Windows backslash);
  // audit must be slash-normalized so globs like 'Projects/**' match
  // cleanly (Plan 07-01 invariant).
  const relativePath = path.relative(ctx.vaultRoot, resolved).replace(/\\/g, '/');

  const access = checkVaultAccess({
    globalDeny: ctx.globalDeny || [],
    vaultDeny: ctx.vaultDeny || [],
    vaultAllow: ctx.vaultAllow || [],
    relativePath,
  });
  if (!access.allowed) {
    const e = new Error(`access denied: ${access.reason}`);
    e.code = 'glob_denied';
    e.reason = access.reason;
    if (access.pattern) e.pattern = access.pattern;
    throw e;
  }

  let dirents;
  try {
    dirents = await fs.readdir(resolved, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw err('enoent', `directory not found: ${requested}`);
    }
    if (e && e.code === 'ENOTDIR') {
      throw err('not_a_directory', `not a directory: ${requested}`);
    }
    throw e;
  }

  const includeHidden = !!(args && args.includeHidden === true);

  // Sort: dirs first (alpha), then files (alpha). Stable tiebreak by
  // lowercased name → original name (so "Foo" and "foo" order consistently
  // even on case-sensitive filesystems). Mirrors list_dir.cjs.
  const entries = dirents
    .filter((d) => includeHidden || !d.name.startsWith('.'))
    .map((d) => ({
      name: d.name,
      type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other',
      size: d.isFile() ? (d.size ?? null) : null,
    }))
    .sort((a, b) => {
      if (a.type === b.type) {
        const al = a.name.toLowerCase();
        const bl = b.name.toLowerCase();
        if (al === bl) return a.name.localeCompare(b.name);
        return al.localeCompare(bl);
      }
      return a.type === 'dir' ? -1 : 1;
    });

  return { path: relativePath, entries, entryCount: entries.length };
}

module.exports = { call };