// Unit tests for daemon/tools/registry.cjs — allowlist / denylist / schema
// enforcement. Run with: npm test

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const registry = require_('../../daemon/tools/registry.cjs') as {
  listTools: () => Array<{ name: string; description: string; input_schema: unknown }>;
  callTool: (
    botId: string,
    name: string,
    args: Record<string, unknown>,
    ctx: { workspaceRoot?: string; botDir?: string },
  ) => Promise<unknown>;
  cancelToolCall: (toolCallId: string) => { cancelled: boolean };
  TOOLS: string[];
  SYSTEM_TOOLS: Set<string>;
};

const memoryRead = require_('../../daemon/tools/memory_read.cjs') as {
  call: (args: Record<string, unknown>, ctx: { botDir: string }) => Promise<unknown>;
};

describe('registry.listTools', () => {
  it('returns 14 tool schemas with input_schema objects', () => {
    // Phase 5 Wave 1 added exec_command (10). Phase 7 Plan 1 added
    // vault.read + vault.write (12). Plan 07-02 added vault.search +
    // vault.list (14).
    const tools = registry.listTools();
    expect(tools).toHaveLength(14);
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.input_schema).toBeTruthy();
      expect(typeof t.input_schema).toBe('object');
    }
  });

  it('includes the Phase 2 + Phase 3 tool names', () => {
    const names = registry.listTools().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'read_file', 'write_file', 'edit_file', 'list_dir', 'code_search',
        'memory.read', 'memory.write', 'memory.update', 'tree.list',
        'exec_command',
      ]),
    );
  });
});

describe('registry.callTool — allowlist enforcement', () => {
  it('runs an allowlisted tool (read_file)', async () => {
    const tmp = require('node:os').tmpdir();
    const ws = fs.mkdtempSync(path.join(tmp, 'localbot-al-low-'));
    try {
      fs.writeFileSync(path.join(ws, 'a.txt'), 'ok', 'utf8');
      const result = await registry.callTool('default', 'read_file', { path: 'a.txt' }, { workspaceRoot: ws });
      expect(result).toEqual({ content: 'ok' });
    } finally {
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('throws code=denied reason=allowlist for a tool that is registered but NOT in the bot allowlist', async () => {
    const def = require_('../../daemon/bots/default.cjs') as {
      DEFAULT_POLICY: { allowlist: Set<string>; denylist: Set<string> };
    };
    const hadReadFile = def.DEFAULT_POLICY.allowlist.has('read_file');
    def.DEFAULT_POLICY.allowlist.delete('read_file');
    try {
      await expect(
        registry.callTool('default', 'read_file', { path: 'a' }, { workspaceRoot: '/tmp' }),
      ).rejects.toMatchObject({ code: 'denied', reason: 'allowlist' });
    } finally {
      if (hadReadFile) def.DEFAULT_POLICY.allowlist.add('read_file');
    }
  });

  it('throws code=denied reason=denylist for denylisted tools', async () => {
    const def = require_('../../daemon/bots/default.cjs') as {
      DEFAULT_POLICY: { allowlist: Set<string>; denylist: Set<string> };
    };
    const original = new Set(def.DEFAULT_POLICY.denylist);
    def.DEFAULT_POLICY.denylist.add('read_file');
    try {
      await expect(
        registry.callTool('default', 'read_file', { path: 'a' }, { workspaceRoot: '/tmp' }),
      ).rejects.toMatchObject({ code: 'denied', reason: 'denylist' });
    } finally {
      def.DEFAULT_POLICY.denylist = original;
    }
  });

  it('throws code=unknown_tool for unknown tool names', async () => {
    await expect(
      registry.callTool('default', 'bogus_tool', {}, { workspaceRoot: '/tmp' }),
    ).rejects.toMatchObject({ code: 'unknown_tool' });
  });
});

describe('Phase 3 allowlist extensions', () => {
  it('memory.update is in the default allowlist and runs', async () => {
    const def = require_('../../daemon/bots/default.cjs') as {
      DEFAULT_POLICY: { allowlist: Set<string>; denylist: Set<string> };
    };
    expect(def.DEFAULT_POLICY.allowlist.has('memory.update')).toBe(true);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-mem-allow-'));
    try {
      fs.writeFileSync(path.join(tmp, 'memory.md'), '## Identity\nname: bob\n', 'utf8');
      const result = await registry.callTool(
        'default',
        'memory.update',
        { bot: 'default', section: 'Identity', content: 'name: bob' },
        { botDir: tmp },
      );
      expect(result).toBeTruthy();
      // The tool mutates the existing memory.md by replacing the matching H2 section.
      const updated = fs.readFileSync(path.join(tmp, 'memory.md'), 'utf8');
      expect(updated).toContain('name: bob');
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('memory.update is NOT in SYSTEM_TOOLS (it goes through normal allowlist)', () => {
    expect(registry.SYSTEM_TOOLS.has('memory.update')).toBe(false);
  });

  it('memory.read is in SYSTEM_TOOLS and bypasses allowlist for _system bot', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-mem-sys-'));
    try {
      fs.writeFileSync(path.join(tmp, 'memory.md'), 'hi', 'utf8');
      const result = await registry.callTool(
        '_system',
        'memory.read',
        { bot: 'default' },
        { botDir: tmp },
      );
      expect(result).toMatchObject({ markdown: 'hi' });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('memory.read on a non-system bot throws denied because it is not in allowlist', async () => {
    const def = require_('../../daemon/bots/default.cjs') as {
      DEFAULT_POLICY: { allowlist: Set<string> };
    };
    const had = def.DEFAULT_POLICY.allowlist.has('memory.read');
    def.DEFAULT_POLICY.allowlist.delete('memory.read');
    try {
      await expect(
        registry.callTool('default', 'memory.read', { bot: 'default' }, { botDir: '/tmp' }),
      ).rejects.toMatchObject({ code: 'denied', reason: 'allowlist' });
    } finally {
      if (had) def.DEFAULT_POLICY.allowlist.add('memory.read');
    }
  });

  it('tree.list is in SYSTEM_TOOLS and bypasses allowlist for _system bot', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-tree-sys-'));
    try {
      fs.writeFileSync(path.join(tmp, 'a.txt'), 'x', 'utf8');
      const result = await registry.callTool(
        '_system',
        'tree.list',
        { path: '.' },
        { workspaceRoot: tmp },
      );
      expect((result as { entries: unknown[] }).entries.length).toBeGreaterThan(0);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('registry.cancelToolCall', () => {
  it('returns { cancelled: false, reason: "not_found" } when no child is registered', () => {
    const r = registry.cancelToolCall('tc_test_1');
    expect(r).toEqual({ cancelled: false, reason: 'not_found' });
  });
});

describe('per-bot allowlist override', () => {
  it('tool allowed for bot A but denied for bot B with the narrow allowlist', async () => {
    const tmp = require('node:os').tmpdir();
    const ws = fs.mkdtempSync(path.join(tmp, 'localbot-perbot-'));
    try {
      fs.writeFileSync(path.join(ws, 'a.txt'), 'ok', 'utf8');
      // bot-a allows only read_file
      const loader = require_('../../daemon/bots/loader.cjs') as {
        writeConfig: (dir: string, bot: string, cfg: Record<string, unknown>) => unknown;
      };
      loader.writeConfig(ws, 'bot-a', {
        id: 'bot-a',
        name: 'A',
        schemaVersion: 1,
        allowlist: ['read_file'],
      });
      // bot-b allows both read + write
      loader.writeConfig(ws, 'bot-b', {
        id: 'bot-b',
        name: 'B',
        schemaVersion: 1,
        allowlist: ['read_file', 'write_file'],
      });

      // bot-a: write_file should be denied.
      await expect(
        registry.callTool('bot-a', 'write_file', { path: 'a.txt', content: 'x' }, { workspaceRoot: ws, userDataDir: ws }),
      ).rejects.toMatchObject({ code: 'denied', reason: 'allowlist' });

      // bot-b: write_file should be allowed (filesystem write succeeds).
      const res = await registry.callTool(
        'bot-b', 'write_file', { path: 'a.txt', content: 'ok' }, { workspaceRoot: ws, userDataDir: ws },
      );
      expect(res).toBeTruthy();
      expect(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8')).toBe('ok');
    } finally {
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('bots/update narrows the allowlist and the next tools/call reflects it', async () => {
    const tmp = require('node:os').tmpdir();
    const ws = fs.mkdtempSync(path.join(tmp, 'localbot-update-allow-'));
    try {
      fs.writeFileSync(path.join(ws, 'a.txt'), 'ok', 'utf8');
      const loader = require_('../../daemon/bots/loader.cjs') as {
        writeConfig: (dir: string, bot: string, cfg: Record<string, unknown>) => unknown;
        writeConfigPatch: (dir: string, bot: string, patch: Record<string, unknown>) => unknown;
      };
      loader.writeConfig(ws, 'narrow', {
        id: 'narrow',
        name: 'Narrow',
        schemaVersion: 1,
        allowlist: ['read_file', 'write_file'],
      });
      // Before update: write_file is allowed.
      await expect(
        registry.callTool('narrow', 'write_file', { path: 'a.txt', content: 'y' }, { workspaceRoot: ws, userDataDir: ws }),
      ).resolves.toBeTruthy();

      // Narrow the allowlist.
      loader.writeConfigPatch(ws, 'narrow', { allowlist: ['read_file'] });

      // After update: write_file is denied.
      await expect(
        registry.callTool('narrow', 'write_file', { path: 'a.txt', content: 'z' }, { workspaceRoot: ws, userDataDir: ws }),
      ).rejects.toMatchObject({ code: 'denied', reason: 'allowlist' });
    } finally {
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// Reference the memory_read import so vitest doesn't fail on unused-import.
void memoryRead;