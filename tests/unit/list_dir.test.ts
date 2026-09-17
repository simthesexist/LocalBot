// Unit tests for daemon/tools/list_dir.cjs.
// Run with: `npm test`

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { call } = require_('../../daemon/tools/list_dir.cjs') as {
  call: (
    args: { path: string },
    ctx: { workspaceRoot: string; toolCallId?: string },
  ) => Promise<{ entries: Array<{ name: string; type: 'file' | 'dir' | 'other'; size: number | null }> }>;
};

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-list-dir-'));
});

afterEach(() => {
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('list_dir', () => {
  it('returns empty entries when the workspace is empty', async () => {
    const result = await call({ path: '.' }, { workspaceRoot: workspace });
    expect(result).toEqual({ entries: [] });
  });

  it('sorts directories first, then files, both case-insensitive alphabetical', async () => {
    fs.mkdirSync(path.join(workspace, 'B'));
    fs.mkdirSync(path.join(workspace, 'A'));
    fs.writeFileSync(path.join(workspace, 'c.txt'), 'c');
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'a');

    const result = await call({ path: '.' }, { workspaceRoot: workspace });
    const typesAndNames = result.entries.map((e) => ({ type: e.type, name: e.name }));
    expect(typesAndNames).toEqual([
      { type: 'dir', name: 'A' },
      { type: 'dir', name: 'B' },
      { type: 'file', name: 'a.txt' },
      { type: 'file', name: 'c.txt' },
    ]);
  });

  it('returns size for files and null size for directories', async () => {
    fs.mkdirSync(path.join(workspace, 'sub'));
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'hello');

    const result = await call({ path: '.' }, { workspaceRoot: workspace });
    const sub = result.entries.find((e) => e.name === 'sub');
    const file = result.entries.find((e) => e.name === 'file.txt');
    expect(sub).toBeDefined();
    expect(sub!.type).toBe('dir');
    expect(sub!.size).toBeNull();
    expect(file).toBeDefined();
    expect(file!.type).toBe('file');
    expect(typeof file!.size === 'number' || file!.size === null).toBe(true);
  });

  it('throws code=enoent when the directory does not exist', async () => {
    await expect(
      call({ path: 'missing-dir' }, { workspaceRoot: workspace }),
    ).rejects.toMatchObject({ code: 'enoent' });
  });

  it('throws code=outside_workspace when path escapes via ..', async () => {
    await expect(
      call({ path: '../escape' }, { workspaceRoot: workspace }),
    ).rejects.toMatchObject({ code: 'outside_workspace' });
  });

  it('throws code=not_a_directory when the path is a file', async () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'x');
    await expect(
      call({ path: 'a.txt' }, { workspaceRoot: workspace }),
    ).rejects.toMatchObject({ code: 'not_a_directory' });
  });

  it('throws code=invalid_path when path is empty', async () => {
    await expect(
      call({ path: '' }, { workspaceRoot: workspace }),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });

  it('lists a nested directory when given a relative path', async () => {
    fs.mkdirSync(path.join(workspace, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'sub', 'deep', 'inside.txt'), 'hi');

    const result = await call({ path: 'sub/deep' }, { workspaceRoot: workspace });
    expect(result.entries.map((e) => e.name)).toEqual(['inside.txt']);
  });
});