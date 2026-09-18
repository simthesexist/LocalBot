// Per-bot per-session JSONL routing. Phase 3 tracer slice.
//
// Append-only NDJSON under <userData>/sessions/<bot>/<sessionId>.jsonl.
// Legacy `<userData>/sessions/global.jsonl` from Phase 1+2 is migrated on
// first launch to `<userData>/sessions/default/<iso-ts>.jsonl` and renamed
// to `global.jsonl.migrated` so subsequent launches skip it (Pitfall 3).

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { sessionsDir, sessionFilePathForBot, ensureSessionDir } from '../paths';
import type { ChatMessage, MessageBlock } from '../../shared/types';
import type { SummaryRecord } from '../../shared/types';

export interface SessionContext {
  bot: string;
  sessionId: string;
}

export interface AppendInput {
  role: 'user' | 'assistant';
  content: string;
  blocks?: MessageBlock[];
  stopped?: boolean;
  interrupted?: boolean;
  msgId?: string;
  /** Phase 3: head-of-file summary record (role:'summary' rows). */
  summary?: SummaryRecord;
}

const LEGACY_GLOBAL = 'global.jsonl';

let migrationRan = false;

/**
 * Derive an ISO-timestamp session id with `:` and `.` replaced by `-` so the
 * filename is filesystem-safe (e.g. `2026-09-18T10-30-00Z`).
 */
export function generateSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Append one row to <sessionsDir>/<bot>/<sessionId>.jsonl. Idempotent on
 * re-entry: parent directory is created lazily via ensureSessionDir.
 */
export async function appendMessage(input: AppendInput, ctx: SessionContext): Promise<void> {
  if (!ctx || !ctx.bot || !ctx.sessionId) {
    throw new Error('appendMessage requires ctx.bot + ctx.sessionId');
  }
  await ensureSessionDir(ctx.bot);
  const file = sessionFilePathForBot(ctx.bot, ctx.sessionId);
  const record: ChatMessage = {
    ts: Date.now(),
    role: input.role,
    content: input.content,
    blocks: input.blocks,
    stopped: input.stopped,
    interrupted: input.interrupted,
    msgId: input.msgId,
    summary: input.summary,
  };
  await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Read a session. When `sessionId` is omitted, the most recently modified
 * JSONL file under <sessionsDir>/<bot>/ is returned. The returned object
 * carries the parsed messages + the first summary record (if any) so the
 * renderer can render a summary bubble at the head of the conversation.
 */
export interface LoadSessionResult {
  messages: ChatMessage[];
  headSummary: SummaryRecord | null;
}

export async function loadSession(bot: string, sessionId?: string): Promise<LoadSessionResult> {
  if (!bot) {
    return { messages: [], headSummary: null };
  }
  const botDir = path.join(sessionsDir(), bot);
  let file: string;
  if (sessionId) {
    file = sessionFilePathForBot(bot, sessionId);
    if (!existsSync(file)) {
      return { messages: [], headSummary: null };
    }
  } else {
    // Pick the most-recent non-empty JSONL file for the bot.
    let entries: string[] = [];
    try {
      entries = await fs.readdir(botDir);
    } catch {
      return { messages: [], headSummary: null };
    }
    const jsonls = entries.filter((e) => e.endsWith('.jsonl'));
    if (jsonls.length === 0) return { messages: [], headSummary: null };
    let newest: { name: string; mtime: number } | null = null;
    for (const name of jsonls) {
      const full = path.join(botDir, name);
      const stat = await fs.stat(full);
      if (!newest || stat.mtimeMs > newest.mtime) {
        newest = { name, mtime: stat.mtimeMs };
      }
    }
    if (!newest) return { messages: [], headSummary: null };
    file = path.join(botDir, newest.name);
  }

  const text = await fs.readFile(file, 'utf8');
  const out: ChatMessage[] = [];
  let headSummary: SummaryRecord | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ChatMessage;
      // Phase 3: head-of-file summary detection.
      if (parsed.role === 'summary' && parsed.summary) {
        if (!headSummary) headSummary = parsed.summary;
        // Still push into messages so the renderer can render the summary
        // block — it knows how to skip summary rows from the bubble renderer.
        out.push(parsed);
        continue;
      }
      out.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return { messages: out, headSummary };
}

/**
 * One-shot migration: if <sessionsDir>/global.jsonl exists and contains rows,
 * copy them into <sessionsDir>/default/<iso-ts>.jsonl, then rename the
 * legacy file to global.jsonl.migrated. Subsequent launches skip the
 * migration entirely. Idempotent.
 */
export async function migrateLegacyGlobalJsonl(bot: string = 'default'): Promise<{ migrated: boolean; sessionId?: string }> {
  if (migrationRan) return { migrated: false };
  migrationRan = true;

  const legacyPath = path.join(sessionsDir(), LEGACY_GLOBAL);
  if (!existsSync(legacyPath)) return { migrated: false };

  let raw: string;
  try {
    raw = await fs.readFile(legacyPath, 'utf8');
  } catch {
    return { migrated: false };
  }
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    // Empty legacy file — just rename so subsequent launches skip.
    try { await fs.rename(legacyPath, `${legacyPath}.migrated`); } catch { /* ignore */ }
    return { migrated: false };
  }

  const sessionId = generateSessionId();
  await ensureSessionDir(bot);
  const target = sessionFilePathForBot(bot, sessionId);
  // Re-serialize each line through JSON.parse + JSON.stringify so malformed
  // rows are dropped before they poison the per-bot file.
  const rows: string[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      rows.push(JSON.stringify(obj));
    } catch {
      // skip
    }
  }
  await fs.writeFile(target, rows.join('\n') + '\n', 'utf8');
  try {
    await fs.rename(legacyPath, `${legacyPath}.migrated`);
  } catch {
    // best-effort
  }
  return { migrated: true, sessionId };
}

/**
 * Atomically prepend a summary record to the head of the session JSONL.
 * Reads the existing file (if any), concatenates the summary row first,
 * then writes via tmp+rename so the file is never partially written.
 */
export async function prependSummary(bot: string, sessionId: string, summary: SummaryRecord): Promise<void> {
  await ensureSessionDir(bot);
  const file = sessionFilePathForBot(bot, sessionId);
  let existing = '';
  if (existsSync(file)) {
    existing = await fs.readFile(file, 'utf8');
  }
  const summaryRow = JSON.stringify({
    ts: Date.now(),
    role: 'summary',
    summary,
    msgId: `summary-${Date.now()}`,
  });
  const next = `${summaryRow}\n${existing}`;
  // Atomic tmp+rename — same pattern as the daemon's memory write.
  const crypto = await import('node:crypto');
  const tmpName = `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tmpPath = path.join(path.dirname(file), tmpName);
  try {
    await fs.writeFile(tmpPath, next, 'utf8');
    await fs.rename(tmpPath, file);
  } catch (e) {
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    throw e;
  }
}