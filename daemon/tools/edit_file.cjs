// edit_file tool — apply a single find/replace edit to an existing file.
// Single-match strict per Plan 02-02 / RESEARCH.md Open Question #2: if `find`
// matches zero times, throws code:'no_match'; if more than once, throws
// code:'multiple_matches'. Atomic via tmp file + rename (Node fs.rename is
// atomic on the same filesystem on Windows + POSIX — see RESEARCH.md
// §"Pitfall 6").
//
// ctx (passed by registry) carries:
//   - workspaceRoot: absolute path of the bot's workspace
//   - toolCallId:    unique id for this tool call
//   - signal:        AbortSignal for cancel transport (Phase 2 Wave 2: ignored)

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { safePath } = require('./safe_path.cjs');

async function call(args, ctx) {
  const requested = args && args.path;
  const find = args && args.find;
  const replace = args && args.replace;

  if (typeof find !== 'string' || find.length === 0) {
    const err = new Error('find must be a non-empty string');
    err.code = 'invalid_find';
    throw err;
  }
  if (typeof replace !== 'string') {
    const err = new Error('replace must be a string');
    err.code = 'invalid_replace';
    throw err;
  }

  const resolved = await safePath(ctx.workspaceRoot, requested);

  let content;
  try {
    content = await fs.readFile(resolved, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const err = new Error(`file not found: ${requested}`);
      err.code = 'enoent';
      throw err;
    }
    throw e;
  }

  // content.split(find).length - 1 is the literal match count.
  // Splitting with an empty string would return a degenerate count, but the
  // `find.length === 0` guard above rejects that case.
  const occurrences = content.split(find).length - 1;
  if (occurrences === 0) {
    const err = new Error(`find substring not present in ${requested}`);
    err.code = 'no_match';
    throw err;
  }
  if (occurrences > 1) {
    const err = new Error(
      `find substring matches ${occurrences} times in ${requested} (single-match strict)`,
    );
    err.code = 'multiple_matches';
    throw err;
  }

  const newContent = content.replace(find, replace);

  // Atomic write: tmp file in the same directory + fs.rename. Same-FS rename
  // is atomic on Windows + POSIX (see RESEARCH.md §"Pitfall 6"). Best-effort
  // cleanup of the tmp file if rename fails — the original file remains
  // unchanged in that case.
  const tmpPath = `${resolved}.localbot-tmp-${crypto.randomBytes(6).toString('hex')}`;
  try {
    await fs.writeFile(tmpPath, newContent, 'utf8');
    await fs.rename(tmpPath, resolved);
  } catch (e) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore — tmp may already be gone
    }
    throw e;
  }

  return { path: requested, replacements: 1 };
}

module.exports = { call };