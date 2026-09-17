// Unit tests for daemon/tools/write_file.cjs.
// Run with: `npm test`

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { call } = require_('../../daemon/tools/write_file.cjs') as {
  call: (
    args: { path: string; content: string },
    ctx: { workspaceRoot: string; toolCallId?: string },
  ) => Promise<{ path: string; bytesWritten: number }>;
};

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-write-file-'));
});

afterEach(() => {
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('write_file', () => {
  it('writes UTF-8 content to a new file and returns bytesWritten', async () => {
    const result = await call(
      { path: 'hello.txt', content: 'world\n' },
      { workspaceRoot: workspace },
    );
    expect(result).toEqual({ path: 'hello.txt', bytesWritten: 6 });
    const onDisk = fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8');
    expect(onDisk).toBe('world\n');
  });

  it('creates nested parent directories as needed', async () => {
    const result = await call(
      { path: 'a/b/c/deep.txt', content: 'x' },
      { workspaceRoot: workspace },
    );
    expect(result.bytesWritten).toBe(1);
    expect(fs.readFileSync(path.join(workspace, 'a', 'b', 'c', 'deep.txt'), 'utf8')).toBe('x');
  });

  it('throws code=outside_workspace when path escapes via ..', async () => {
    await expect(
      call(
        { path: '../outside.txt', content: 'nope' },
        { workspaceRoot: workspace },
      ),
    ).rejects.toMatchObject({ code: 'outside_workspace' });
  });

  it('throws code=invalid_content when content is not a string', async () => {
    await expect(
      call(
        { path: 'a.txt', content: 42 as unknown as string },
        { workspaceRoot: workspace },
      ),
    ).rejects.toMatchObject({ code: 'invalid_content' });
  });

  it('is idempotent: identical second write leaves the file byte-identical', async () => {
    await call(
      { path: 'dup.txt', content: 'same\n' },
      { workspaceRoot: workspace },
    );
    const first = fs.readFileSync(path.join(workspace, 'dup.txt'), 'utf8');
    const second = await call(
      { path: 'dup.txt', content: 'same\n' },
      { workspaceRoot: workspace },
    );
    expect(second.bytesWritten).toBe(5);
    expect(fs.readFileSync(path.join(workspace, 'dup.txt'), 'utf8')).toBe(first);
  });

  it('overwrites an existing file with new content', async () => {
    fs.writeFileSync(path.join(workspace, 'exists.txt'), 'old', 'utf8');
    const result = await call(
      { path: 'exists.txt', content: 'new' },
      { workspaceRoot: workspace },
    );
    expect(result.bytesWritten).toBe(3);
    expect(fs.readFileSync(path.join(workspace, 'exists.txt'), 'utf8')).toBe('new');
  });
});