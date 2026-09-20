// Phase 9 Plan 1: persistent network configuration.
//
// Stores the network control-plane configuration at
// `<userData>/network.json`. Three top-level keys:
//   - `port`         — TCP port the HTTP+WS server binds on (default 7878)
//   - `bindMode`     — 'localhost' (default, binds 127.0.0.1) or 'lan'
//                      (binds 0.0.0.0; required for Tailscale / phone-bridge
//                      reach when Tailscale MagicDNS is in play)
//   - `updateChannel` — 'latest' (default), 'beta', or 'nightly' — drives
//                       electron-updater selection in Wave 3.
//
// Persistence model mirrors daemon/vault/config.cjs (Pitfall 12 analog):
//   - atomic tmp + rename
//   - serialize concurrent writes via a promise chain so the file is never
//     written with interleaved bytes
//   - corrupt JSON on read returns the defensive default
//     {port:7878, bindMode:'localhost', updateChannel:'latest'} instead of
//     throwing (renderer-visible state must always be reachable)
//   - saveNetworkConfig validates the shape BEFORE writing; throws
//     `{code:'invalid_network_config'}` on port/bindMode/updateChannel drift.
//
// The validation invariant is the security baseline for NET-03 v1: a
// corrupted file must NEVER cause the server to bind 0.0.0.0 unless the
// persisted bindMode literally equals 'lan'.

const fs = require('node:fs');
const path = require('node:path');

function networkConfigPath(userDataDir) {
  return path.join(userDataDir, 'network.json');
}

function defaultNetworkConfig() {
  return { port: 7878, bindMode: 'localhost', updateChannel: 'latest' };
}

function isValidShape(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (!Number.isInteger(parsed.port)) return false;
  if (parsed.port < 1 || parsed.port > 65535) return false;
  if (parsed.bindMode !== 'localhost' && parsed.bindMode !== 'lan') return false;
  if (
    parsed.updateChannel !== 'latest' &&
    parsed.updateChannel !== 'beta' &&
    parsed.updateChannel !== 'nightly'
  ) return false;
  return true;
}

function loadNetworkConfig(userDataDir) {
  const p = networkConfigPath(userDataDir);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return defaultNetworkConfig();
    // Any other read error (perm denied, locked file) → defensive default.
    return defaultNetworkConfig();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON → defensive default (Pitfall: never throw to renderer).
    return defaultNetworkConfig();
  }
  if (!isValidShape(parsed)) {
    // Shape drift (older daemon wrote `port: "7878"`, hand-edited JSON
    // with `bindMode: 'public'`, etc.) → defensive default. Critically,
    // an invalid shape MUST NEVER come back as `bindMode: 'lan'` because
    // that would silently widen the bind to 0.0.0.0 on next start.
    return defaultNetworkConfig();
  }
  return {
    port: parsed.port,
    bindMode: parsed.bindMode,
    updateChannel: parsed.updateChannel,
  };
}

// Pitfall 12: serialize concurrent saves so a renderer-driven
// `network/set_config` followed immediately by another request can't
// interleave bytes (mid-write corruption would lose the user's bindMode).
let persistQueue = Promise.resolve();

function saveNetworkConfig(userDataDir, cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return Promise.reject(Object.assign(
      new Error('network config must be an object'),
      { code: 'invalid_network_config' },
    ));
  }
  if (!Number.isInteger(cfg.port)) {
    return Promise.reject(Object.assign(
      new Error('network config port must be an integer'),
      { code: 'invalid_network_config' },
    ));
  }
  if (cfg.port < 1 || cfg.port > 65535) {
    return Promise.reject(Object.assign(
      new Error('network config port out of range (1..65535)'),
      { code: 'invalid_network_config' },
    ));
  }
  if (cfg.bindMode !== 'localhost' && cfg.bindMode !== 'lan') {
    return Promise.reject(Object.assign(
      new Error("network config bindMode must be 'localhost' or 'lan'"),
      { code: 'invalid_network_config' },
    ));
  }
  if (
    cfg.updateChannel !== 'latest' &&
    cfg.updateChannel !== 'beta' &&
    cfg.updateChannel !== 'nightly'
  ) {
    return Promise.reject(Object.assign(
      new Error("network config updateChannel must be 'latest', 'beta', or 'nightly'"),
      { code: 'invalid_network_config' },
    ));
  }

  const payload = JSON.stringify(
    { port: cfg.port, bindMode: cfg.bindMode, updateChannel: cfg.updateChannel },
    null,
    2,
  );

  const job = persistQueue.then(async () => {
    const finalPath = networkConfigPath(userDataDir);
    const tmp = `${finalPath}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, finalPath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
    return { port: cfg.port, bindMode: cfg.bindMode, updateChannel: cfg.updateChannel };
  }).catch((e) => {
    // Keep the chain alive so a single rejected save doesn't poison
    // every subsequent queued save. Re-throw so the caller can see it.
    throw e;
  });
  persistQueue = job.catch(() => { /* swallow rejection for chain continuity */ });
  return job;
}

module.exports = {
  loadNetworkConfig,
  saveNetworkConfig,
  networkConfigPath,
  defaultNetworkConfig,
  // Test seam
  __test__: { isValidShape, persistQueue: () => persistQueue },
};
