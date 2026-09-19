// Unit tests for daemon/tools/vault_search.cjs.
//
// Run with: npm test
//
// Phase 7 Plan 2: covers the deny-wins glob pipeline integration per
// match, the --glob filter, the max_results cap + truncated flag,
// vault_not_configured, pattern_too_long, invalid_pattern, invalid_glob,
// and the args audit minimization. Uses the real `@vscode/ripgrep`
// binary against a mkdtemp vault root (same pattern as
// tests/unit/code_search.test.ts).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { call } = require_('../../daemon/tools/vault_search.cjs') as {
  call: (
    args: { pattern: string; glob?: string; max_results?: number },
    ctx: {
      vaultRoot?: string;
      globalDeny?: string[];
      vaultDeny?: string[];
      vaultAllow?: string[];
      toolCallId?: string;
      signal?: AbortSignal;
      registry?: { registerChild: () => void; unregisterChild: () => void };
    },
  ) => Promise<{
    matches: Array<{ path: string; line: number; text: string }>;
    truncated: boolean;
    count: number;
  }>;
};

const NOOP_REGISTRY = {
  registerChild: () => {},
  unregisterChild: () => {},
};

let vaultRoot: string;

beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-vault-search-'));
  fs.mkdirSync(path.join(vaultRoot, 'Projects'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'Daily'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'Private'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'Projects', 'foo.md'), 'project note with foo\n', 'utf8');
  fs.writeFileSync(path.join(vaultRoot, 'Projects', 'bar.md'), 'another note with foo\n', 'utf8');
  fs.writeFileSync(path.join(vaultRoot, 'Daily', '2026-09-19.md'), 'daily foo line\n', 'utf8');
  fs.writeFileSync(path.join(vaultRoot, 'Private', 'secret.md'), 'shhh foo\n', 'utf8');
});

afterEach(() => {
  try {
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('vault.search — happy path', () => {
  it('returns matches for a simple pattern with vault-relative paths', async () => {
    const result = await call(
      { pattern: 'foo' },
      {
        vaultRoot,
        globalDeny: [],
        vaultDeny: [],
        vaultAllow: ['Projects/**', 'Daily/**', 'Private/**'],
        toolCallId: 'tc_vs_1',
        signal: new AbortController().signal,
        registry: NOOP_REGISTRY,
      },
    );

    expect(result.truncated).toBe(false);
    expect(result.count).toBeGreaterThanOrEqual(2);
    const paths = result.matches.map((m) => m.path).sort();
    expect(paths).toContain('Projects/bar.md');
    expect(paths).toContain('Projects/foo.md');
    for (const m of result.matches) {
      expect(m.line).toBeGreaterThan(0);
      expect(m.text).not.toMatch(/\n$/);
      // Result paths are always vault-relative (forward-slash normalized).
      expect(m.path).not.toMatch(/^[A-Za-z]:/);
      expect(m.path).not.toMatch(/\\/);
    }
  });
});

describe('vault.search — glob pipeline enforcement', () => {
  it('filters out matches whose path matches globalDeny', async () => {
    const result = await call(
      { pattern: 'foo' },
      {
        vaultRoot,
        globalDeny: ['Private/**'],
        vaultDeny: [],
        vaultAllow: ['**/*'],
        toolCallId: 'tc_vs_2',
        signal: new AbortController().signal,
        registry: NOOP_REGISTRY,
      },
    );

    const paths = result.matches.map((m) => m.path);
    expect(paths).not.toContain('Private/secret.md');
    expect(paths.length).toBeGreaterThan(0);
  });

  it('filters out matches whose path is not in vaultAllow', async () => {
    const result = await call(
      { pattern: 'foo' },
      {
        vaultRoot,
        globalDeny: [],
        vaultDeny: [],
        vaultAllow: ['Projects/**'],
        toolCallId: 'tc_vs_3',
        signal: new AbortController().signal,
        registry: NOOP_REGISTRY,
      },
    );

    const paths = result.matches.map((m) => m.path);
    expect(paths).toContain('Projects/foo.md');
    expect(paths).not.toContain('Daily/2026-09-19.md');
    expect(paths).not.toContain('Private/secret.md');
  });
});

describe('vault.search — max_results cap', () => {
  it('caps at max_results and marks truncated=true', async () => {
    // Drop 8 extra files so a max_results=2 cap is reliably exercised.
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(path.join(vaultRoot, 'Projects', `f${i}.md`), `foo line ${i}\n`, 'utf8');
    }

    const result = await call(
      { pattern: 'foo', max_results: 2 },
      {
        vaultRoot,
        globalDeny: [],
        vaultDeny: [],
        vaultAllow: ['Projects/**'],
        toolCallId: 'tc_vs_4',
        signal: new AbortController().signal,
        registry: NOOP_REGISTRY,
      },
    );

    expect(result.matches.length).toBe(2);
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
  });
});

describe('vault.search — glob filter', () => {
  it('respects the --glob filter from args', async () => {
    fs.writeFileSync(path.join(vaultRoot, 'Projects', 'notes.txt'), 'foo in a text file\n', 'utf8');

    const result = await call(
      { pattern: 'foo', glob: '*.md' },
      {
        vaultRoot,
        globalDeny: [],
        vaultDeny: [],
        vaultAllow: ['Projects/**'],
        toolCallId: 'tc_vs_g',
        signal: new AbortController().signal,
        registry: NOOP_REGISTRY,
      },
    );

    const paths = result.matches.map((m) => m.path);
    expect(paths).toContain('Projects/foo.md');
    expect(paths).not.toContain('Projects/notes.txt');
  });
});

describe('vault.search — input validation', () => {
  it('throws code:vault_not_configured when ctx.vaultRoot is missing', async () => {
    await expect(
      call(
        { pattern: 'foo' },
        {
          globalDeny: [],
          vaultDeny: [],
          vaultAllow: ['Projects/**'],
          toolCallId: 'tc_vs_5',
          signal: new AbortController().signal,
          registry: NOOP_REGISTRY,
        },
      ),
    ).rejects.toMatchObject({ code: 'vault_not_configured' });
  });

  it('throws code:pattern_too_long for a > 1 MiB pattern', async () => {
    const big = 'a'.repeat(1024 * 1024 + 1);
    await expect(
      call(
        { pattern: big },
        {
          vaultRoot,
          vaultAllow: ['**/*'],
          toolCallId: 'tc_vs_6',
          signal: new AbortController().signal,
          registry: NOOP_REGISTRY,
        },
      ),
    ).rejects.toMatchObject({ code: 'pattern_too_long' });
  });

  it('throws code:invalid_pattern for NUL byte in pattern', async () => {
    await expect(
      call(
        { pattern: 'foo\0bar' },
        {
          vaultRoot,
          vaultAllow: ['**/*'],
          toolCallId: 'tc_vs_7',
          signal: new AbortController().signal,
          registry: NOOP_REGISTRY,
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_pattern' });
  });

  it('throws code:invalid_glob for NUL byte in glob', async () => {
    await expect(
      call(
        { pattern: 'foo', glob: '*.md\0bad' },
        {
          vaultRoot,
          vaultAllow: ['**/*'],
          toolCallId: 'tc_vs_8',
          signal: new AbortController().signal,
          registry: NOOP_REGISTRY,
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_glob' });
  });
});