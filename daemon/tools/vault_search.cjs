// vault.search tool — ripgrep-based regex + glob search inside the
// Obsidian vault.
//
// Mirrors daemon/tools/code_search.cjs almost line-for-line, but with
// three vault-specific differences:
//   1. ctx.vaultRoot replaces ctx.workspaceRoot.
//   2. Each match is filtered through checkVaultAccess so the glob
//      pipeline (globalDeny → vaultDeny → vaultAllow) is applied
//      BEFORE the renderer sees the match (T-7-10).
//   3. ripgrep is launched with --no-follow so symlinks outside the
//      vault cannot leak matches (Pitfall Open Question #2).
//
// Audit log payload minimization (mirrors codeSearchAuditParams): the
// audit row records `{query, glob, result_count, truncated}` — never
// the matches payload, never absolute paths, never line snippets. This
// keeps the JSONL audit line well under the 1 MiB cap even for huge
// result sets.

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');
const { checkVaultAccess } = require('../vault/index.cjs');

const MAX_RESULTS_DEFAULT = 200;
const MAX_RESULTS_HARD = 1000;
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
    const platform = process.platform;
    const arch = process.arch;
    const binaryName = platform === 'win32' ? 'rg.exe' : 'rg';
    const platformPkg = `@vscode/ripgrep-${platform}-${arch}`;
    const binPath = require.resolve(`${platformPkg}/package.json`);
    const candidate = path.join(path.dirname(binPath), 'bin', binaryName);
    if (fs.existsSync(candidate)) {
      RG_PATH = candidate;
    } else {
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

function clampInt(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

async function call(
  { pattern, glob, max_results = MAX_RESULTS_DEFAULT },
  ctx,
) {
  // ── Input validation ────────────────────────────────────────────────
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
    if (glob.length > 1024) {
      throw err('invalid_glob', 'glob exceeds 1024 chars');
    }
  }
  if (!ctx || typeof ctx.vaultRoot !== 'string' || ctx.vaultRoot.length === 0) {
    throw err('vault_not_configured', 'vault path not configured (per-bot or global)');
  }

  const maxResults = clampInt(max_results, 1, MAX_RESULTS_HARD);

  const rgPath = await resolveRipgrepBinary();
  if (!rgPath) {
    throw err(
      'rg_not_found',
      'ripgrep binary not found; ensure @vscode/ripgrep optionalDependencies installed',
    );
  }

  // Args as array — never `shell: true`. Pattern + glob + path are validated
  // for NUL bytes above so they cannot be misinterpreted by ripgrep as flags.
  // --no-follow prevents ripgrep from following symlinks outside the vault
  // (Pitfall Open Question #2). vaultRoot is passed as the search root so
  // ripgrep's emitted paths are absolute paths INSIDE vaultRoot — we then
  // compute path.relative() and strip to forward-slash vault-relative.
  const args = ['--json', '--no-messages', '--no-config', '--regexp', pattern, '--no-follow', '--line-buffered'];
  if (glob) args.push('--glob', glob);
  args.push(ctx.vaultRoot);

  const child = spawn(rgPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Register child so tools/cancel can SIGTERM this process.
  const registry = ctx && ctx.registry;
  const toolCallId = ctx && ctx.toolCallId;
  if (registry && toolCallId && typeof registry.registerChild === 'function') {
    registry.registerChild(toolCallId, child);
  }

  const matches = [];
  let truncated = false;
  let stderrBuf = '';
  let aborted = false;

  const onAbort = () => {
    aborted = true;
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
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
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
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
        // Malformed JSON line from ripgrep — skip (the upstream rg should
        // never emit this, but be defensive against future rg changes).
        continue;
      }
      if (evt.type !== 'match' || !evt.data) continue;
      const d = evt.data;
      const absPath = d.path && typeof d.path.text === 'string' ? d.path.text : '';
      if (!absPath) continue;
      // Strip to vault-relative (forward-slash). checkVaultAccess is
      // keyed on vault-relative + forward-slash normalized paths.
      const relPath = path.relative(ctx.vaultRoot, absPath).replace(/\\/g, '/');
      const access = checkVaultAccess({
        globalDeny: (ctx.globalDeny || []),
        vaultDeny: (ctx.vaultDeny || []),
        vaultAllow: (ctx.vaultAllow || []),
        relativePath: relPath,
      });
      if (!access.allowed) continue; // T-7-10: glob pipeline filter
      if (matches.length >= maxResults) {
        // Cap reached. Mark truncated and kill the child to avoid
        // wasting cycles searching more of the vault.
        truncated = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        break;
      }
      matches.push({
        path: relPath,
        line: typeof d.line_number === 'number' ? d.line_number : 0,
        text: ((d.lines && typeof d.lines.text === 'string') ? d.lines.text : '').replace(/\n$/, ''),
      });
    }

    const exitCode = await new Promise((resolve) => {
      if (child.exitCode != null) {
        resolve(child.exitCode);
      } else {
        child.once('exit', (code) => resolve(code ?? 0));
      }
    });

    if (aborted && !truncated) {
      throw err('cancelled', 'vault.search cancelled');
    }
    if (exitCode !== 0 && exitCode !== 1 && !truncated) {
      // ripgrep returns 1 when no matches found (not an error). 2+ is a
      // real error. Only surface as rg_failed when we haven't already
      // truncated — truncated calls deliberately kill the child and the
      // exit code is meaningless.
      if (matches.length === 0) {
        throw err(
          'rg_error',
          `ripgrep exit ${exitCode}: ${stderrBuf.slice(0, 500)}`,
        );
      }
    }
    if (timeoutFired && !truncated) {
      throw err('tool_timeout', `vault.search timed out after ${TIMEOUT_MS}ms`);
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
    count: matches.length,
  };
}

module.exports = { call };