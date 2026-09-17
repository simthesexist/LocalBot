// list_dir tool — list entries in a directory inside the bot workspace.
// Dirs first (case-insensitive alphabetical), then files (same).
//
// ctx (passed by registry) carries:
//   - workspaceRoot: absolute path of the bot's workspace
//   - toolCallId:    unique id for this tool call
//   - signal:        AbortSignal for cancel transport (Phase 2 Wave 2: ignored)

const fs = require('node:fs/promises');
const { safePath } = require('./safe_path.cjs');

async function call(args, ctx) {
  const requested = args && args.path;
  const resolved = await safePath(ctx.workspaceRoot, requested);

  let dirents;
  try {
    dirents = await fs.readdir(resolved, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const err = new Error(`directory not found: ${requested}`);
      err.code = 'enoent';
      throw err;
    }
    if (e && e.code === 'ENOTDIR') {
      const err = new Error(`not a directory: ${requested}`);
      err.code = 'not_a_directory';
      throw err;
    }
    throw e;
  }

  // Sort: dirs first (alpha), then files (alpha). Stable tiebreak by
  // lowercased name → original name (so "Foo" and "foo" order consistently
  // even on case-sensitive filesystems).
  const entries = dirents
    .map((d) => ({
      name: d.name,
      type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other',
      size: d.isFile() ? (d.size ?? null) : null,
    }))
    .sort((a, b) => {
      if (a.type === b.type) {
        const al = a.name.toLowerCase();
        const bl = b.name.toLowerCase();
        if (al === bl) return a.name.localeCompare(b.name);
        return al.localeCompare(bl);
      }
      return a.type === 'dir' ? -1 : 1;
    });

  return { entries };
}

module.exports = { call };