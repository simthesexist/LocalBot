// Unit tests for daemon/protocol.cjs — NDJSON framing.
// Run with: `npm test`

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const protocolMod = require_('../../daemon/protocol.cjs');
const { writeMessage, readMessage, MAX_LINE_BYTES } = protocolMod as {
  writeMessage: (stream: any, obj: unknown) => void;
  readMessage: (line: string) => unknown;
  MAX_LINE_BYTES: number;
};

describe('ndjson (smoke check)', () => {
  it('module exports are functions', () => {
    expect(typeof writeMessage).toBe('function');
    expect(typeof readMessage).toBe('function');
  });
});

function makeSpyWritable() {
  let captured = '';
  const spy = {
    write: vi.fn((chunk: string | Buffer) => {
      captured += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      return true;
    }),
  };
  return {
    spy,
    getCaptured(): string {
      return captured;
    },
  };
}

describe('ndjson', () => {
  it('writeMessage emits a single JSON line terminated by \\n', () => {
    const { spy, getCaptured } = makeSpyWritable();
    const obj = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    writeMessage(spy as any, obj);

    expect(spy.write).toHaveBeenCalledTimes(1);
    const captured = getCaptured();
    expect(captured.endsWith('\n')).toBe(true);
    expect(JSON.stringify(obj) + '\n').toBe(captured);
    // No embedded newlines inside the encoded object.
    expect(captured.slice(0, -1).includes('\n')).toBe(false);
  });

  it('readMessage parses a valid JSON line', () => {
    const line = JSON.stringify({ a: 1, b: 'two' });
    expect(readMessage(line)).toEqual({ a: 1, b: 'two' });
  });

  it('readMessage returns null on malformed input (no throw)', () => {
    expect(readMessage('not-json')).toBeNull();
    expect(readMessage('{ unterminated:')).toBeNull();
    expect(readMessage('')).toBeNull();
  });

  it('readMessage rejects lines larger than MAX_LINE_BYTES', () => {
    expect(MAX_LINE_BYTES).toBe(1024 * 1024);
    const oversized = '"' + 'a'.repeat(MAX_LINE_BYTES + 1024) + '"';
    expect(readMessage(oversized)).toBeNull();
  });

  it('two JSON-RPC error envelopes round-trip cleanly', () => {
    const errors = [
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { jsonrpc: '2.0', id: 7, error: { code: -32600, message: 'Invalid Request' } },
    ];
    for (const env of errors) {
      const { spy, getCaptured } = makeSpyWritable();
      writeMessage(spy as any, env);
      const captured = getCaptured();
      const parsed = readMessage(captured.replace(/\n$/, ''));
      expect(parsed).toEqual(env);
    }
  });

  it('preserves unicode + structural key ordering on round-trip', () => {
    const obj = { msg: 'héllo 👋', nested: { ok: true, arr: [1, 2, 3] } };
    const { spy, getCaptured } = makeSpyWritable();
    writeMessage(spy as any, obj);
    expect(readMessage(getCaptured().replace(/\n$/, ''))).toEqual(obj);
  });

  it('round-trips through a real file stream', async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'localbot-ndjson-'));
    const file = path.join(dir, 'wire.jsonl');
    const lines = [
      { kind: 'ready', version: '0.1.0' },
      { jsonrpc: '2.0', id: 1, result: { ok: true } },
      { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'method not found' } },
    ];
    const ws = fs.createWriteStream(file, { flags: 'w' });
    for (const obj of lines) writeMessage(ws, obj);
    await new Promise<void>((res) => ws.end(res));

    const text = fs.readFileSync(file, 'utf8');
    const parsed = text.split('\n').filter(Boolean).map((l) => readMessage(l));
    expect(parsed).toEqual(lines);

    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
});
