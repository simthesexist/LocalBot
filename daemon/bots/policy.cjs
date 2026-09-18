// Phase 4 Wave 1: per-bot allowlist loader. Replaces the hardcoded
// `DEFAULT_POLICY` from Phase 3 with a per-bot reader that consults
// `<userData>/bots/<bot>/config.json#allowlist`.
//
// Threat model coverage:
//   - T-P4-02: throws `unknown_bot` for non-existent bot ids (no bypass)
//   - T-P4-03: NO caching — the policy is re-read on every call (Pitfall 1
//     in RESEARCH.md: stale policy after a `bots/update` would let the bot
//     keep using newly-denied tools)
//
// The implicit `default` bot (no config.json on disk) keeps Phase 3's
// DEFAULT_POLICY so the existing test fixtures + Phase 1+2+3 user data
// keep working without migration.

const { readConfig } = require('./loader.cjs');
const { DEFAULT_POLICY } = require('./default.cjs');

function makePolicyFromConfig(cfg) {
  const allowlist = new Set(Array.isArray(cfg.allowlist) ? cfg.allowlist : []);
  return { allowlist, denylist: new Set() };
}

/**
 * getPolicy(botId, ctx) → {allowlist: Set<string>, denylist: Set<string>}
 *
 * - `_system` bot (Phase 3): keeps DEFAULT_POLICY (system calls don't go
 *   through bot metadata).
 * - `default` bot with no config.json: falls back to DEFAULT_POLICY so the
 *   implicit default bot keeps Phase 1+2+3 behavior.
 * - `default` bot WITH a config.json: returns the config's allowlist (lets
 *   the user override the default bot's allowlist later).
 * - Any other bot id without a config.json: throws `{code:'unknown_bot'}`
 *   so the tool registry refuses to dispatch (T-P4-02).
 *
 * ctx is expected to be `{userDataDir}`. The function tolerates a missing
 * ctx (used by the registry's `__test__` path) but in production always
 * receives the full daemon ctx.
 */
function getPolicy(botId, ctx) {
  const userDataDir = ctx && typeof ctx.userDataDir === 'string' ? ctx.userDataDir : null;

  if (botId === '_system') {
    return DEFAULT_POLICY;
  }

  if (!userDataDir) {
    // No userDataDir means the daemon hasn't been initialized OR the
    // caller is a Phase 1+2+3 test fixture that hardcoded the default
    // policy. In production ctx always carries userDataDir (initialize
    // latches it). Falling back to DEFAULT_POLICY keeps Phase 3 behavior
    // for the implicit default bot while refusing unknown bots.
    if (botId === 'default') return DEFAULT_POLICY;
    const e = new Error('userDataDir not configured');
    e.code = 'daemon_not_initialized';
    throw e;
  }

  const cfg = readConfig(userDataDir, botId);
  if (cfg === null) {
    if (botId === 'default') {
      // Implicit default bot with no config.json — back-compat with Phase 3.
      return DEFAULT_POLICY;
    }
    const e = new Error(`unknown bot: ${botId}`);
    e.code = 'unknown_bot';
    throw e;
  }
  return makePolicyFromConfig(cfg);
}

module.exports = { getPolicy, makePolicyFromConfig };
