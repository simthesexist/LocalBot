// Append-only NDJSON audit logger, keyed by UTC day.

import fs from 'node:fs';
import path from 'node:path';
import { auditDir } from '../paths';

export interface AuditInput {
  bot: string;
  tool: string;
  params: Record<string, unknown>;
  outcome: 'ok' | 'error';
  durationMs: number;
  error?: { code: string; message: string };
  /** Optional Anthropic tool_use id; present on Phase 2+ audit lines. */
  tool_use_id?: string;
}

/**
 * Phase 3 Wave 2: explicit shapes for the new ops so call-sites get type
 * safety without re-declaring the literal `tool` string. The writer itself
 * is unchanged; the canonical shape is `{ts, bot, tool, params, outcome,
 * durationMs, error?, tool_use_id?}` (SEC-04).
 */
export interface MemoryAuditInput extends AuditInput {
  tool: 'memory.read' | 'memory.write' | 'memory.update';
}
export interface TreeAuditInput extends AuditInput {
  tool: 'tree.list' | 'tree.refresh';
}
export interface SummaryAuditInput extends AuditInput {
  tool: 'summarize' | 'summary.cancel';
}
/**
 * Phase 4 Wave 1: per-bot metadata CRUD ops. The daemon writes the
 * canonical audit line via its own appendAudit (audit.cjs); main only
 * sees synthetic audit lines when the renderer-facing `bots/<method>`
 * JSON-RPC bridge rejects early or fails before the daemon can observe
 * the call.
 */
export interface BotAuditInput extends AuditInput {
  tool: 'bots.list' | 'bots.create' | 'bots.delete';
}
export type AnyAuditInput =
  | AuditInput
  | MemoryAuditInput
  | TreeAuditInput
  | SummaryAuditInput
  | BotAuditInput;

function utcDateString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function auditFileForDay(date: string): string {
  return path.join(auditDir(), `${date}.jsonl`);
}

let cachedStream: { date: string; stream: fs.WriteStream } | null = null;

function getStream(date: string): fs.WriteStream {
  if (cachedStream && cachedStream.date === date) return cachedStream.stream;
  if (cachedStream) {
    cachedStream.stream.end();
    cachedStream = null;
  }
  const file = auditFileForDay(date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
  cachedStream = { date, stream };
  return stream;
}

export async function appendAuditLine(line: AuditInput): Promise<void> {
  const date = utcDateString();
  const record = {
    ts: new Date().toISOString(),
    ...line,
  };
  const stream = getStream(date);
  return new Promise<void>((resolve, reject) => {
    stream.write(JSON.stringify(record) + '\n', 'utf8', (err) => (err ? reject(err) : resolve()));
  });
}

export { auditDir };

process.on('exit', () => {
  if (cachedStream) {
    cachedStream.stream.end();
  }
});
