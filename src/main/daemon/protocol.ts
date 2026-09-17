// NDJSON framing helpers used by main to talk to the daemon.

import { Writable } from 'node:stream';

const MAX_LINE_BYTES = 1024 * 1024; // 1 MiB

export function writeMessage(stream: Writable, obj: unknown): void {
  const line = JSON.stringify(obj) + '\n';
  stream.write(line);
}

export function readMessage(line: string): object | null {
  if (!line || line.length > MAX_LINE_BYTES) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
