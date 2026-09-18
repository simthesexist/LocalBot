// Unit tests for per-bot JSONL routing in src/main/sessions/jsonl.ts.
//
// Phase 3 changes:
//   - File paths are now <userData>/sessions/<bot>/<sessionId>.jsonl.
//   - SessionContext is required for every append.
//   - loadSession takes (bot, sessionId?) and returns {messages, headSummary}.
//   - migrateLegacyGlobalJsonl() lifts <userData>/sessions/global.jsonl
//     rows into a fresh <bot>/<iso-ts>.jsonl (idempotent).
//   - prependSummary(bot, sessionId, summary) atomically inserts a
//     `role:'summary'` row at the head of the JSONL.
//   - generateSessionId produces filesystem-safe ISO strings.

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-router-'));
  process.env.LOCALBOT_USER_DATA_DIR = tempDir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.LOCALBOT_USER_DATA_DIR;
  else process.env.LOCALBOT_USER_DATA_DIR = prevEnv;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe('jsonl router (per-bot)', () => {
  it('appendMessage lands under <userData>/sessions/<bot>/<sessionId>.jsonl', async () => {
    const mod = await freshImport();
    await mod.appendMessage(
      { role: 'user', content: 'hello' },
      { bot: 'default', sessionId: 's-1' },
    );
    const expected = path.join(tempDir, 'sessions', 'default', 's-1.jsonl');
    expect(fs.existsSync(expected)).toBe(true);
    const lines = fs.readFileSync(expected, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).content).toBe('hello');
  });

  it('loadSession with explicit sessionId returns the messages plus null headSummary', async () => {
    const mod = await freshImport();
    await mod.appendMessage(
      { role: 'user', content: 'a' },
      { bot: 'default', sessionId: 's-x' },
    );
    await mod.appendMessage(
      { role: 'assistant', content: 'b' },
      { bot: 'default', sessionId: 's-x' },
    );
    const out = await mod.loadSession('default', 's-x');
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0].role).toBe('user');
    expect(out.messages[1].content).toBe('b');
    expect(out.headSummary).toBeNull();
  });

  it('head summary is surfaced from the first role:summary row', async () => {
    const mod = await freshImport();
    await mod.appendMessage(
      { role: 'user', content: 'one' },
      { bot: 'default', sessionId: 's-2' },
    );
    const summary = {
      summary: 'short recap',
      turnsFolded: 4,
      ranAt: new Date().toISOString(),
      msgId: 'summary-test',
    };
    await mod.prependSummary('default', 's-2', summary);
    const out = await mod.loadSession('default', 's-2');
    expect(out.headSummary).not.toBeNull();
    expect(out.headSummary!.summary).toBe('short recap');
    expect(out.headSummary!.turnsFolded).toBe(4);
  });

  it('appendMessage refuses to run without ctx', async () => {
    const mod = await freshImport();
    await expect(
      mod.appendMessage({ role: 'user', content: 'x' }),
    ).rejects.toThrow(/requires ctx\.bot \+ ctx\.sessionId/);
  });

  it('migrateLegacyGlobalJsonl copies rows into <bot>/<iso-ts>.jsonl and renames the legacy file', async () => {
    const mod = await freshImport();
    // Write a legacy global.jsonl with two rows.
    const legacyDir = path.join(tempDir, 'sessions');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacy = path.join(legacyDir, 'global.jsonl');
    const a = { ts: 1, role: 'user', content: 'legacy-1' };
    const b = { ts: 2, role: 'assistant', content: 'legacy-2' };
    fs.writeFileSync(legacy, JSON.stringify(a) + '\n' + JSON.stringify(b) + '\n');
    const out = await mod.migrateLegacyGlobalJsonl('default');
    expect(out.migrated).toBe(true);
    expect(typeof out.sessionId).toBe('string');
    // Legacy file renamed to .migrated
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(legacy + '.migrated')).toBe(true);
    // New session file exists
    const newSession = path.join(legacyDir, 'default', `${out.sessionId}.jsonl`);
    expect(fs.existsSync(newSession)).toBe(true);
    const lines = fs.readFileSync(newSession, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it('migrateLegacyGlobalJsonl is idempotent — second invocation is a no-op', async () => {
    const mod = await freshImport();
    const legacyDir = path.join(tempDir, 'sessions');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacy = path.join(legacyDir, 'global.jsonl');
    fs.writeFileSync(legacy, JSON.stringify({ ts: 1, role: 'user', content: 'one' }) + '\n');
    const first = await mod.migrateLegacyGlobalJsonl('default');
    expect(first.migrated).toBe(true);
    const second = await mod.migrateLegacyGlobalJsonl('default');
    expect(second.migrated).toBe(false);
  });

  it('prependSummary is atomic — existing rows are preserved', async () => {
    const mod = await freshImport();
    await mod.appendMessage(
      { role: 'user', content: 'first-msg' },
      { bot: 'default', sessionId: 's-3' },
    );
    await mod.prependSummary('default', 's-3', {
      summary: 'top',
      turnsFolded: 1,
      ranAt: new Date().toISOString(),
      msgId: 'summary-1',
    });
    const out = await mod.loadSession('default', 's-3');
    // messages includes both summary row + user row
    expect(out.messages.length).toBeGreaterThanOrEqual(2);
    expect(out.messages.some((m) => m.role === 'summary')).toBe(true);
    expect(out.messages.some((m) => m.role === 'user' && m.content === 'first-msg')).toBe(true);
  });

  it('generateSessionId emits a filesystem-safe ISO string', () => {
    const sid = import('../../src/main/sessions/jsonl').then((m) => m.generateSessionId());
    return sid.then((id) => {
      expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    });
  });
});
