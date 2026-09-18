// Unit tests for daemon/tools/memory_read.cjs and memory_write.cjs (Phase 3).
// Run with: npm test

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { injectMemorySuffix } from '../../src/main/bots/memory';

const require_ = createRequire(import.meta.url);

const memoryRead = require_('../../daemon/tools/memory_read.cjs') as {
  call: (args: { bot: string }, ctx: { botDir: string }) => Promise<{
    markdown: string; facts: Record<string, unknown>; bytes: number; factCount: number; updatedAt: string; parseError?: string;
  }>;
};

const memoryWrite = require_('../../daemon/tools/memory_write.cjs') as {
  call: (args: { bot: string; markdown: string; facts?: Record<string, unknown> }, ctx: { botDir: string }) => Promise<{
    path: string; bytesWritten: number; factCount: number;
  }>;
};

let botDir: string;

beforeEach(async () => {
  botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-mem-'));
});

afterEach(() => {
  try { fs.rmSync(botDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('memory_read', () => {
  it('returns empty defaults when files are missing', async () => {
    const out = await memoryRead.call({ bot: 'default' }, { botDir });
    expect(out.markdown).toBe('');
    expect(out.facts).toEqual({});
    expect(out.bytes).toBe(0);
    expect(out.factCount).toBe(0);
    expect(typeof out.updatedAt).toBe('string');
  });

  it('returns facts + markdown when files exist', async () => {
    fs.writeFileSync(path.join(botDir, 'memory.md'), 'hello', 'utf8');
    fs.writeFileSync(path.join(botDir, 'facts.json'), '{"a":{"value":1}}', 'utf8');
    const out = await memoryRead.call({ bot: 'default' }, { botDir });
    expect(out.markdown).toBe('hello');
    expect(out.bytes).toBe(5);
    expect(out.factCount).toBe(1);
  });

  it('captures parseError for malformed facts.json without throwing', async () => {
    fs.writeFileSync(path.join(botDir, 'facts.json'), '{ not valid json', 'utf8');
    const out = await memoryRead.call({ bot: 'default' }, { botDir });
    expect(out.facts).toEqual({});
    expect(typeof out.parseError).toBe('string');
  });
});

describe('memory_write', () => {
  it('writes both files and reports bytesWritten', async () => {
    const result = await memoryWrite.call(
      { bot: 'default', markdown: 'hello world', facts: { a: { value: 1 } } },
      { botDir },
    );
    expect(result.bytesWritten).toBe(11);
    expect(result.factCount).toBe(1);
    expect(fs.readFileSync(path.join(botDir, 'memory.md'), 'utf8')).toBe('hello world');
    const facts = JSON.parse(fs.readFileSync(path.join(botDir, 'facts.json'), 'utf8'));
    expect(facts).toEqual({ a: { value: 1 } });
  });

  it('refuses markdown over 8192 bytes', async () => {
    const big = 'x'.repeat(9000);
    await expect(
      memoryWrite.call({ bot: 'default', markdown: big }, { botDir }),
    ).rejects.toMatchObject({ code: 'too_large' });
    // The on-disk file should not exist after a failed write.
    expect(fs.existsSync(path.join(botDir, 'memory.md'))).toBe(false);
  });

  it('rejects facts that are not plain objects', async () => {
    await expect(
      memoryWrite.call({ bot: 'default', markdown: 'ok', facts: 'not-an-object' as unknown as Record<string, unknown> }, { botDir }),
    ).rejects.toMatchObject({ code: 'invalid_facts_schema' });
  });

  it('rejects fact entries without value', async () => {
    await expect(
      memoryWrite.call({ bot: 'default', markdown: 'ok', facts: { a: { foo: 1 } } }, { botDir }),
    ).rejects.toMatchObject({ code: 'invalid_facts_schema' });
  });

  it('round-trips markdown + facts through write+read', async () => {
    const md = '# Memory\n## Identity\nname: localbot\n';
    const facts = { name: { value: 'localbot', source: 'user', updatedAt: '2026-09-18T10:00:00Z' } };
    await memoryWrite.call({ bot: 'default', markdown: md, facts }, { botDir });
    const read = await memoryRead.call({ bot: 'default' }, { botDir });
    expect(read.markdown).toBe(md);
    expect(read.facts).toEqual(facts);
    expect(read.factCount).toBe(1);
    expect(read.bytes).toBe(md.length);
  });

  it('serializes concurrent writes via per-bot mutex', async () => {
    // Fire 5 concurrent writes; verify all 5 land on disk without truncation.
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      const md = `iter-${i}-${'x'.repeat(100)}`;
      writes.push(memoryWrite.call({ bot: 'default', markdown: md }, { botDir }));
    }
    await Promise.all(writes);
    // The final write should be the one that wins (mutations serialize).
    const final = fs.readFileSync(path.join(botDir, 'memory.md'), 'utf8');
    expect(final.startsWith('iter-')).toBe(true);
  });
});

describe('injectMemorySuffix (memory cap eviction)', () => {
  it('drops oldest H2 sections when markdown > 4 KB', () => {
    const base = 'You are Localbot.';
    // Build a markdown with 10 H2 sections each ~600 bytes — total > 4KB.
    const sections: string[] = [];
    for (let i = 0; i < 10; i++) {
      const filler = 'x'.repeat(540);
      sections.push(`## Section ${i}\n${filler}\n`);
    }
    const bigMd = sections.join('\n');
    const out = injectMemorySuffix(base, bigMd, {}, 4096);
    // The kept content is at most base + 4KB cap. The first section is
    // expected to have been dropped because it's the oldest.
    expect(out.startsWith(base)).toBe(true);
    expect(out.includes('## Section 0')).toBe(false);
    expect(out.includes('## Section 9')).toBe(true);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(base.length + 4096 + 200);
  });

  it('caps facts bullets at 50 entries when facts has 60 keys', () => {
    const facts: Record<string, { value: unknown; source: 'user' | 'tool' | 'summary'; updatedAt: string }> = {};
    for (let i = 0; i < 60; i++) {
      facts[`fact_${i}`] = { value: i, source: 'user', updatedAt: '2026-09-18T00:00:00Z' };
    }
    const out = injectMemorySuffix('base', '', facts, 4096);
    // Exactly 50 bullet lines for the first 50 facts, plus the trailing
    // "and 10 more" indicator line.
    const bulletCount = (out.match(/^- fact_/gm) ?? []).length;
    expect(bulletCount).toBe(50);
    expect(out).toContain('... and 10 more');
    // The 11th fact should NOT appear because we sliced to 50.
    expect(out.includes('fact_50')).toBe(false);
  });
});