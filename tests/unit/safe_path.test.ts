// Unit tests for daemon/tools/safe_path.cjs.
//
// Run with: npm test
//
// Each test creates a fresh temp workspace via fs.mkdtempSync and exercises
// safePath(workspaceRoot, requested). On Windows symlink tests are skipped
// because they require elevated privileges.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { safePath } = require_('../../daemon/tools/safe_path.cjs') as {
  safePath: (workspaceRoot: string, requested: string) => Promise<string>;
};

let workspace: string;
let outside: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-safe-path-ws-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-safe-path-out-'));
});

afterEach(() => {
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('safePath', () => {
  it('returns the joined absolute path for an existing file inside the workspace', async () => {
    const file = path.join(workspace, 'a.txt');
    fs.writeFileSync(file, 'hi', 'utf8');
    const resolved = await safePath(workspace, 'a.txt');
    expect(fs.realpathSync(resolved)).toBe(fs.realpathSync(file));
  });

  it('rejects `..` traversal with code outside_workspace', async () => {
    await expect(safePath(workspace, '../etc/passwd')).rejects.toMatchObject({
      code: 'outside_workspace',
    });
  });

  it('rejects an absolute path outside the workspace', async () => {
    // Use a deterministic absolute path under our `outside` temp dir that we
    // know is not inside `workspace`.
    const outsideFile = path.join(outside, 'outer.txt');
    fs.writeFileSync(outsideFile, 'secret', 'utf8');
    await expect(safePath(workspace, outsideFile)).rejects.toMatchObject({
      code: 'outside_workspace',
    });
  });

  it('accepts an absolute path that is inside the workspace', async () => {
    const insideFile = path.join(workspace, 'inner.txt');
    fs.writeFileSync(insideFile, 'ok', 'utf8');
    const resolved = await safePath(workspace, insideFile);
    expect(fs.realpathSync(resolved)).toBe(fs.realpathSync(insideFile));
  });

  it('returns the joined absolute path for a non-existent file inside the workspace', async () => {
    // The parent exists (workspace itself), so safePath should NOT throw.
    const resolved = await safePath(workspace, 'new/nested/file.txt');
    expect(path.dirname(resolved)).toBe(path.resolve(workspace, 'new', 'nested'));
  });

  it('rejects a non-existent file whose parent is outside the workspace', async () => {
    // The requested path resolves to a join that includes `..` — parent realpath fails.
    await expect(safePath(workspace, '../../outside-thing/file.txt')).rejects.toMatchObject({
      code: 'outside_workspace',
    });
  });

  it('rejects empty and non-string paths with code invalid_path', async () => {
    await expect(safePath(workspace, '')).rejects.toMatchObject({ code: 'invalid_path' });
    // @ts-expect-error — exercising runtime guard for non-string input.
    await expect(safePath(workspace, null)).rejects.toMatchObject({ code: 'invalid_path' });
    // @ts-expect-error — exercising runtime guard for non-string input.
    await expect(safePath(workspace, undefined)).rejects.toMatchObject({ code: 'invalid_path' });
  });

  // Symlink escape test — Windows requires elevation to create symlinks, so
  // skip on Windows. On POSIX this catches the `fs.realpath` rejection path.
  if (process.platform !== 'win32') {
    it('rejects a symlink that points outside the workspace', async () => {
      const trap = path.join(outside, 'secret.txt');
      fs.writeFileSync(trap, 'shhh', 'utf8');
      const linkPath = path.join(workspace, 'trap.txt');
      try {
        fs.symlinkSync(trap, linkPath);
      } catch {
        // skip if symlinks are unsupported on this fs
        return;
      }
      await expect(safePath(workspace, 'trap.txt')).rejects.toMatchObject({
        code: 'outside_workspace',
      });
    });
  }
});
