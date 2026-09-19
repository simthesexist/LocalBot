// vault.read tool — read a note from the Obsidian vault.
//
// ctx (passed by registry) carries (in addition to the workspaceRoot/botDir
// shape every tool receives):
//   - vaultRoot:  absolute path to the resolved vault root
//                 (botCfg.vaultPath if non-empty, else globalCfg.rootPath)
//   - globalDeny: string[] (current globalCfg.globalDeny; re-read per call
//                 so config edits take effect immediately — Pitfall 4)
//   - vaultDeny:  string[] (botCfg.vaultDeny at call-time)
//   - vaultAllow: string[] (botCfg.vaultAllow at call-time)
//   - bot:        string (current bot id; used only for audit / errors)
//
// Threat model coverage:
//   - T-7-01: safe_path realpath + ancestor walk; ../ and symlink escape
//     throw {code:'outside_workspace'}.
//   - T-7-02: deny-wins glob pipeline (globalDeny → vaultDeny → vaultAllow).
//   - T-7-08: safe_path realpath defeats symlinks pointing outside vault.

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
  const requested = (args && typeof args.path === 'string') ? args.path : '';
  if (!requested) throw err('invalid_path', 'path required');

  // Pitfall 8: empty string vaultRoot (botCfg.vaultPath: '' falls back to
  // globalCfg.rootPath which may also be empty) → throw vault_not_configured
  // so the renderer surfaces a useful error rather than a silent no-op.
  if (!ctx || typeof ctx.vaultRoot !== 'string' || ctx.vaultRoot.length === 0) {
    throw err('vault_not_configured', 'vault path not configured (per-bot or global)');
  }

  const resolved = await safePath(ctx.vaultRoot, requested);

  // Normalize to forward-slash vault-relative for the glob check + audit.
  // path.relative uses platform separator (Windows backslash); audit must
  // never contain absolute paths and must be slash-normalized so globs like
  // 'Projects/**' match cleanly.
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

  let content;
  try {
    content = await fs.readFile(resolved, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw err('enoent', `file not found: ${requested}`);
    }
    if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
      throw err('eacces', `permission denied: ${requested}`);
    }
    throw e;
  }

  const bytes = Buffer.byteLength(content, 'utf8');
  // Optional line-slicing (mirrors Phase 2 read_file extension; not in the
  // current read_file.cjs but planned per OBS-02).
  const startLine = (args && Number.isInteger(args.startLine)) ? args.startLine : undefined;
  const endLine = (args && Number.isInteger(args.endLine)) ? args.endLine : undefined;
  if (typeof startLine === 'number' || typeof endLine === 'number') {
    const lines = content.split('\n');
    const s = typeof startLine === 'number' ? Math.max(0, startLine - 1) : 0; // 1-based
    const e = typeof endLine === 'number' ? Math.min(lines.length, endLine) : lines.length;
    const sliced = lines.slice(s, e).join('\n');
    return {
      path: relativePath,
      content: sliced,
      bytes: Buffer.byteLength(sliced, 'utf8'),
      startLine,
      endLine,
      truncated: false,
    };
  }

  return { path: relativePath, content, bytes, truncated: false };
}

module.exports = { call };
