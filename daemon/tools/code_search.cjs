// code_search tool — ripgrep-based regex + glob search inside the workspace.
//
// Spawns the ripgrep binary shipped by `@vscode/ripgrep` (no PATH dependency,
// no node-gyp compile). Reads stdout line-by-line, parses JSON events, caps at
// `max_results` (default 200), and surfaces cancellation via the registry's
// child-tracking map so `tools/cancel` kills the in-flight ripgrep.
//
// Audit log payload minimization (Pitfall 5 in RESEARCH.md): the audit line for
// `code_search` records `params: { pattern, glob, path, max_results,
// result_count }` — never the matches payload — so even a 10 000-match query
// keeps the JSONL line under 1 MiB.

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');
const { safePath } = require('./safe_path.cjs');

const MAX_RESULTS_DEFAULT = 200;
const TIMEOUT_MS = 60_000;
const PATTERN_MAX_BYTES = 1024 * 1024; // 1 MiB

// Cache the resolved binary path for the lifetime of the daemon. Resolved
// lazily on the first call so that a missing optionalDependency doesn't
// crash the daemon at startup.
let RG_PATH = null;
let RG_PATH_RESOLVED = false;

async function resolveRipgrepBinary() {
  if (RG_PATH_RESOLVED) return RG_PATH;
  RG_PATH_RESOLVED = true;
  try {
    // `@vscode/ripgrep` ships its binary in an optionalDependency named
    // `@vscode/ripgrep-<platform>-<arch>` (e.g. `@vscode/ripgrep-win32-x64`).
    // The platform binary lives at `bin/rg.exe` (Windows) or `bin/rg` (POSIX).
    const platform = process.platform;
    const arch = process.arch;
    const binaryName = platform === 'win32' ? 'rg.exe' : 'rg';
    const platformPkg = `@vscode/ripgrep-${platform}-${arch}`;
    const binPath = require.resolve(`${platformPkg}/package.json`);
    const candidate = path.join(path.dirname(binPath), 'bin', binaryName);
    if (fs.existsSync(candidate)) {
      RG_PATH = candidate;
    } else {
      // Fall back to the ESM `@vscode/ripgrep` entry-point which resolves
      // the binary itself. (Used when the optionalDependency layout differs
      // from the above convention — e.g. a future VS Code release.)
      try {
        const url = require.resolve('@vscode/ripgrep/lib/index.js');
        const mod = await import(pathToFileURL(url).href);
        if (mod && typeof mod.rgPath === 'string' && fs.existsSync(mod.rgPath)) {
          RG_PATH = mod.rgPath;
        }
      } catch {
        RG_PATH = null;
      }
    }
  } catch {
    RG_PATH = null;
  }
  return RG_PATH;
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function stripLeadingDotSlash(p) {
  // ripgrep returns paths prefixed with "./" on POSIX and ".\\" on Windows
  // (when given a relative search root). Normalize both forms so the
  // renderer always sees a clean relative path.
  return p.replace(/^\.[\\/]/, '');
}

async function call(
  { pattern, glob, path: searchPath, max_results = MAX_RESULTS_DEFAULT },
  ctx,
) {
  // ── Input validation (TOOL-05 input_validation probe + argv injection defense) ──
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw err('invalid_pattern', 'pattern must be a non-empty string');
  }
  if (pattern.length > PATTERN_MAX_BYTES) {
    throw err('pattern_too_long', 'pattern exceeds 1 MiB');
  }
  if (pattern.includes('\0')) {
    throw err('invalid_pattern', 'pattern contains NUL byte');
  }
  if (glob != null) {
    if (typeof glob !== 'string' || glob.length === 0) {
      throw err('invalid_glob', 'glob must be a non-empty string');
    }
    if (glob.includes('\0')) {
      throw err('invalid_glob', 'glob contains NUL byte');
    }
  }
  const requested =
    typeof searchPath === 'string' && searchPath.length > 0 ? searchPath : '.';

  const rgPath = await resolveRipgrepBinary();
  if (!rgPath) {
    throw err(
      'rg_not_found',
      'ripgrep binary not found; ensure @vscode/ripgrep optionalDependencies installed',
    );
  }

  // Workspace containment — safePath realpaths + ancestor walk. Throws
  // `outside_workspace` before we ever reach `spawn`.
  const workspaceRoot = ctx && ctx.workspaceRoot;
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw err('workspace_missing', 'workspace root not configured');
  }
  const resolvedPath = await safePath(workspaceRoot, requested);

  // Pass a workspace-relative path to ripgrep so match.path values come
  // back as relative (not absolute) — per Pitfall T-P2-21 we never want
  // absolute workspace paths leaking to the renderer.
  let searchArg;
  if (requested === '.') {
    searchArg = '.';
  } else {
    const rel = path.relative(workspaceRoot, resolvedPath);
    searchArg = rel && !rel.startsWith('..') ? rel : resolvedPath;
  }

  // Args as array — never `shell: true`. Pattern + glob + path are validated
  // for NUL bytes above so they cannot be misinterpreted by ripgrep as flags.
  const args = ['--json', '--no-messages', '--no-config', '--regexp', pattern];
  if (glob) args.push('--glob', glob);
  args.push(searchArg);

  const child = spawn(rgPath, args, {
    cwd: workspaceRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Register the child so `tools/cancel` can SIGTERM this process.
  // ctx.registry is provided by daemon/tools/registry.cjs (Wave 3).
  const registry = ctx && ctx.registry;
  const toolCallId = ctx && ctx.toolCallId;
  if (registry && toolCallId && typeof registry.registerChild === 'function') {
    registry.registerChild(toolCallId, child);
  }

  const matches = [];
  let truncated = false;
  let linesSearched = 0;
  let stderrBuf = '';
  let aborted = false;

  const onAbort = () => {
    aborted = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 2000);
  };
  const signal = ctx && ctx.signal;
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', onAbort);
  }
  child.stderr.on('data', (b) => {
    stderrBuf += b.toString('utf8');
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
  });

  let timeoutFired = false;
  const timeout = setTimeout(() => {
    timeoutFired = true;
    aborted = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 2000);
  }, TIMEOUT_MS);

  const rl = readline.createInterface({ input: child.stdout });

  try {
    for await (const line of rl) {
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.type === 'match' && evt.data) {
        const d = evt.data;
        const m = {
          path: stripLeadingDotSlash(d.path?.text ?? ''),
          line: d.line_number ?? 0,
          text: (d.lines?.text ?? '').replace(/\n$/, ''),
          submatches: (d.submatches ?? []).map((s) => ({
            text: s.match?.text ?? '',
            start: s.start ?? 0,
            end: s.end ?? 0,
          })),
        };
        if (matches.length < max_results) {
          matches.push(m);
        } else {
          // Cap reached. Mark truncated and drain rest of stdout to avoid
          // the child lingering on a half-read pipe.
          truncated = true;
          break;
        }
      } else if (evt.type === 'end' && evt.data && evt.data.stats) {
        if (typeof evt.data.stats.lines_searched === 'number') {
          linesSearched = evt.data.stats.lines_searched;
        }
      }
      // 'begin' / 'context' / 'summary' events are ignored.
    }

    const exitCode = await new Promise((resolve) => {
      if (child.exitCode != null) {
        resolve(child.exitCode);
      } else {
        child.once('exit', (code) => resolve(code ?? 0));
      }
    });

    if (aborted) {
      throw err('cancelled', 'code_search cancelled');
    }
    if (exitCode !== 0 && exitCode !== 1) {
      // ripgrep returns 1 when no matches found (not an error). 2+ is a
      // real error.
      if (matches.length === 0) {
        throw err(
          'rg_error',
          `ripgrep exit ${exitCode}: ${stderrBuf.slice(0, 500)}`,
        );
      }
    }
    if (timeoutFired) {
      throw err('tool_timeout', `code_search timed out after ${TIMEOUT_MS}ms`);
    }
  } finally {
    clearTimeout(timeout);
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort);
    }
    if (registry && toolCallId && typeof registry.unregisterChild === 'function') {
      registry.unregisterChild(toolCallId);
    }
  }

  return {
    matches,
    truncated,
    stats: { matches: matches.length, lines_searched: linesSearched },
  };
}

module.exports = { call };
