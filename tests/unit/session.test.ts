// Unit tests for src/main/sessions/jsonl.ts — appendMessage + loadSession.
// Run with: `npm test`
//
// Each test creates a fresh temp dir via fs.mkdtempSync and overrides
// LOCALBOT_USER_DATA_DIR so paths.ts resolves to that dir.

// Stub the electron module before importing the module under test.
// paths.ts calls `app.getPath('userData')` as a fallback; we never trigger
// it because LOCALBOT_USER_DATA_DIR is set, but the import must resolve.
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
  // Re-importing both `paths` (so sessionFilePath re-reads env) and `jsonl`
  // so they pick up the new LOCALBOT_USER_DATA_DIR.
  const paths = await import('../../src/main/paths');
  // The production main process calls ensureUserDataDirs before any append;
  // replicate that here so each test starts with a valid `sessions/` dir.
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
  // Best-effort cleanup of the temp tree.
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('sessionJsonl', () => {
  it('loadSession returns [] when the file does not exist', async () => {
    const { loadSession } = await freshImport();
    const out = await loadSession();
    expect(out).toEqual([]);
  });

  it('appendMessage then loadSession round-trips a single record', async () => {
    const { appendMessage, loadSession } = await freshImport();
    await appendMessage({ role: 'user', content: 'hello' });
    const out = await loadSession();
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toBe('hello');
    expect(typeof out[0].ts).toBe('number');
  });

  it('appending two messages preserves both, with non-decreasing ts', async () => {
    const { appendMessage, loadSession } = await freshImport();
    await appendMessage({ role: 'user', content: 'one' });
    // tiny delay to guarantee a strictly greater ts on Windows CI
    await new Promise((res) => setTimeout(res, 2));
    await appendMessage({ role: 'assistant', content: 'two' });
    const out = await loadSession();
    expect(out).toHaveLength(2);
    expect(out[0].content).toBe('one');
    expect(out[1].content).toBe('two');
    expect(out[1].ts).toBeGreaterThanOrEqual(out[0].ts);
  });

  it('every line has ts, role, and content; stopped/interrupted optional', async () => {
    const { appendMessage, loadSession } = await freshImport();
    await appendMessage({ role: 'user', content: 'ping' });
    await appendMessage({ role: 'assistant', content: 'pong' });
    await appendMessage({ role: 'assistant', content: 'partial', stopped: true });
    await appendMessage({ role: 'assistant', content: 'cut', interrupted: true });
    const out = await loadSession();
    expect(out).toHaveLength(4);
    for (const m of out) {
      expect(typeof m.ts).toBe('number');
      expect(['user', 'assistant']).toContain(m.role);
      expect(typeof m.content).toBe('string');
    }
    expect(out[2].stopped).toBe(true);
    expect(out[3].interrupted).toBe(true);
  });

  it('repairs missing trailing newline on read', async () => {
    const { loadSession } = await freshImport();
    // Write a JSONL file directly with no trailing newline.
    const file = path.join(tempDir, 'sessions', 'global.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const obj = { ts: 1700000000000, role: 'user', content: 'no-newline' };
    fs.writeFileSync(file, JSON.stringify(obj)); // no \n
    const out = await loadSession();
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(obj);
  });

  it('single trailing newline is preserved; missing trailing newline repaired on read', async () => {
    const { loadSession } = await freshImport();
    const file = path.join(tempDir, 'sessions', 'global.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const a = { ts: 1, role: 'user', content: 'one' };
    const b = { ts: 2, role: 'assistant', content: 'two' };
    fs.writeFileSync(file, JSON.stringify(a) + '\n'); // trailing newline
    const outA = await loadSession();
    expect(outA).toHaveLength(1);
    expect(outA[0]).toEqual(a);

    // Now write two lines WITHOUT a trailing newline and verify both are read.
    fs.writeFileSync(file, JSON.stringify(a) + '\n' + JSON.stringify(b));
    const outB = await loadSession();
    expect(outB).toHaveLength(2);
    expect(outB[0]).toEqual(a);
    expect(outB[1]).toEqual(b);
  });

  it('skips malformed lines instead of throwing', async () => {
    const { loadSession } = await freshImport();
    const file = path.join(tempDir, 'sessions', 'global.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const good = { ts: 1, role: 'user', content: 'ok' };
    fs.writeFileSync(
      file,
      JSON.stringify(good) + '\n' + '{ not valid json\n' + JSON.stringify({ ts: 2, role: 'assistant', content: 'ok2' }) + '\n',
    );
    const out = await loadSession();
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(good);
    expect(out[1].content).toBe('ok2');
  });
});
