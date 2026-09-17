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
}

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
