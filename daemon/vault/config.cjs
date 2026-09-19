// Phase 7 Plan 1: global vault config persistence.
//
// Stores the global vault configuration at `<userDataDir>/vault.json`. Two
// top-level keys: `rootPath` (string; the absolute path to the Obsidian
// vault on disk) and `globalDeny` (string[]; picomatch globs that win over
// every bot's allow/deny — e.g. `Private/**`, `Credentials/**`).
//
// Persistence model mirrors daemon/scheduler/index.cjs (Pitfall 12 analog):
//   - atomic tmp + rename
//   - serialize concurrent writes via a promise chain so the file is never
//     written with interleaved bytes
//   - corrupt JSON on read returns the defensive default {rootPath: '',
//     globalDeny: []} instead of throwing (renderer-visible state must
//     always be reachable)
//   - saveVaultConfig validates the shape BEFORE writing; throws
//     `{code:'invalid_vault_config'}` when rootPath is not a string or
//     globalDeny contains a non-string entry.

const fs = require('node:fs');
const path = require('node:path');

function vaultConfigPath(userDataDir) {
  return path.join(userDataDir, 'vault.json');
}

function defaultVaultConfig() {
  return { rootPath: '', globalDeny: [] };
}

function isValidShape(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (typeof parsed.rootPath !== 'string') return false;
  if (!Array.isArray(parsed.globalDeny)) return false;
  for (const g of parsed.globalDeny) {
    if (typeof g !== 'string') return false;
  }
  return true;
}

function loadVaultConfig(userDataDir) {
  const p = vaultConfigPath(userDataDir);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return defaultVaultConfig();
    // Any other read error → fall back to default (defensive; never crash
    // the daemon on a corrupt permission / locked file).
    return defaultVaultConfig();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON → defensive default (Pitfall: do not throw to renderer).
    return defaultVaultConfig();
  }
  if (!isValidShape(parsed)) {
    // Shape drift (older daemon wrote `rootPath: 123`, hand-edited JSON
    // with `globalDeny: {…}`, etc.) → defensive default.
    return defaultVaultConfig();
  }
  return { rootPath: parsed.rootPath, globalDeny: parsed.globalDeny.slice() };
}

// Pitfall 12: serialize concurrent saves so a renderer-driven `vault/set_config`
// followed immediately by another request can't interleave bytes.
let persistQueue = Promise.resolve();

function saveVaultConfig(userDataDir, cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return Promise.reject(Object.assign(
      new Error('vault config must be an object'),
      { code: 'invalid_vault_config' },
    ));
  }
  if (typeof cfg.rootPath !== 'string') {
    return Promise.reject(Object.assign(
      new Error('vault config rootPath must be a string'),
      { code: 'invalid_vault_config' },
    ));
  }
  if (!Array.isArray(cfg.globalDeny)) {
    return Promise.reject(Object.assign(
      new Error('vault config globalDeny must be an array of strings'),
      { code: 'invalid_vault_config' },
    ));
  }
  for (const g of cfg.globalDeny) {
    if (typeof g !== 'string') {
      return Promise.reject(Object.assign(
        new Error('vault config globalDeny entries must be strings'),
        { code: 'invalid_vault_config' },
      ));
    }
  }

  const payload = JSON.stringify(
    { rootPath: cfg.rootPath, globalDeny: cfg.globalDeny.slice() },
    null,
    2,
  );

  const job = persistQueue.then(async () => {
    const finalPath = vaultConfigPath(userDataDir);
    const tmp = `${finalPath}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, finalPath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
    return { rootPath: cfg.rootPath, globalDeny: cfg.globalDeny.slice() };
  }).catch((e) => {
    // Keep the chain alive so a single rejected save doesn't poison
    // every subsequent queued save. Re-throw so the caller can see it.
    throw e;
  });
  persistQueue = job.catch(() => { /* swallow rejection for chain continuity */ });
  return job;
}

module.exports = {
  loadVaultConfig,
  saveVaultConfig,
  vaultConfigPath,
  defaultVaultConfig,
  // Test seam
  __test__: { isValidShape, persistQueue: () => persistQueue },
};
