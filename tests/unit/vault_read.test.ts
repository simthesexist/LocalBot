// Unit tests for daemon/tools/vault_read.cjs.
// Run with: npm test
//
// Phase 7 Plan 1: covers the deny-wins glob pipeline integration, safe_path
// realpath escape (Pitfall 6 + T-7-01), ENOENT, vault_not_configured, and
// the startLine/endLine slicing extension. Uses real safe_path against a
// mkdtemp vault root (same pattern as tests/unit/read_file.test.ts).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { call } = require_('../../daemon/tools/vault_read.cjs') as {
  call: (
    args: { path: string; startLine?: number; endLine?: number },
    ctx: {
      vaultRoot?: string;
      globalDeny?: string[];
      vaultDeny?: string[];
      vaultAllow?: string[];
      bot?: string;
    },
  ) => Promise<{ path: string; content: string; bytes: number; startLine?: number; endLine?: number; truncated: boolean }>;
};

let vaultRoot: string;
beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-vault-read-'));
  fs.mkdirSync(path.join(vaultRoot, 'Projects'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'Daily'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'Private'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'Projects', 'foo.md'), 'project note\n', 'utf8');
  fs.writeFileSync(path.join(vaultRoot, 'Daily', '2026-09-19.md'), 'daily line 1\ndaily line 2\ndaily line 3\n', 'utf8');
  fs.writeFileSync(path.join(vaultRoot, 'Private', 'secret.md'), 'shhh\n', 'utf8');
});
afterEach(() => {
  try { fs.rmSync(vaultRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('vault.read — happy path', () => {
  it('reads a vault-relative file when the path matches vaultAllow', async () => {
    const result = await call(
      { path: 'Projects/foo.md' },
      { vaultRoot, globalDeny: [], vaultDeny: [], vaultAllow: ['Projects/**'] },
    );
    expect(result.path).toBe('Projects/foo.md');
    expect(result.content).toBe('project note\n');
    expect(result.bytes).toBe(Buffer.byteLength('project note\n', 'utf8'));
    expect(result.truncated).toBe(false);
  });

  it('uses forward-slash vault-relative path even on Windows', async () => {
    const result = await call(
      { path: path.join('Projects', 'foo.md') },
      { vaultRoot, globalDeny: [], vaultDeny: [], vaultAllow: ['Projects/**'] },
    );
    expect(result.path).toBe('Projects/foo.md');
  });
});

describe('vault.read — glob pipeline enforcement', () => {
  it('rejects when path matches globalDeny with reason:global_deny', async () => {
    await expect(
      call(
        { path: 'Private/secret.md' },
        { vaultRoot, globalDeny: ['Private/**'], vaultDeny: [], vaultAllow: ['**/*'] },
      ),
    ).rejects.toMatchObject({ code: 'glob_denied', reason: 'global_deny', pattern: 'Private/**' });
  });

  it('rejects when path matches vaultDeny with reason:vault_deny', async () => {
    await expect(
      call(
        { path: 'Daily/2026-09-19.md' },
        { vaultRoot, globalDeny: [], vaultDeny: ['Daily/**'], vaultAllow: ['**/*'] },
      ),
    ).rejects.toMatchObject({ code: 'glob_denied', reason: 'vault_deny', pattern: 'Daily/**' });
  });

  it('rejects when path is NOT in vaultAllow with reason:not_in_allowlist', async () => {
    await expect(
      call(
        { path: 'Daily/2026-09-19.md' },
        { vaultRoot, globalDeny: [], vaultDeny: [], vaultAllow: ['Projects/**'] },
      ),
    ).rejects.toMatchObject({ code: 'glob_denied', reason: 'not_in_allowlist' });
  });

  it('rejects when vaultAllow is empty with reason:no_allowlist', async () => {
    await expect(
      call(
        { path: 'Projects/foo.md' },
        { vaultRoot, globalDeny: [], vaultDeny: [], vaultAllow: [] },
      ),
    ).rejects.toMatchObject({ code: 'glob_denied', reason: 'no_allowlist' });
  });

  it('globalDeny wins even when path also matches vaultAllow', async () => {
    await expect(
      call(
        { path: 'Private/secret.md' },
        { vaultRoot, globalDeny: ['Private/**'], vaultDeny: [], vaultAllow: ['**/*'] },
      ),
    ).rejects.toMatchObject({ code: 'glob_denied', reason: 'global_deny' });
  });
});

describe('vault.read — safe_path containment', () => {
  it('throws code:outside_workspace when path escapes via ../', async () => {
    await expect(
      call(
        { path: '../etc/passwd' },
        { vaultRoot, globalDeny: [], vaultDeny: [], vaultAllow: ['**/*'] },
      ),
    ).rejects.toMatchObject({ code: 'outside_workspace' });
  });
});

describe('vault.read — ctx validation', () => {
  it('throws code:vault_not_configured when ctx.vaultRoot is undefined', async () => {
    await expect(
      call(
        { path: 'Projects/foo.md' },
        { vaultRoot: undefined, globalDeny: [], vaultDeny: [], vaultAllow: ['Projects/**'] },
      ),
    ).rejects.toMatchObject({ code: 'vault_not_configured' });
  });

  it('throws code:vault_not_configured when ctx.vaultRoot is empty string', async () => {
    await expect(
      call(
        { path: 'Projects/foo.md' },
        { vaultRoot: '', globalDeny: [], vaultDeny: [], vaultAllow: ['Projects/**'] },
      ),
    ).rejects.toMatchObject({ code: 'vault_not_configured' });
  });

  it('throws code:invalid_path when args.path is missing or empty', async () => {
    await expect(
      call(
        { path: '' },
        { vaultRoot, vaultAllow: ['**/*'] },
      ),
    ).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      call({} as any, { vaultRoot, vaultAllow: ['**/*'] }),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });
});

describe('vault.read — file errors', () => {
  it('throws code:enoent for non-existent vault-relative file', async () => {
    await expect(
      call(
        { path: 'Projects/missing.md' },
        { vaultRoot, globalDeny: [], vaultDeny: [], vaultAllow: ['Projects/**'] },
      ),
    ).rejects.toMatchObject({ code: 'enoent' });
  });
});

describe('vault.read — startLine/endLine slicing', () => {
  it('returns the requested line range when startLine/endLine provided', async () => {
    const result = await call(
      { path: 'Daily/2026-09-19.md', startLine: 2, endLine: 3 },
      { vaultRoot, globalDeny: [], vaultDeny: [], vaultAllow: ['Daily/**'] },
    );
    expect(result.content).toBe('daily line 2\ndaily line 3');
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
  });

  it('omits startLine/endLine when not provided', async () => {
    const result = await call(
      { path: 'Projects/foo.md' },
      { vaultRoot, vaultAllow: ['Projects/**'] },
    );
    expect(result.startLine).toBeUndefined();
    expect(result.endLine).toBeUndefined();
  });
});
