// Recursive workspace tree. Phase 3 tracer slice.
//
// Caps per-dir entries (default 500) and depth (default 5). Skips a default
// exclusion list (node_modules, .git, etc.). children:null for unopened
// nodes so the renderer can lazy-load one level at a time.

const fs = require('node:fs/promises');
const path = require('node:path');
const { safePath } = require('./safe_path.cjs');

const DEFAULT_EXCLUDE = ['node_modules', '.git', '.next', 'dist', 'target', '__pycache__', '.venv'];
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_ENTRIES = 500;

async function walk(absDir, depth, opts) {
  const { maxDepth, maxEntriesPerDir, exclude } = opts;
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      return { nodes: [], truncated: false };
    }
    throw err;
  }
  // Filter excluded names; sort dirs-first then alphabetical.
  const filtered = entries.filter((e) => !exclude.includes(e.name));
  filtered.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });

  const truncated = filtered.length > maxEntriesPerDir;
  const sliced = truncated ? filtered.slice(0, maxEntriesPerDir) : filtered;

  const nodes = [];
  for (const ent of sliced) {
    const abs = path.join(absDir, ent.name);
    if (ent.isDirectory()) {
      const childNodes = depth < maxDepth - 1
        ? await walk(abs, depth + 1, opts)
        : null;
      nodes.push({
        name: ent.name,
        path: abs,
        type: 'dir',
        children: childNodes ? childNodes.nodes : null,
        truncated: childNodes ? childNodes.truncated : undefined,
      });
    } else if (ent.isFile()) {
      let size;
      try { size = (await fs.stat(abs)).size; } catch { /* ignore */ }
      nodes.push({
        name: ent.name,
        path: abs,
        type: 'file',
        size,
      });
    } else if (ent.isSymbolicLink()) {
      // Skip symlinks for safety; they could resolve outside the workspace.
      continue;
    }
  }
  return { nodes, truncated };
}

async function call(args, ctx) {
  const maxDepth = (args && typeof args.maxDepth === 'number') ? args.maxDepth : DEFAULT_MAX_DEPTH;
  const maxEntriesPerDir = (args && typeof args.maxEntriesPerDir === 'number')
    ? args.maxEntriesPerDir
    : DEFAULT_MAX_ENTRIES;
  const exclude = (args && Array.isArray(args.exclude)) ? args.exclude : DEFAULT_EXCLUDE;

  // Root: explicit `path` arg if given, else ctx.workspaceRoot (passed by
  // main when it sets up the daemon for a bot).
  const requested = (args && typeof args.path === 'string') ? args.path : '.';
  const workspaceRoot = ctx && ctx.workspaceRoot;
  if (!workspaceRoot) {
    const e = new Error('workspaceRoot not configured');
    e.code = 'workspace_missing';
    throw e;
  }
  const rootSafe = await safePath(workspaceRoot, requested);

  const { nodes, truncated } = await walk(rootSafe, 0, {
    maxDepth,
    maxEntriesPerDir,
    exclude,
  });
  return { entries: nodes, truncated };
}

module.exports = { call, DEFAULT_EXCLUDE };