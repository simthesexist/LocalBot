// Phase 4 Wave 1: main-side read helpers for per-bot config.json.
//
// Main NEVER writes bot metadata — every mutation routes through the
// daemon's bots/{create,delete} JSON-RPC methods (which enforce the id
// regex, schema allowlist, and safePath containment on its side). These
// helpers exist purely so main can hydrate the bot list shipped with
// `app:init` without an extra IPC roundtrip on first paint, and so the
// sidebar can re-read the canonical bot list after a daemon-side update
// without trusting the renderer's in-memory copy.

import fs from 'node:fs/promises';
import path from 'node:path';
import { botsDir } from '../paths';
import { configPath } from './paths';
import type { BotConfig } from '../../shared/types';

/**
 * Read every bot's config.json under <userData>/bots/. Tolerates a
 * missing `bots/` directory (returns []). Skips directories whose
 * config.json is unreadable or fails the schema check — the daemon's
 * `bots/list` is the authoritative filter, but main keeps a best-effort
 * mirror for the first-paint hydration so a corrupt entry doesn't blank
 * the sidebar.
 *
 * The implicit `default` bot (Phase 3) is synthesized when no
 * config.json exists, matching the daemon's listAllBots behavior. This
 * keeps Phase 3 renderer code working without migration.
 */
export async function listBotsFromDisk(): Promise<BotConfig[]> {
  const root = botsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    // No bots dir → only the implicit default bot exists.
    return [defaultBot()];
  }

  const configs: BotConfig[] = [];
  for (const name of entries) {
    if (!looksLikeBotId(name)) continue; // skip files / weird entries
    const cfg = await loadConfigFromDisk(name);
    if (cfg) configs.push(cfg);
  }

  if (configs.length === 0) return [defaultBot()];

  // Always ensure `default` is present (even if the user deleted its
  // config.json somehow) — it's the Phase 3 implicit bot that everything
  // else falls back to.
  if (!configs.some((c) => c.id === 'default')) {
    configs.push(defaultBot());
  }

  configs.sort((a, b) => a.id.localeCompare(b.id));
  return configs;
}

/**
 * Read a single bot's config.json. Returns null on missing/unreadable
 * files or schema mismatch (the daemon is authoritative; main uses this
 * for first-paint hydration only).
 */
export async function loadConfigFromDisk(botId: string): Promise<BotConfig | null> {
  if (!looksLikeBotId(botId)) return null;
  try {
    const text = await fs.readFile(configPath(botId), 'utf8');
    const parsed = JSON.parse(text);
    return validateBotConfig(parsed) ? (parsed as BotConfig) : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort write. Main-side callers should never invoke this directly
 * — it's exposed only for tests + the rare seed flow. The daemon's
 * bots/create path is the canonical write that the audit chain
 * observes.
 */
export async function saveConfigToDisk(botId: string, cfg: BotConfig): Promise<void> {
  const target = configPath(botId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

/**
 * Best-effort delete. Main-side callers should never invoke this directly
 * — the daemon's bots/delete handles the audit chain. Exposed here for
 * tests + emergency cleanup hooks.
 */
export async function deleteBotFromDisk(botId: string): Promise<void> {
  if (!looksLikeBotId(botId)) return;
  try {
    await fs.rm(path.join(botsDir(), botId), { recursive: true, force: true });
  } catch {
    /* ignore — best effort */
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

const BOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function looksLikeBotId(name: string): boolean {
  return typeof name === 'string' && BOT_ID_RE.test(name);
}

function validateBotConfig(x: unknown): x is BotConfig {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return false;
  if (typeof o.persona !== 'string' || typeof o.workspace !== 'string') return false;
  if (!Array.isArray(o.allowlist)) return false;
  if (o.schemaVersion !== 1) return false;
  return true;
}

function defaultBot(): BotConfig {
  const now = new Date(0).toISOString();
  return {
    id: 'default',
    name: 'Default',
    persona: '',
    workspace: '',
    allowlist: [],
    createdAt: now,
    updatedAt: now,
    status: 'idle',
    schemaVersion: 1,
  };
}
