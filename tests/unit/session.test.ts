// Unit tests for src/main/sessions/jsonl.ts — per-bot session lifecycle.
//
// Phase 3 contract:
//   - appendMessage({role, content}, {bot, sessionId}) — appends to
//     <userData>/sessions/<bot>/<sessionId>.jsonl
//   - loadSession(bot, sessionId) — returns {messages, headSummary}
//
// The legacy global.jsonl file is covered separately by migration tests in
// jsonl_router.test.ts.

vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) => '<unused — LOCALBOT_USER_DATA_DIR is set>',
  },
}));

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tempDir: string;
let prevEnv: string | undefined;

async function freshImport() {
  vi.resetModules();
  const paths = await import('../../src/main/paths');
  await paths.ensureUserDataDirs();
  const mod = await import('../../src/main/sessions/jsonl');
  return mod as typeof import('../../src/main/sessions/jsonl');
}

beforeEach(() => {
  prevEnv = process.env.LOCALBOT_USER_DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-session-'));
  process.env.LOCALBOT_USER_DATA_DIR = tempDir;
});

afterEach(() => {
  if (prevEnv === undefined) {
    delete process.env.LOCALBOT_USER_DATA_DIR;
  } else {
    process.env.LOCALBOT_USER_DATA_DIR = prevEnv;
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('sessionJsonl (per-bot)', () => {
  it('loadSession returns {messages:[], headSummary:null} when the file does not exist', async () => {
    const { loadSession } = await freshImport();
    const out = await loadSession('default', 'absent');
    expect(out.messages).toEqual([]);
    expect(out.headSummary).toBeNull();
  });

  it('appendMessage then loadSession round-trips a single record', async () => {
    const { appendMessage, loadSession } = await freshImport();
    await appendMessage(
      { role: 'user', content: 'hello' },
      { bot: 'default', sessionId: 's-1' },
    );
    const out = await loadSession('default', 's-1');
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe('user');
    expect(out.messages[0].content).toBe('hello');
    expect(typeof out.messages[0].ts).toBe('number');
  });

  it('appending two messages preserves both, with non-decreasing ts', async () => {
    const { appendMessage, loadSession } = await freshImport();
    await appendMessage(
      { role: 'user', content: 'one' },
      { bot: 'default', sessionId: 's-2' },
    );
    await new Promise((res) => setTimeout(res, 2));
    await appendMessage(
      { role: 'assistant', content: 'two' },
      { bot: 'default', sessionId: 's-2' },
    );
    const out = await loadSession('default', 's-2');
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0].content).toBe('one');
    expect(out.messages[1].content).toBe('two');
    expect(out.messages[1].ts).toBeGreaterThanOrEqual(out.messages[0].ts);
  });

  it('every line has ts, role, and content; stopped/interrupted optional', async () => {
    const { appendMessage, loadSession } = await freshImport();
    const ctx = { bot: 'default', sessionId: 's-3' };
    await appendMessage({ role: 'user', content: 'ping' }, ctx);
    await appendMessage({ role: 'assistant', content: 'pong' }, ctx);
    await appendMessage({ role: 'assistant', content: 'partial', stopped: true }, ctx);
    await appendMessage({ role: 'assistant', content: 'cut', interrupted: true }, ctx);
    const out = await loadSession('default', 's-3');
    expect(out.messages).toHaveLength(4);
    for (const m of out.messages) {
      expect(typeof m.ts).toBe('number');
      expect(['user', 'assistant']).toContain(m.role);
      expect(typeof m.content).toBe('string');
    }
    expect(out.messages[2].stopped).toBe(true);
    expect(out.messages[3].interrupted).toBe(true);
  });

  it('repairs missing trailing newline on read', async () => {
    const { loadSession } = await freshImport();
    const file = path.join(tempDir, 'sessions', 'default', 's-tail.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const obj = { ts: 1700000000000, role: 'user', content: 'no-newline' };
    fs.writeFileSync(file, JSON.stringify(obj)); // no \n
    const out = await loadSession('default', 's-tail');
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toEqual(obj);
  });

  it('single trailing newline is preserved; missing trailing newline repaired on read', async () => {
    const { loadSession } = await freshImport();
    const file = path.join(tempDir, 'sessions', 'default', 's-multi.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const a = { ts: 1, role: 'user', content: 'one' };
    const b = { ts: 2, role: 'assistant', content: 'two' };
    fs.writeFileSync(file, JSON.stringify(a) + '\n'); // trailing newline
    const outA = await loadSession('default', 's-multi');
    expect(outA.messages).toHaveLength(1);
    expect(outA.messages[0]).toEqual(a);

    fs.writeFileSync(file, JSON.stringify(a) + '\n' + JSON.stringify(b));
    const outB = await loadSession('default', 's-multi');
    expect(outB.messages).toHaveLength(2);
    expect(outB.messages[0]).toEqual(a);
    expect(outB.messages[1]).toEqual(b);
  });

  it('skips malformed lines instead of throwing', async () => {
    const { loadSession } = await freshImport();
    const file = path.join(tempDir, 'sessions', 'default', 's-bad.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const good = { ts: 1, role: 'user', content: 'ok' };
    fs.writeFileSync(
      file,
      JSON.stringify(good) + '\n' + '{ not valid json\n' + JSON.stringify({ ts: 2, role: 'assistant', content: 'ok2' }) + '\n',
    );
    const out = await loadSession('default', 's-bad');
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toEqual(good);
    expect(out.messages[1].content).toBe('ok2');
  });
});
