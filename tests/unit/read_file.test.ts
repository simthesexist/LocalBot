// Unit tests for daemon/tools/read_file.cjs.
//
// Run with: npm test

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { call } = require_('../../daemon/tools/read_file.cjs') as {
  call: (args: { path: string }, ctx: { workspaceRoot: string; toolCallId?: string }) => Promise<{ content: string }>;
};

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-read-file-'));
});

afterEach(() => {
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('read_file', () => {
  it('returns the UTF-8 content of an existing file inside the workspace', async () => {
    const file = path.join(workspace, 'a.txt');
    fs.writeFileSync(file, 'world\n', 'utf8');
    const result = await call({ path: 'a.txt' }, { workspaceRoot: workspace });
    expect(result).toEqual({ content: 'world\n' });
  });

  it('throws code=enoent when the file does not exist', async () => {
    await expect(
      call({ path: 'missing.txt' }, { workspaceRoot: workspace }),
    ).rejects.toMatchObject({ code: 'enoent' });
  });

  it('throws code=outside_workspace when path escapes via ..', async () => {
    await expect(
      call({ path: '../outside.txt' }, { workspaceRoot: workspace }),
    ).rejects.toMatchObject({ code: 'outside_workspace' });
  });
});
