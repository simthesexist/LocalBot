// Phase 5 Wave 1: per-bot "always allow" list for exec_command.
//
// File shape: <userData>/always-allow/<bot>.json = array of
//   { command: string, useCount: number, approvedAt: ISOString }.
//
// Threat model coverage:
//   - T-05-05: atomic tmp + rename write so a mid-write crash never leaves
//     a partial file; malformed JSON on read returns [] (never throws);
//     no cross-bot read (per-bot file path).
//   - FIFO eviction at 50 entries keeps the file bounded (long-running bots
//     don't grow the list without bound).

const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRIES = 50;

function safeBotName(bot) {
  // Replace anything not safe for a filename with '_'. Bots are slugified by
  // bots/loader.cjs#deriveSlug (a-z0-9-) but defense-in-depth: the writer
  // must not trust callers.
  return String(bot).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'default';
}

function alwaysAllowPath(userDataDir, bot) {
  return path.join(userDataDir, 'always-allow', `${safeBotName(bot)}.json`);
}

function readAlwaysAllow(userDataDir, bot) {
  if (!userDataDir || !bot) return [];
  const file = alwaysAllowPath(userDataDir, bot);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e.command === 'string');
  } catch {
    return [];
  }
}

function appendAlwaysAllow(userDataDir, bot, entry) {
  if (!userDataDir || !bot || !entry || typeof entry.command !== 'string') {
    return readAlwaysAllow(userDataDir, bot);
  }
  const file = alwaysAllowPath(userDataDir, bot);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const existing = readAlwaysAllow(userDataDir, bot);
  // Increment useCount for an exact-match command; otherwise append a new entry.
  const idx = existing.findIndex((e) => e.command === entry.command);
  if (idx >= 0) {
    const cur = existing[idx];
    existing[idx] = {
      command: cur.command,
      useCount: (typeof cur.useCount === 'number' ? cur.useCount : 0) + 1,
      approvedAt: entry.approvedAt || new Date().toISOString(),
    };
  } else {
    existing.push({
      command: entry.command,
      useCount: 1,
      approvedAt: entry.approvedAt || new Date().toISOString(),
    });
  }
  // FIFO eviction: drop oldest if over cap.
  let trimmed = existing;
  if (existing.length > MAX_ENTRIES) {
    trimmed = existing.slice(existing.length - MAX_ENTRIES);
  }

  // Atomic tmp + rename. The tmp lives next to the destination so the rename
  // is on the same filesystem (cross-device rename would throw EXDEV).
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return trimmed;
}

module.exports = {
  readAlwaysAllow,
  appendAlwaysAllow,
  alwaysAllowPath,
  __test__: { safeBotName, MAX_ENTRIES },
};