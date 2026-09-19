// Unit tests for daemon/tools/vault_write.cjs.
// Run with: npm test
//
// Phase 7 Plan 1: covers Agents/<bot>/ containment (Pitfall 6 + T-7-03),
// safe_path layer 1 realpath escape (T-7-01), atomic tmp+rename
// (Pitfall 6), mkdir -p recursive parent dirs, ctx validation, and
// cross-bot isolation (T-7-03).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { call } = require_('../../daemon/tools/vault_write.cjs') as {
  call: (
    args: { path: string; content: string },
    ctx: {
      vaultRoot?: string;
      globalDeny?: string[];
      vaultDeny?: string[];
      vaultAllow?: string[];
      bot?: string;
    },
  ) => Promise<{ path: string; bytesWritten: number }>;
};

let vaultRoot: string;
beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-vault-write-'));
  fs.mkdirSync(path.join(vaultRoot, 'Agents', 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'Agents', 'beta'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'Projects'), { recursive: true });
});
afterEach(() => {
  try { fs.rmSync(vaultRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('vault.write — happy path', () => {
  it('writes a new file inside Agents/<bot>/ and returns vault-relative path + bytesWritten', async () => {
    const result = await call(
      { path: 'Agents/alpha/note.md', content: 'hello\n' },
      { vaultRoot, bot: 'alpha' },
    );
    expect(result.path).toBe('Agents/alpha/note.md');
    expect(result.bytesWritten).toBe(6);
    expect(fs.readFileSync(path.join(vaultRoot, 'Agents', 'alpha', 'note.md'), 'utf8')).toBe('hello\n');
  });

  it('overwrites an existing file inside Agents/<bot>/', async () => {
    fs.writeFileSync(path.join(vaultRoot, 'Agents', 'alpha', 'existing.md'), 'old', 'utf8');
    const result = await call(
      { path: 'Agents/alpha/existing.md', content: 'new' },
      { vaultRoot, bot: 'alpha' },
    );
    expect(result.bytesWritten).toBe(3);
    expect(fs.readFileSync(path.join(vaultRoot, 'Agents', 'alpha', 'existing.md'), 'utf8')).toBe('new');
  });

  it('creates parent directories recursively (mkdir -p)', async () => {
    const result = await call(
      { path: 'Agents/alpha/sub/dir/note.md', content: 'deep' },
      { vaultRoot, bot: 'alpha' },
    );
    expect(result.path).toBe('Agents/alpha/sub/dir/note.md');
    expect(fs.existsSync(path.join(vaultRoot, 'Agents', 'alpha', 'sub', 'dir', 'note.md'))).toBe(true);
  });
});

describe('vault.write — Agents/<bot>/ containment (Pitfall 6 + T-7-03)', () => {
  it('refuses a write to Projects/ with code:write_outside_agents', async () => {
    await expect(
      call(
        { path: 'Projects/foo.md', content: 'x' },
        { vaultRoot, bot: 'alpha' },
      ),
    ).rejects.toMatchObject({ code: 'write_outside_agents' });
  });

  it('refuses a write to a DIFFERENT bot\'s folder (cross-bot isolation)', async () => {
    await expect(
      call(
        { path: 'Agents/beta/note.md', content: 'x' },
        { vaultRoot, bot: 'alpha' },
      ),
    ).rejects.toMatchObject({ code: 'write_outside_agents' });
  });

  it('refuses a ../ escape even when the resolved path lives inside vaultRoot', async () => {
    // safe_path layer 1 catches ../ traversal before the containment check.
    await expect(
      call(
        { path: 'Agents/alpha/../../etc/passwd', content: 'x' },
        { vaultRoot, bot: 'alpha' },
      ),
    ).rejects.toMatchObject({ code: 'write_outside_agents' });
  });

  it('refuses a path that points to the vault root itself', async () => {
    // path.relative(agentsReal, resolved) === '' is treated as outside.
    await expect(
      call(
        { path: 'Agents/alpha', content: 'x' },
        { vaultRoot, bot: 'alpha' },
      ),
    ).rejects.toMatchObject({ code: 'write_outside_agents' });
  });
});

describe('vault.write — ctx validation', () => {
  it('throws code:vault_not_configured when ctx.vaultRoot is undefined', async () => {
    await expect(
      call(
        { path: 'Agents/alpha/note.md', content: 'x' },
        { vaultRoot: undefined, bot: 'alpha' },
      ),
    ).rejects.toMatchObject({ code: 'vault_not_configured' });
  });

  it('throws code:bot_required when ctx.bot is missing', async () => {
    await expect(
      call(
        { path: 'Agents/alpha/note.md', content: 'x' },
        { vaultRoot },
      ),
    ).rejects.toMatchObject({ code: 'bot_required' });
  });

  it('throws code:bot_required when ctx.bot is empty string', async () => {
    await expect(
      call(
        { path: 'Agents/alpha/note.md', content: 'x' },
        { vaultRoot, bot: '' },
      ),
    ).rejects.toMatchObject({ code: 'bot_required' });
  });

  it('throws code:invalid_content when args.content is not a string', async () => {
    await expect(
      call(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { path: 'Agents/alpha/note.md', content: 42 as any },
        { vaultRoot, bot: 'alpha' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_content' });
    await expect(
      call(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { path: 'Agents/alpha/note.md', content: { not: 'a string' } as any },
        { vaultRoot, bot: 'alpha' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_content' });
  });

  it('throws code:invalid_path when args.path is missing or empty', async () => {
    await expect(
      call(
        { path: '', content: 'x' },
        { vaultRoot, bot: 'alpha' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });
});

describe('vault.write — atomic write', () => {
  it('mid-write failure (writeFile throws) leaves no canonical file at the destination', async () => {
    // Spy on the async fsp.writeFile to throw on the FIRST call (the tmp
    // write). The canonical file should not exist after the failure.
    const realWriteFile = fsp.writeFile;
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementationOnce(async (..._args: unknown[]) => {
      throw new Error('synthetic mid-write failure');
    });

    try {
      await expect(
        call(
          { path: 'Agents/alpha/note.md', content: 'should fail' },
          { vaultRoot, bot: 'alpha' },
        ),
      ).rejects.toThrow();
      // The canonical file MUST NOT exist (the tmp+rename pattern guarantees
      // this — only the .tmp file may exist transiently).
      const canonical = path.join(vaultRoot, 'Agents', 'alpha', 'note.md');
      expect(fs.existsSync(canonical)).toBe(false);
    } finally {
      spy.mockRestore();
      void realWriteFile;
    }
  });

  it('no leftover .tmp files after a successful write', async () => {
    await call(
      { path: 'Agents/alpha/note.md', content: 'ok' },
      { vaultRoot, bot: 'alpha' },
    );
    const entries = fs.readdirSync(path.join(vaultRoot, 'Agents', 'alpha'));
    const tmps = entries.filter((e) => e.endsWith('.tmp'));
    expect(tmps).toEqual([]);
  });
});

describe('vault.write — symlink containment', () => {
  it('refuses to write through a symlink that points OUTSIDE Agents/<bot>/', async () => {
    // Windows requires elevated privileges for symlinks; skip on win32 to
    // avoid EPERM in the dev sandbox. The containment invariant is still
    // covered by the `..` escape test above (safe_path layer 1 catches
    // a path that resolves outside the vault).
    if (process.platform === 'win32') return;
    // Create a symlink inside Agents/alpha/ that points to Projects/.
    const linkPath = path.join(vaultRoot, 'Agents', 'alpha', 'evil');
    fs.symlinkSync(path.join(vaultRoot, 'Projects'), linkPath, 'dir');
    // The symlink resolves to Projects/, which is outside Agents/<bot>/,
    // so writes through it must be refused.
    await expect(
      call(
        { path: 'Agents/alpha/evil/foo.md', content: 'x' },
        { vaultRoot, bot: 'alpha' },
      ),
    ).rejects.toThrow(); // either write_outside_agents or outside_workspace
  });
});
