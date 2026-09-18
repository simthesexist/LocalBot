// Unit tests for daemon/runs/jsonl.cjs — per-bot run history NDJSON writer.
// Run with: npm test
//
// Phase 4 Wave 2: covers appendRun (atomic per-bot mutex) + listRuns
// (newest-first ordering, limit parameter, ENOENT tolerance).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const runs = require_('../../daemon/runs/jsonl.cjs') as {
  appendRun: (userDataDir: string, bot: string, record: Record<string, unknown>) => Promise<void>;
  listRuns: (userDataDir: string, bot: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
};

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-bot-runs-'));
}

describe('appendRun — NDJSON per-bot', () => {
  it('writes one JSONL line per call', async () => {
    const dir = mkTmp();
    try {
      await runs.appendRun(dir, 'bot-a', { ts: 't1', runId: 'r1', trigger: 'manual', durationMs: 100, exitReason: 'completed', messageCount: 2 });
      await runs.appendRun(dir, 'bot-a', { ts: 't2', runId: 'r2', trigger: 'manual', durationMs: 200, exitReason: 'completed', messageCount: 3 });
      const file = path.join(dir, 'runs', 'bot-a', 'bot.jsonl');
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]).runId).toBe('r1');
      expect(JSON.parse(lines[1]).runId).toBe('r2');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('serializes concurrent appends via per-bot mutex', async () => {
    const dir = mkTmp();
    try {
      const writes = Array.from({ length: 10 }, (_, i) =>
        runs.appendRun(dir, 'bot-b', { ts: `t${i}`, runId: `r${i}`, trigger: 'manual', durationMs: i, exitReason: 'completed', messageCount: 1 }),
      );
      await Promise.all(writes);
      const file = path.join(dir, 'runs', 'bot-b', 'bot.jsonl');
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      expect(lines.length).toBe(10);
      // Order is preserved (mutex serializes).
      for (let i = 0; i < 10; i++) {
        expect(JSON.parse(lines[i]).runId).toBe(`r${i}`);
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('isolates different bots (no cross-bot mutex contention)', async () => {
    const dir = mkTmp();
    try {
      await Promise.all([
        runs.appendRun(dir, 'bot-x', { ts: '1', runId: 'x1', trigger: 'manual', durationMs: 0, exitReason: 'completed', messageCount: 1 }),
        runs.appendRun(dir, 'bot-y', { ts: '2', runId: 'y1', trigger: 'manual', durationMs: 0, exitReason: 'completed', messageCount: 1 }),
      ]);
      expect(fs.existsSync(path.join(dir, 'runs', 'bot-x', 'bot.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'runs', 'bot-y', 'bot.jsonl'))).toBe(true);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('listRuns — newest-first reader', () => {
  it('returns rows in newest-first order', async () => {
    const dir = mkTmp();
    try {
      await runs.appendRun(dir, 'bot-z', { ts: '2026-01-01T00:00:00.000Z', runId: 'r1', trigger: 'manual', durationMs: 0, exitReason: 'completed', messageCount: 1 });
      await runs.appendRun(dir, 'bot-z', { ts: '2026-01-02T00:00:00.000Z', runId: 'r2', trigger: 'manual', durationMs: 0, exitReason: 'completed', messageCount: 1 });
      await runs.appendRun(dir, 'bot-z', { ts: '2026-01-03T00:00:00.000Z', runId: 'r3', trigger: 'manual', durationMs: 0, exitReason: 'completed', messageCount: 1 });
      const rows = await runs.listRuns(dir, 'bot-z');
      expect(rows.map((r) => r.runId)).toEqual(['r3', 'r2', 'r1']);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('respects limit parameter', async () => {
    const dir = mkTmp();
    try {
      for (let i = 0; i < 5; i++) {
        await runs.appendRun(dir, 'lim', { ts: `t${i}`, runId: `r${i}`, trigger: 'manual', durationMs: 0, exitReason: 'completed', messageCount: 1 });
      }
      const rows = await runs.listRuns(dir, 'lim', 2);
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.runId)).toEqual(['r4', 'r3']);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('returns [] for a missing file (ENOENT tolerance)', async () => {
    const dir = mkTmp();
    try {
      const rows = await runs.listRuns(dir, 'nonexistent');
      expect(rows).toEqual([]);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('RunRecord shape', () => {
  it('preserves the canonical schema keys', async () => {
    const dir = mkTmp();
    try {
      const rec = {
        ts: '2026-09-18T10:00:00.000Z',
        runId: 'uuid-1',
        trigger: 'manual' as const,
        durationMs: 1234,
        exitReason: 'cancelled' as const,
        messageCount: 5,
        error: { code: 'aborted', message: 'cancelled' },
      };
      await runs.appendRun(dir, 'shape', rec);
      const rows = await runs.listRuns(dir, 'shape');
      expect(rows.length).toBe(1);
      const r = rows[0];
      expect(typeof r.ts).toBe('string');
      expect(typeof r.runId).toBe('string');
      expect(r.trigger).toBe('manual');
      expect(typeof r.durationMs).toBe('number');
      expect(r.exitReason).toBe('cancelled');
      expect(typeof r.messageCount).toBe('number');
      expect((r.error as { code: string }).code).toBe('aborted');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
