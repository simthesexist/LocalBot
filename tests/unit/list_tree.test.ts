// Unit tests for daemon/tools/list_tree.cjs (Phase 3).
// Run with: npm test

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

const listTree = require_('../../daemon/tools/list_tree.cjs') as {
  call: (
    args: { path?: string; maxDepth?: number; maxEntriesPerDir?: number; exclude?: string[] },
    ctx: { workspaceRoot: string },
  ) => Promise<{ entries: Array<{ name: string; type: string; size?: number; children?: unknown }>; truncated: boolean }>;
};

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-tree-'));
});

afterEach(() => {
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeFile(p: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'content', 'utf8');
}

describe('list_tree', () => {
  it('returns a flat list for a single dir with no recursion', async () => {
    makeFile(path.join(workspace, 'a.txt'));
    makeFile(path.join(workspace, 'b.txt'));
    const out = await listTree.call({ path: '.', maxDepth: 1 }, { workspaceRoot: workspace });
    expect(out.entries.map((e) => e.name).sort()).toEqual(['a.txt', 'b.txt']);
    expect(out.truncated).toBe(false);
  });

  it('caps entries at maxEntriesPerDir and reports truncated=true', async () => {
    for (let i = 0; i < 5; i++) makeFile(path.join(workspace, `f${i}.txt`));
    const out = await listTree.call(
      { path: '.', maxDepth: 1, maxEntriesPerDir: 2 },
      { workspaceRoot: workspace },
    );
    expect(out.entries.length).toBe(2);
    expect(out.truncated).toBe(true);
  });

  it('skips node_modules + .git by default', async () => {
    makeFile(path.join(workspace, 'keep.txt'));
    makeFile(path.join(workspace, 'node_modules', 'skip.js'));
    makeFile(path.join(workspace, '.git', 'HEAD'));
    const out = await listTree.call({ path: '.', maxDepth: 5 }, { workspaceRoot: workspace });
    expect(out.entries.map((e) => e.name)).toEqual(['keep.txt']);
  });

  it('returns children for directories inside maxDepth', async () => {
    makeFile(path.join(workspace, 'sub', 'deep.txt'));
    const out = await listTree.call({ path: '.', maxDepth: 3 }, { workspaceRoot: workspace });
    const sub = out.entries.find((e) => e.name === 'sub');
    expect(sub).toBeTruthy();
    expect(sub!.type).toBe('dir');
    expect(Array.isArray(sub!.children)).toBe(true);
    expect((sub!.children as Array<{ name: string }>).map((c) => c.name)).toEqual(['deep.txt']);
  });

  it('returns children:null for dirs at maxDepth boundary', async () => {
    makeFile(path.join(workspace, 'sub', 'deep.txt'));
    const out = await listTree.call({ path: '.', maxDepth: 1 }, { workspaceRoot: workspace });
    const sub = out.entries.find((e) => e.name === 'sub');
    expect(sub!.children).toBeNull();
  });

  it('rejects a path that escapes workspaceRoot', async () => {
    await expect(
      listTree.call({ path: '../etc/passwd' }, { workspaceRoot: workspace }),
    ).rejects.toMatchObject({ code: 'outside_workspace' });
  });

  it('reports size for files via fs.stat', async () => {
    fs.writeFileSync(path.join(workspace, 'big.bin'), 'x'.repeat(1234));
    const out = await listTree.call({ path: '.', maxDepth: 1 }, { workspaceRoot: workspace });
    const big = out.entries.find((e) => e.name === 'big.bin');
    expect(big!.size).toBe(1234);
  });

  it('chokidar watcher fires refresh event within 500ms of file change', async () => {
    // Force polling mode for the test — Windows native event delivery is
    // unreliable in some CI runners.
    const prev = process.env.LOCALBOT_WATCHER_POLLING;
    process.env.LOCALBOT_WATCHER_POLLING = '1';
    try {
      const { createWatcher } = require_('../../daemon/watcher.cjs');
      const w = createWatcher([{ id: 'workspace', absPath: workspace }], { debounceMs: 100 });
      let fired = false;
      let payload: any = null;
      const off = w.on('refresh', (p) => { fired = true; payload = p; });
      try {
        w.start();
        // Wait for chokidar to fully attach. Polling mode polls every
        // 200ms; we give it a full second before mutating to avoid the
        // initial-scan race where `add` events may be coalesced into
        // the first poll cycle.
        await new Promise((r) => setTimeout(r, 1500));
        fs.writeFileSync(path.join(workspace, 'new.txt'), 'hi', 'utf8');
        // Wait up to 3s for the debounced refresh to fire.
        const deadline = Date.now() + 3000;
        while (!fired && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(fired, 'chokidar watcher did not fire refresh within 3000ms').toBe(true);
        expect(payload?.rootPath).toBe(workspace);
        expect(Array.isArray(payload?.changedPaths)).toBe(true);
      } finally {
        try { off(); } catch { /* ignore */ }
        await w.stop();
      }
    } finally {
      if (prev === undefined) delete process.env.LOCALBOT_WATCHER_POLLING;
      else process.env.LOCALBOT_WATCHER_POLLING = prev;
    }
  });
});