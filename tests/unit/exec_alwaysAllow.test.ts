// Unit tests for daemon/exec/alwaysAllow.cjs — Phase 5 Wave 1.
// Run with: npm test

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const alwaysAllow = require_('../../daemon/exec/alwaysAllow.cjs') as {
  readAlwaysAllow: (userDataDir: string, bot: string) => Array<{ command: string; useCount: number; approvedAt: string }>;
  appendAlwaysAllow: (userDataDir: string, bot: string, entry: { command: string; approvedAt?: string }) => Array<{ command: string; useCount: number; approvedAt: string }>;
  alwaysAllowPath: (userDataDir: string, bot: string) => string;
};

let userDataDir = '';
beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-alwaysallow-'));
});
afterEach(() => {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('readAlwaysAllow', () => {
  it('returns [] for missing file', () => {
    expect(alwaysAllow.readAlwaysAllow(userDataDir, 'botA')).toEqual([]);
  });
  it('returns [] for malformed JSON', () => {
    const file = alwaysAllow.alwaysAllowPath(userDataDir, 'botA');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json {{{', 'utf8');
    expect(alwaysAllow.readAlwaysAllow(userDataDir, 'botA')).toEqual([]);
  });
  it('returns [] for empty file', () => {
    const file = alwaysAllow.alwaysAllowPath(userDataDir, 'botA');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '', 'utf8');
    expect(alwaysAllow.readAlwaysAllow(userDataDir, 'botA')).toEqual([]);
  });
  it('returns [] when JSON is not an array', () => {
    const file = alwaysAllow.alwaysAllowPath(userDataDir, 'botA');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"foo": 1}', 'utf8');
    expect(alwaysAllow.readAlwaysAllow(userDataDir, 'botA')).toEqual([]);
  });
  it('filters out entries without string command field', () => {
    const file = alwaysAllow.alwaysAllowPath(userDataDir, 'botA');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([{ command: 'echo hi', useCount: 1 }, { useCount: 2 }]), 'utf8');
    const r = alwaysAllow.readAlwaysAllow(userDataDir, 'botA');
    expect(r.length).toBe(1);
    expect(r[0].command).toBe('echo hi');
  });
});

describe('appendAlwaysAllow — round-trip', () => {
  it('appends a new command and reads it back', () => {
    const out = alwaysAllow.appendAlwaysAllow(userDataDir, 'botA', { command: 'echo hello', approvedAt: '2026-01-01T00:00:00Z' });
    expect(out.length).toBe(1);
    expect(out[0].command).toBe('echo hello');
    expect(out[0].useCount).toBe(1);
    const r = alwaysAllow.readAlwaysAllow(userDataDir, 'botA');
    expect(r).toEqual(out);
  });
  it('preserves commands with newlines, quotes, unicode', () => {
    const cmd = "echo 'hi there' \n line2 \"quoted\" 中文";
    alwaysAllow.appendAlwaysAllow(userDataDir, 'botA', { command: cmd, approvedAt: '2026-01-01T00:00:00Z' });
    const r = alwaysAllow.readAlwaysAllow(userDataDir, 'botA');
    expect(r.length).toBe(1);
    expect(r[0].command).toBe(cmd);
  });
});

describe('appendAlwaysAllow — FIFO eviction at 50', () => {
  it('drops the oldest entries when over 50', () => {
    const bot = 'botA';
    for (let i = 0; i < 55; i++) {
      alwaysAllow.appendAlwaysAllow(userDataDir, bot, { command: `cmd-${i}`, approvedAt: '2026-01-01T00:00:00Z' });
    }
    const r = alwaysAllow.readAlwaysAllow(userDataDir, bot);
    expect(r.length).toBe(50);
    // First 5 dropped; kept entries are cmd-5 .. cmd-54
    expect(r[0].command).toBe('cmd-5');
    expect(r[49].command).toBe('cmd-54');
  });
});

describe('appendAlwaysAllow — useCount increments on same command', () => {
  it('bumps useCount when same command re-appended', () => {
    const bot = 'botA';
    alwaysAllow.appendAlwaysAllow(userDataDir, bot, { command: 'echo hello', approvedAt: '2026-01-01T00:00:00Z' });
    alwaysAllow.appendAlwaysAllow(userDataDir, bot, { command: 'echo hello', approvedAt: '2026-01-02T00:00:00Z' });
    const r = alwaysAllow.readAlwaysAllow(userDataDir, bot);
    expect(r.length).toBe(1);
    expect(r[0].useCount).toBe(2);
    expect(r[0].approvedAt).toBe('2026-01-02T00:00:00Z');
  });
});

describe('appendAlwaysAllow — per-bot isolation', () => {
  it('bot A file does not contain bot B commands', () => {
    alwaysAllow.appendAlwaysAllow(userDataDir, 'botA', { command: 'echo A', approvedAt: '2026-01-01T00:00:00Z' });
    alwaysAllow.appendAlwaysAllow(userDataDir, 'botB', { command: 'echo B', approvedAt: '2026-01-01T00:00:00Z' });
    const a = alwaysAllow.readAlwaysAllow(userDataDir, 'botA');
    const b = alwaysAllow.readAlwaysAllow(userDataDir, 'botB');
    expect(a.map((e) => e.command)).toEqual(['echo A']);
    expect(b.map((e) => e.command)).toEqual(['echo B']);
  });
});

describe('appendAlwaysAllow — atomic write recovery', () => {
  it('overwrites a corrupt JSON file with the new entry', () => {
    const file = alwaysAllow.alwaysAllowPath(userDataDir, 'botA');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'garbage{{{', 'utf8');
    alwaysAllow.appendAlwaysAllow(userDataDir, 'botA', { command: 'echo fresh', approvedAt: '2026-01-01T00:00:00Z' });
    const r = alwaysAllow.readAlwaysAllow(userDataDir, 'botA');
    expect(r.length).toBe(1);
    expect(r[0].command).toBe('echo fresh');
  });
});