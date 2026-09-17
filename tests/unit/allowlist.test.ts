// Unit tests for daemon/tools/registry.cjs — allowlist / denylist / schema
// enforcement. Run with: npm test

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const registry = require_('../../daemon/tools/registry.cjs') as {
  listTools: () => Array<{ name: string; description: string; input_schema: unknown }>;
  callTool: (
    botId: string,
    name: string,
    args: Record<string, unknown>,
    ctx: { workspaceRoot?: string },
  ) => Promise<{ content?: string }>;
  cancelToolCall: (toolCallId: string) => { cancelled: boolean };
  TOOLS: string[];
};

describe('registry.listTools', () => {
  it('returns 5 tool schemas with input_schema objects', () => {
    const tools = registry.listTools();
    expect(tools).toHaveLength(5);
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.input_schema).toBeTruthy();
      expect(typeof t.input_schema).toBe('object');
    }
  });

  it('includes the five Phase 2 tool names', () => {
    const names = registry.listTools().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['read_file', 'write_file', 'edit_file', 'list_dir', 'code_search']),
    );
  });
});

describe('registry.callTool — allowlist enforcement', () => {
  it('runs an allowlisted tool (read_file)', async () => {
    const tmp = require('node:os').tmpdir();
    const fs = require('node:fs');
    const path = require('node:path');
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
    // read_file IS in TOOLS but we temporarily drop it from the allowlist to
    // exercise the allowlist branch without dragging in a non-Phase-2 tool.
    const def = require_('../../daemon/bots/default.cjs') as {
      DEFAULT_POLICY: {
        allowlist: Set<string>;
        denylist: Set<string>;
      };
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
    // Swap the default policy to add `read_file` to denylist at runtime.
    const def = require_('../../daemon/bots/default.cjs') as {
      DEFAULT_POLICY: {
        allowlist: Set<string>;
        denylist: Set<string>;
      };
    };
    const original = new Set(def.DEFAULT_POLICY.denylist);
    def.DEFAULT_POLICY.denylist.add('read_file');
    try {
      await expect(
        registry.callTool('default', 'read_file', { path: 'a' }, { workspaceRoot: '/tmp' }),
      ).rejects.toMatchObject({ code: 'denied', reason: 'denylist' });
    } finally {
      // Restore so we don't leak state to other tests.
      def.DEFAULT_POLICY.denylist = original;
    }
  });

  it('throws code=unknown_tool for unknown tool names', async () => {
    await expect(
      registry.callTool('default', 'bogus_tool', {}, { workspaceRoot: '/tmp' }),
    ).rejects.toMatchObject({ code: 'unknown_tool' });
  });
});

describe('registry.cancelToolCall', () => {
  it('returns { cancelled: false, reason: "not_found" } when no child is registered', () => {
    const r = registry.cancelToolCall('tc_test_1');
    expect(r).toEqual({ cancelled: false, reason: 'not_found' });
  });
});
