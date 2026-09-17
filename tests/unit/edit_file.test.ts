// Unit tests for daemon/tools/edit_file.cjs.
// Run with: `npm test`

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { call } = require_('../../daemon/tools/edit_file.cjs') as {
  call: (
    args: { path: string; find: string; replace: string },
    ctx: { workspaceRoot: string; toolCallId?: string },
  ) => Promise<{ path: string; replacements: number }>;
};

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-edit-file-'));
});

afterEach(() => {
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('edit_file', () => {
  it('replaces a single match and returns replacements=1', async () => {
    const file = path.join(workspace, 'a.txt');
    fs.writeFileSync(file, 'foo bar', 'utf8');
    const result = await call(
      { path: 'a.txt', find: 'foo', replace: 'baz' },
      { workspaceRoot: workspace },
    );
    expect(result).toEqual({ path: 'a.txt', replacements: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe('baz bar');
  });

  it('throws code=no_match when find is not present', async () => {
    const file = path.join(workspace, 'a.txt');
    fs.writeFileSync(file, 'foo bar', 'utf8');
    await expect(
      call(
        { path: 'a.txt', find: 'zzz', replace: 'q' },
        { workspaceRoot: workspace },
      ),
    ).rejects.toMatchObject({ code: 'no_match' });
    // File must be unchanged on a no_match error (no rename happens).
    expect(fs.readFileSync(file, 'utf8')).toBe('foo bar');
  });

  it('throws code=multiple_matches when find appears more than once', async () => {
    const file = path.join(workspace, 'a.txt');
    fs.writeFileSync(file, 'foo foo', 'utf8');
    await expect(
      call(
        { path: 'a.txt', find: 'foo', replace: 'bar' },
        { workspaceRoot: workspace },
      ),
    ).rejects.toMatchObject({ code: 'multiple_matches' });
    // Single-match strict — no implicit replace-all.
    expect(fs.readFileSync(file, 'utf8')).toBe('foo foo');
  });

  it('throws code=enoent when the file does not exist', async () => {
    await expect(
      call(
        { path: 'missing.txt', find: 'foo', replace: 'bar' },
        { workspaceRoot: workspace },
      ),
    ).rejects.toMatchObject({ code: 'enoent' });
  });

  it('throws code=invalid_find when find is empty', async () => {
    const file = path.join(workspace, 'a.txt');
    fs.writeFileSync(file, 'foo', 'utf8');
    await expect(
      call(
        { path: 'a.txt', find: '', replace: 'bar' },
        { workspaceRoot: workspace },
      ),
    ).rejects.toMatchObject({ code: 'invalid_find' });
  });

  it('throws code=invalid_replace when replace is not a string', async () => {
    const file = path.join(workspace, 'a.txt');
    fs.writeFileSync(file, 'foo', 'utf8');
    await expect(
      call(
        { path: 'a.txt', find: 'foo', replace: 42 as unknown as string },
        { workspaceRoot: workspace },
      ),
    ).rejects.toMatchObject({ code: 'invalid_replace' });
  });

  it('throws code=outside_workspace when path escapes via ..', async () => {
    const file = path.join(workspace, 'a.txt');
    fs.writeFileSync(file, 'foo', 'utf8');
    await expect(
      call(
        { path: '../escape.txt', find: 'foo', replace: 'bar' },
        { workspaceRoot: workspace },
      ),
    ).rejects.toMatchObject({ code: 'outside_workspace' });
  });

  it('preserves empty replace string (deletion)', async () => {
    const file = path.join(workspace, 'a.txt');
    fs.writeFileSync(file, 'foo bar', 'utf8');
    await call(
      { path: 'a.txt', find: 'foo ', replace: '' },
      { workspaceRoot: workspace },
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('bar');
  });
});