// safePath(workspaceRoot, requested) → resolves requested to an absolute path
// inside workspaceRoot, defending against `..` traversal, absolute-path escape,
// and symlink escape. Throws an Error with `code` set when the requested path
// escapes the workspace.

const path = require('node:path');
const fs = require('node:fs/promises');

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function safePath(workspaceRoot, requested) {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw err('invalid_path', 'path is empty or not a string');
  }
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw err('workspace_missing', 'workspace root not configured');
  }

  // Ensure workspace exists; resolve real path so symlinked roots are caught.
  await fs.mkdir(workspaceRoot, { recursive: true });
  const rootReal = await fs.realpath(workspaceRoot);

  const joined = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(workspaceRoot, requested);

  // Walk up to find the deepest existing ancestor of `joined`.
  let existingParent = null;
  let probe = joined;
  while (true) {
    try {
      existingParent = await fs.realpath(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        // Reached the filesystem root without finding an existing ancestor.
        // Should not happen in practice — workspace mkdir above guarantees
        // the root exists. Throw to avoid an infinite loop.
        throw err('outside_workspace', `path escapes workspace: ${requested}`);
      }
      probe = parent;
    }
  }

  // If the joined path itself realpathed to an existing file, return it.
  if (existingParent === joined || path.resolve(existingParent) === path.resolve(joined)) {
    const inside =
      existingParent === rootReal ||
      existingParent.startsWith(rootReal + path.sep);
    if (!inside) {
      throw err('outside_workspace', `path escapes workspace: ${requested}`);
    }
    return existingParent;
  }

  // `joined` did not exist — verify the deepest existing ancestor is inside
  // the workspace, then return the original joined absolute (write/edit of
  // a new path). The caller is responsible for ensuring the parent dirs
  // exist (safe_path does NOT auto-mkdir non-existent parents in Wave 1).
  const inside =
    existingParent === rootReal ||
    existingParent.startsWith(rootReal + path.sep);
  if (!inside) {
    throw err('outside_workspace', `path escapes workspace: ${requested}`);
  }
  return joined;
}

module.exports = { safePath };
