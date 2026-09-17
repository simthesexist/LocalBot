// write_file tool — write UTF-8 content to a file inside the bot workspace.
// Creates parent directories as needed (recursively).
//
// ctx (passed by registry) carries:
//   - workspaceRoot: absolute path of the bot's workspace
//   - toolCallId:    unique id for this tool call
//   - signal:        AbortSignal for cancel transport (Phase 2 Wave 2: ignored)

const fs = require('node:fs/promises');
const path = require('node:path');
const { safePath } = require('./safe_path.cjs');

async function call(args, ctx) {
  const requested = args && args.path;
  const content = args && args.content;

  if (typeof content !== 'string') {
    const err = new Error('content must be a string');
    err.code = 'invalid_content';
    throw err;
  }

  const resolved = await safePath(ctx.workspaceRoot, requested);
  await fs.mkdir(path.dirname(resolved), { recursive: true });

  try {
    await fs.writeFile(resolved, content, 'utf8');
  } catch (e) {
    if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
      const err = new Error(`permission denied writing: ${requested}`);
      err.code = 'eacces';
      throw err;
    }
    throw e;
  }

  return { path: requested, bytesWritten: Buffer.byteLength(content, 'utf8') };
}

module.exports = { call };