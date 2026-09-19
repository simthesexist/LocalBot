// vault.write tool — write a note to Agents/<bot>/ of the vault.
//
// Defense in depth (Pitfall 6 + RESEARCH §Pattern 3):
//   Layer 1: safe_path realpath → throws {code:'outside_workspace'} for
//            ../ or symlink escape.
//   Layer 2: Agents/<bot>/ containment via path.relative(realAgents,
//            resolved) — any path outside Agents/<bot>/ throws
//            {code:'write_outside_agents'}.
//
// Writes are atomic (tmp + rename). Mid-write failure leaves no partial
// file at the canonical path. tmp file cleanup is best-effort.
//
// ctx carries the same vault* fields as vault_read, plus `bot` (required).

const fs = require('node:fs/promises');
const path = require('node:path');
const { safePath } = require('./safe_path.cjs');

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function call(args, ctx) {
  const requested = (args && typeof args.path === 'string') ? args.path : '';
  const content = args && args.content;

  if (!requested) throw err('invalid_path', 'path required');
  if (typeof content !== 'string') {
    throw err('invalid_content', 'content must be a string');
  }
  if (!ctx || typeof ctx.vaultRoot !== 'string' || ctx.vaultRoot.length === 0) {
    throw err('vault_not_configured', 'vault path not configured (per-bot or global)');
  }
  if (typeof ctx.bot !== 'string' || ctx.bot.length === 0) {
    throw err('bot_required', 'bot id required in ctx for vault.write');
  }

  // Layer 1: workspace containment via safe_path. Catches `../` and
  // symlink escape from anywhere inside the vault.
  const resolved = await safePath(ctx.vaultRoot, requested);

  // Layer 2: must live under Agents/<bot>/. Compute the canonical
  // Agents/<bot>/ directory and verify the resolved path is inside.
  const agentsDir = path.join(ctx.vaultRoot, 'Agents', ctx.bot);
  // realpath the agents dir; if it doesn't exist yet, fall back to the
  // joined absolute (write_file creates it via mkdir -p below).
  let agentsReal;
  try {
    agentsReal = await fs.realpath(agentsDir);
  } catch {
    agentsReal = agentsDir;
  }
  const relToAgents = path.relative(agentsReal, resolved).replace(/\\/g, '/');
  if (relToAgents.startsWith('..') || path.isAbsolute(relToAgents) || relToAgents === '') {
    throw err(
      'write_outside_agents',
      `vault.write only allows paths inside Agents/${ctx.bot}/`,
    );
  }

  // Create parent dirs recursively (the canonical write_file behavior).
  await fs.mkdir(path.dirname(resolved), { recursive: true });

  // Pitfall 6: atomic tmp + rename.
  const tmp = `${resolved}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, resolved);
  } catch (e) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
      throw err('eacces', `permission denied writing: ${requested}`);
    }
    throw e;
  }

  const relativePath = path.relative(ctx.vaultRoot, resolved).replace(/\\/g, '/');
  return { path: relativePath, bytesWritten: Buffer.byteLength(content, 'utf8') };
}

module.exports = { call };
