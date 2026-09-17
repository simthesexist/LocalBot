// read_file tool — read a UTF-8 text file inside the bot workspace.
//
// ctx (passed by registry) carries:
//   - workspaceRoot: absolute path of the bot's workspace
//   - toolCallId:    unique id for this tool call
//   - signal:        AbortSignal for cancel transport (Phase 2 Wave 1: ignored)

const fs = require('node:fs/promises');
const { safePath } = require('./safe_path.cjs');

async function call(args, ctx) {
  const requested = args && args.path;
  const resolved = await safePath(ctx.workspaceRoot, requested);
  try {
    const content = await fs.readFile(resolved, 'utf8');
    return { content };
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const err = new Error(`file not found: ${requested}`);
      err.code = 'enoent';
      throw err;
    }
    if (e && e.code === 'EACCES') {
      const err = new Error(`permission denied: ${requested}`);
      err.code = 'eacces';
      throw err;
    }
    throw e;
  }
}

module.exports = { call };
