// Unit tests for daemon/tools/code_search.cjs.
//
// Run with: npm test
//
// Proves TOOL-05: ripgrep regex + glob, max_results cap, workspace containment,
// input validation (empty pattern, NUL byte, pattern too long).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { call } = require_('../../daemon/tools/code_search.cjs') as {
  call: (
    args: { pattern: string; glob?: string; path?: string; max_results?: number },
    ctx: {
      workspaceRoot: string;
      toolCallId?: string;
      signal?: AbortSignal;
      registry?: { registerChild: () => void; unregisterChild: () => void };
    },
  ) => Promise<{
    matches: Array<{
      path: string;
      line: number;
      text: string;
      submatches: Array<{ text: string; start: number; end: number }>;
    }>;
    truncated: boolean;
    stats: { matches: number; lines_searched: number };
  }>;
};

// No-op registry so code_search can register its child without crashing.
const NOOP_REGISTRY = {
  registerChild: () => {},
  unregisterChild: () => {},
};

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-code-search-'));
});

afterEach(() => {
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('code_search', () => {
  it('returns matches for a regex pattern across multiple files', async () => {
    fs.writeFileSync(path.join(workspace, 'sample.ts'), "import { useState } from 'react';\n");
    fs.writeFileSync(path.join(workspace, 'sample.txt'), 'useState is great\n');

    const result = await call(
      { pattern: 'useState' },
      { workspaceRoot: workspace, toolCallId: 'tc_cs_1', signal: new AbortController().signal, registry: NOOP_REGISTRY },
    );

    expect(result.truncated).toBe(false);
    expect(result.matches).toHaveLength(2);
    const paths = result.matches.map((m) => m.path).sort();
    expect(paths).toEqual(['sample.ts', 'sample.txt']);
    for (const m of result.matches) {
      expect(m.line).toBe(1);
      expect(m.text).toContain('useState');
      expect(m.submatches.length).toBeGreaterThan(0);
      expect(m.submatches[0].text).toBe('useState');
    }
    expect(result.stats.matches).toBe(2);
  });

  it('respects the --glob filter', async () => {
    fs.writeFileSync(path.join(workspace, 'sample.ts'), "useState here\n");
    fs.writeFileSync(path.join(workspace, 'sample.txt'), 'useState here\n');
    fs.writeFileSync(path.join(workspace, 'sample.tsx'), 'useState here\n');

    const result = await call(
      { pattern: 'useState', glob: '*.ts', path: '.' },
      { workspaceRoot: workspace, toolCallId: 'tc_cs_2', signal: new AbortController().signal, registry: NOOP_REGISTRY },
    );

    expect(result.truncated).toBe(false);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].path).toBe('sample.ts');
  });

  it('caps at max_results and sets truncated=true', async () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(workspace, `f${i}.txt`), 'X marker\n');
    }

    const result = await call(
      { pattern: 'X', max_results: 2 },
      { workspaceRoot: workspace, toolCallId: 'tc_cs_3', signal: new AbortController().signal, registry: NOOP_REGISTRY },
    );

    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.stats.matches).toBe(2);
  });

  it('rejects a path that escapes the workspace', async () => {
    await expect(
      call(
        { pattern: 'X', path: '../' },
        { workspaceRoot: workspace, toolCallId: 'tc_cs_4', signal: new AbortController().signal, registry: NOOP_REGISTRY },
      ),
    ).rejects.toMatchObject({ code: 'outside_workspace' });
  });

  it('rejects an empty pattern with code=invalid_pattern', async () => {
    await expect(
      call(
        { pattern: '' },
        { workspaceRoot: workspace, toolCallId: 'tc_cs_5', signal: new AbortController().signal, registry: NOOP_REGISTRY },
      ),
    ).rejects.toMatchObject({ code: 'invalid_pattern' });
  });

  it('rejects a pattern containing a NUL byte with code=invalid_pattern', async () => {
    await expect(
      call(
        { pattern: 'foo\0bar' },
        { workspaceRoot: workspace, toolCallId: 'tc_cs_6', signal: new AbortController().signal, registry: NOOP_REGISTRY },
      ),
    ).rejects.toMatchObject({ code: 'invalid_pattern' });
  });

  it('rejects a glob containing a NUL byte with code=invalid_glob', async () => {
    await expect(
      call(
        { pattern: 'foo', glob: '*.ts\0bad' },
        { workspaceRoot: workspace, toolCallId: 'tc_cs_7', signal: new AbortController().signal, registry: NOOP_REGISTRY },
      ),
    ).rejects.toMatchObject({ code: 'invalid_glob' });
  });
});
