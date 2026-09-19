// Phase 4 Wave 1: per-bot config.json loader. Source of truth for bot
// metadata (id, name, persona, workspace, allowlist, cron, status, lastRunAt).
//
// Threat model coverage:
//   - T-P4-01: id regex + safePath containment for every write
//   - T-P4-06: atomic tmp + rename for every writeConfig
//   - T-P4-07: schema allowlist (ALLOWED_CONFIG_KEYS) — unknown keys throw
//     `invalid_config` so silent acceptance is impossible
//
// All filesystem ops live in the daemon (SEC-02); the renderer never writes
// config.json. The daemon is the trust boundary for bot metadata.

const fs = require('node:fs');
const path = require('node:path');

// Pitfall T-P4-07: every key in config.json must appear here. Adding a new
// field to the schema is an explicit, reviewable change. Forward-compat:
// unknown keys are rejected (no silent acceptance).
const ALLOWED_CONFIG_KEYS = new Set([
  'id',
  'name',
  'persona',
  'workspace',
  'allowlist',
  'cron',
  'cronEnabled',
  'notifyOnError',
  'scheduledPrompt',
  // Phase 7 Plan 1: per-bot Obsidian vault config. `vaultPath` overrides
  // the global vault root for this bot only; `vaultAllow` / `vaultDeny`
  // are picomatch glob arrays evaluated against vault-relative paths.
  // Empty `vaultAllow` blocks reads (Pitfall: never silently allow).
  'vaultPath',
  'vaultAllow',
  'vaultDeny',
  'createdAt',
  'updatedAt',
  'status',
  'lastRunAt',
  'lastRunExitReason',
  'lastRunError',
  'schemaVersion',
]);

const ID_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SCHEMA_VERSION = 1;

// Phase 6: cron expression shape. Accepts 5-field (m h dom mon dow) or
// 6-field (s m h dom mon dow) whitespace-separated tokens. The 6-field
// variant requires a leading seconds field. Used by validateConfig +
// writeConfigPatch to throw `{code:'invalid_cron'}` on garbage input.
const CRON_REGEX = /^(\S+\s+){4,5}\S+$/;
const SCHEDULED_PROMPT_MAX = 4096;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw err('invalid_config', 'config must be an object');
  }
  for (const k of Object.keys(cfg)) {
    if (!ALLOWED_CONFIG_KEYS.has(k)) {
      throw err('invalid_config', `unknown config key: ${k}`);
    }
  }
  if (typeof cfg.id !== 'string' || !ID_REGEX.test(cfg.id)) {
    throw err('invalid_id', `bot id must match /^[a-z0-9][a-z0-9-]{0,31}$/: ${cfg.id}`);
  }
  if (cfg.schemaVersion !== SCHEMA_VERSION) {
    throw err(
      'invalid_config',
      `unsupported schemaVersion ${cfg.schemaVersion}; expected ${SCHEMA_VERSION}`,
    );
  }
  if (typeof cfg.name !== 'string' || cfg.name.length === 0) {
    throw err('invalid_config', 'name must be a non-empty string');
  }
  // Phase 6: cron expression. Accept empty string (clears the schedule)
  // but reject anything that isn't a 5- or 6-field cron expression.
  if ('cron' in cfg && cfg.cron !== undefined && cfg.cron !== '') {
    if (typeof cfg.cron !== 'string' || !CRON_REGEX.test(cfg.cron)) {
      throw err('invalid_cron', `cron must be 5- or 6-field expression: ${cfg.cron}`);
    }
  }
  // notifyOnError is a strict boolean.
  if ('notifyOnError' in cfg && cfg.notifyOnError !== undefined && typeof cfg.notifyOnError !== 'boolean') {
    throw err('invalid_config', 'notifyOnError must be boolean');
  }
  // scheduledPrompt is a non-empty string (or undefined) up to SCHEDULED_PROMPT_MAX chars.
  if ('scheduledPrompt' in cfg && cfg.scheduledPrompt !== undefined) {
    if (typeof cfg.scheduledPrompt !== 'string' || cfg.scheduledPrompt.length > SCHEDULED_PROMPT_MAX) {
      throw err('invalid_config', `scheduledPrompt must be string (max ${SCHEDULED_PROMPT_MAX} chars)`);
    }
  }
  // Phase 7 Plan 1: vaultPath is `null`, `undefined`, or a string. Empty
  // string is accepted (falls back to global vault root at call time); a
  // non-string throws so a renderer typo can't smuggle through.
  if ('vaultPath' in cfg && cfg.vaultPath !== undefined && cfg.vaultPath !== null) {
    if (typeof cfg.vaultPath !== 'string') {
      throw err('invalid_config', 'vaultPath must be string or null');
    }
  }
  // vaultAllow + vaultDeny are arrays of strings. Empty arrays are valid
  // (block-all / no-deny). Non-string entries throw — a renderer that
  // accidentally passes an object or number must not silently bypass.
  if ('vaultAllow' in cfg && cfg.vaultAllow !== undefined) {
    if (!Array.isArray(cfg.vaultAllow)) {
      throw err('invalid_config', 'vaultAllow must be array of strings');
    }
    for (const g of cfg.vaultAllow) {
      if (typeof g !== 'string') {
        throw err('invalid_config', 'vaultAllow entries must be strings');
      }
    }
  }
  if ('vaultDeny' in cfg && cfg.vaultDeny !== undefined) {
    if (!Array.isArray(cfg.vaultDeny)) {
      throw err('invalid_config', 'vaultDeny must be array of strings');
    }
    for (const g of cfg.vaultDeny) {
      if (typeof g !== 'string') {
        throw err('invalid_config', 'vaultDeny entries must be strings');
      }
    }
  }
}

function synthesizeDefaultBot() {
  const now = new Date().toISOString();
  return {
    id: 'default',
    name: 'Default bot',
    persona: '',
    workspace: '',
    allowlist: [],
    notifyOnError: true,
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    status: 'idle',
  };
}

/**
 * deriveSlug(name) — convert a human-readable bot name into a bot id slug.
 * Lowercase; non [a-z0-9-] → '-'; collapse consecutive dashes; trim; cap at
 * 32 chars. Throws `{code:'invalid_id'}` when the result is empty.
 */
function deriveSlug(name) {
  if (typeof name !== 'string') throw err('invalid_id', 'name must be a string');
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  if (slug.length === 0) {
    throw err('invalid_id', `cannot derive slug from name: ${name}`);
  }
  return slug;
}

/**
 * Synchronous path-confinement helper. Mirrors safe_path.cjs semantics but
 * runs synchronously so the loader stays synchronous (the daemon's main
 * JSON-RPC readline already handles async wrapping at the call-site level).
 *
 * Creates the root if it doesn't exist (mkdir recursive) so the containment
 * realpath succeeds on first-write. The id regex in the public surface
 * gates `bot` to [a-z0-9-], so this is safe: a malicious caller cannot
 * smuggle `..` through the path argument.
 */
function safePathSync(botDir, requested) {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw err('invalid_path', 'path is empty or not a string');
  }
  // Ensure the root exists so realpath succeeds on first call.
  fs.mkdirSync(botDir, { recursive: true });
  const rootReal = fs.realpathSync(botDir);

  const joined = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(botDir, requested);

  // Walk up to find the deepest existing ancestor of `joined`.
  let existingParent = null;
  let probe = joined;
  while (true) {
    try {
      existingParent = fs.realpathSync(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        throw err('outside_workspace', `path escapes botDir: ${requested}`);
      }
      probe = parent;
    }
  }

  // Containment check: existingParent must be rootReal or below.
  const inside =
    existingParent === rootReal ||
    existingParent.startsWith(rootReal + path.sep);
  if (!inside) {
    throw err('outside_workspace', `path escapes botDir: ${requested}`);
  }
  return joined;
}

/**
 * readConfig(userDataDir, bot) → BotConfig | null
 * Returns null on ENOENT. Throws `{code:'invalid_config'}` for unknown keys.
 */
function readConfig(userDataDir, bot) {
  if (typeof userDataDir !== 'string' || userDataDir.length === 0) {
    throw err('invalid_path', 'userDataDir is required');
  }
  if (typeof bot !== 'string' || !ID_REGEX.test(bot)) {
    throw err('invalid_id', `bot id must match /^[a-z0-9][a-z0-9-]{0,31}$/: ${bot}`);
  }
  const botDir = path.join(userDataDir, 'bots', bot);
  const cfgPath = safePathSync(botDir, 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(cfgPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const parsed = JSON.parse(raw);
  for (const k of Object.keys(parsed)) {
    if (!ALLOWED_CONFIG_KEYS.has(k)) {
      throw err('invalid_config', `unknown config key: ${k}`);
    }
  }
  return parsed;
}

/**
 * writeConfig(userDataDir, bot, cfg) → BotConfig (the written config).
 *
 * Atomic tmp + rename (T-P4-06): writes `<botDir>/config.json.<ts>.tmp`
 * then `fs.renameSync` over the canonical path. Windows Node 14+
 * guarantees rename atomicity.
 */
function writeConfig(userDataDir, bot, cfg) {
  if (typeof userDataDir !== 'string' || userDataDir.length === 0) {
    throw err('invalid_path', 'userDataDir is required');
  }
  validateConfig(cfg);
  // Defense in depth — even if validateConfig were skipped, the id regex
  // would still gate the safePath containment.
  if (!ID_REGEX.test(bot)) {
    throw err('invalid_id', `bot id must match /^[a-z0-9][a-z0-9-]{0,31}$/: ${bot}`);
  }
  if (bot !== cfg.id) {
    throw err('invalid_config', `cfg.id (${cfg.id}) does not match bot arg (${bot})`);
  }
  const botsRoot = path.join(userDataDir, 'bots');
  const botDir = safePathSync(botsRoot, bot);
  fs.mkdirSync(botDir, { recursive: true });
  const cfgPath = safePathSync(botDir, 'config.json');

  const now = new Date().toISOString();
  const written = {
    ...cfg,
    schemaVersion: SCHEMA_VERSION,
    status: cfg.status ?? 'idle',
    createdAt: cfg.createdAt ?? now,
    updatedAt: now,
  };
  const tmp = `${cfgPath}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(written, null, 2), 'utf8');
    fs.renameSync(tmp, cfgPath);
  } catch (e) {
    // Best-effort cleanup of the tmp file on failure.
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  return written;
}

/**
 * listAllBots(userDataDir) → BotConfig[]
 * Scans `<userData>/bots/<id>/config.json`; sorts by name ascending; falls
 * back to a synthesized `default` bot when the bots dir is missing so the
 * renderer always sees at least one bot on first launch.
 */
function listAllBots(userDataDir) {
  if (typeof userDataDir !== 'string' || userDataDir.length === 0) {
    throw err('invalid_path', 'userDataDir is required');
  }
  const botsRoot = path.join(userDataDir, 'bots');
  let entries;
  try {
    entries = fs.readdirSync(botsRoot, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [synthesizeDefaultBot()];
    throw e;
  }
  const bots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const botId = entry.name;
    if (!ID_REGEX.test(botId)) continue; // skip non-conforming dirs (defensive)
    const cfg = readConfig(userDataDir, botId);
    if (!cfg) continue;
    bots.push(cfg);
  }
  if (bots.length === 0) return [synthesizeDefaultBot()];
  bots.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return bots;
}

/**
 * deleteBot(userDataDir, bot) → void
 * Removes `<userData>/bots/<bot>/` recursively. Throws `{code:'unknown_bot'}`
 * when the directory is missing.
 */
function deleteBot(userDataDir, bot) {
  if (typeof userDataDir !== 'string' || userDataDir.length === 0) {
    throw err('invalid_path', 'userDataDir is required');
  }
  if (typeof bot !== 'string' || !ID_REGEX.test(bot)) {
    throw err('invalid_id', `bot id must match /^[a-z0-9][a-z0-9-]{0,31}$/: ${bot}`);
  }
  const botsRoot = path.join(userDataDir, 'bots');
  const botDir = path.join(botsRoot, bot);
  if (!fs.existsSync(botDir)) {
    throw err('unknown_bot', `bot does not exist: ${bot}`);
  }
  fs.rmSync(botDir, { recursive: true, force: true });
}

/**
 * botExists(userDataDir, bot) → boolean
 * Used by main to short-circuit duplicate-create errors.
 */
function botExists(userDataDir, bot) {
  if (typeof userDataDir !== 'string' || userDataDir.length === 0) return false;
  if (typeof bot !== 'string' || !ID_REGEX.test(bot)) return false;
  const cfgPath = path.join(userDataDir, 'bots', bot, 'config.json');
  return fs.existsSync(cfgPath);
}

/**
 * writeConfigPatch(userDataDir, bot, patch) → BotConfig (the merged+written config).
 *
 * Merges `patch` shallowly into the existing config (preserves id, createdAt,
 * and lastRunAt — none of which are user-editable in AGENT-04), re-validates
 * the ALLOWED_CONFIG_KEYS schema allowlist on the merged object, and writes
 * atomically. Rejects `id` and `createdAt` in `patch` with deterministic codes.
 *
 * T-P4-13: bots/update must reject id changes (re-routing history to a
 * different bot would be a tampering surface).
 * T-P4-18 / Pitfall 6: lastRunAt is preserved on unrelated patches so an
 * edit doesn't reset the "last run" indicator.
 */
function writeConfigPatch(userDataDir, bot, patch) {
  if (typeof userDataDir !== 'string' || userDataDir.length === 0) {
    throw err('invalid_path', 'userDataDir is required');
  }
  if (typeof bot !== 'string' || !ID_REGEX.test(bot)) {
    throw err('invalid_id', `bot id must match /^[a-z0-9][a-z0-9-]{0,31}$/: ${bot}`);
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw err('invalid_patch', 'patch must be an object');
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'id')) {
    throw err('invalid_id_change', 'cannot change bot id via patch');
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'createdAt')) {
    throw err('created_at_immutable', 'cannot change createdAt via patch');
  }
  // Phase 6: validate cron BEFORE reading existing config so an invalid
  // expression rejects the patch with `invalid_cron` and leaves the
  // on-disk config.json untouched (T-P6-05).
  if (Object.prototype.hasOwnProperty.call(patch, 'cron')) {
    const c = patch.cron;
    if (c !== undefined && c !== '' && (typeof c !== 'string' || !CRON_REGEX.test(c))) {
      throw err('invalid_cron', `cron must be 5- or 6-field expression: ${c}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'notifyOnError')) {
    if (patch.notifyOnError !== undefined && typeof patch.notifyOnError !== 'boolean') {
      throw err('invalid_config', 'notifyOnError must be boolean');
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'scheduledPrompt')) {
    const sp = patch.scheduledPrompt;
    if (sp !== undefined && (typeof sp !== 'string' || sp.length > SCHEDULED_PROMPT_MAX)) {
      throw err('invalid_config', `scheduledPrompt must be string (max ${SCHEDULED_PROMPT_MAX} chars)`);
    }
  }
  // Phase 7 Plan 1: per-key validation for vaultPath / vaultAllow /
  // vaultDeny. Mirrors the cron / notifyOnError / scheduledPrompt guards
  // above so a renderer-supplied patch with the wrong shape is rejected
  // before any disk write.
  if (Object.prototype.hasOwnProperty.call(patch, 'vaultPath')) {
    const vp = patch.vaultPath;
    if (vp !== undefined && vp !== null && typeof vp !== 'string') {
      throw err('invalid_config', 'vaultPath must be string or null');
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'vaultAllow')) {
    const va = patch.vaultAllow;
    if (va !== undefined) {
      if (!Array.isArray(va)) {
        throw err('invalid_config', 'vaultAllow must be array of strings');
      }
      for (const g of va) {
        if (typeof g !== 'string') {
          throw err('invalid_config', 'vaultAllow entries must be strings');
        }
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'vaultDeny')) {
    const vd = patch.vaultDeny;
    if (vd !== undefined) {
      if (!Array.isArray(vd)) {
        throw err('invalid_config', 'vaultDeny must be array of strings');
      }
      for (const g of vd) {
        if (typeof g !== 'string') {
          throw err('invalid_config', 'vaultDeny entries must be strings');
        }
      }
    }
  }

  const existing = readConfig(userDataDir, bot);
  if (existing === null) {
    throw err('unknown_bot', `bot does not exist: ${bot}`);
  }

  const now = new Date().toISOString();
  // Pitfall 6: never clear lastRunAt on an unrelated patch.
  const merged = {
    ...existing,
    ...patch,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now,
    status: existing.status ?? 'idle',
    lastRunAt: existing.lastRunAt,
    lastRunExitReason: existing.lastRunExitReason,
    lastRunError: existing.lastRunError,
  };

  validateConfig(merged);

  const botsRoot = path.join(userDataDir, 'bots');
  const botDir = safePathSync(botsRoot, bot);
  fs.mkdirSync(botDir, { recursive: true });
  const cfgPath = safePathSync(botDir, 'config.json');

  const tmp = `${cfgPath}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
    fs.renameSync(tmp, cfgPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  return merged;
}

module.exports = {
  ALLOWED_CONFIG_KEYS,
  SCHEMA_VERSION,
  CRON_REGEX,
  SCHEDULED_PROMPT_MAX,
  deriveSlug,
  readConfig,
  writeConfig,
  writeConfigPatch,
  listAllBots,
  deleteBot,
  botExists,
  // Exported for unit tests
  __test__: { validateConfig, safePathSync, synthesizeDefaultBot },
};
