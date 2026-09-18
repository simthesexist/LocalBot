// Filesystem watcher wrapper (Phase 3 Wave 2). Pure CommonJS.
//
// Watches one or more root directories via chokidar and emits a single
// debounced `refresh` event per debounce window. The renderer subscribes to
// `tree:refresh` notifications the daemon broadcasts back over the NDJSON
// pipeline so the workspace tree re-fetches within ~500ms of any file change.
//
// Why debounce: per RESEARCH.md §"Pitfall 3", a single `git checkout` can
// emit thousands of `change` events. Debouncing coalesces them so we don't
// spam `tree:list` (which itself walks the tree).

const chokidar = require('chokidar');

/**
 * @typedef {Object} RefreshPayload
 * @property {string} rootPath   absolute path of the root that changed
 * @property {string[]} changedPaths  relative paths (root-relative) of files that changed
 */

/**
 * Create a watcher for the given root paths. `rootPaths` is an array of
 * `{id, absPath}` records; the refresh event carries the `absPath` of the
 * root that triggered it. Multiple roots emit their own debounced refresh.
 *
 * @param {Array<{id: string, absPath: string}>} rootPaths
 * @param {{debounceMs?: number}} opts
 * @returns {{start: () => void, stop: () => void, on: (event: 'refresh', cb: (p: RefreshPayload) => void) => () => void}}
 */
function createWatcher(rootPaths, opts) {
  const debounceMs = (opts && typeof opts.debounceMs === 'number') ? opts.debounceMs : 250;

  // Map<absPath, { id, absPath, pendingChanged: Set<string>, timer: NodeJS.Timeout | null, listeners: Array<Function> }>
  const state = new Map();
  for (const r of rootPaths || []) {
    state.set(r.absPath, {
      id: r.id,
      absPath: r.absPath,
      pendingChanged: new Set(),
      timer: null,
      listeners: [],
    });
  }

  // Global listener registry — `on('refresh', cb)` registers for every root.
  // Simpler than an EventEmitter here because we have one event.
  const globalListeners = [];

  let watcher = null;
  let started = false;

  function emitRefresh(rootEntry) {
    const payload = {
      rootPath: rootEntry.absPath,
      changedPaths: Array.from(rootEntry.pendingChanged),
    };
    rootEntry.pendingChanged.clear();
    rootEntry.timer = null;
    for (const cb of globalListeners) {
      try { cb(payload); } catch { /* ignore listener errors */ }
    }
  }

  function scheduleEmit(rootEntry) {
    if (rootEntry.timer) {
      clearTimeout(rootEntry.timer);
    }
    rootEntry.timer = setTimeout(() => emitRefresh(rootEntry), debounceMs);
  }

  function findRoot(absFilePath) {
    // Match the longest absPath prefix so nested roots route to their
    // closest ancestor. The renderer re-fetches only the section whose
    // rootPath prefix matches.
    let best = null;
    for (const absRoot of state.keys()) {
      if (absFilePath === absRoot || absFilePath.startsWith(absRoot + require('node:path').sep)) {
        if (!best || absRoot.length > best.length) best = absRoot;
      }
    }
    return best;
  }

  function start() {
    if (started || state.size === 0) return;
    const paths = Array.from(state.keys());
    watcher = chokidar.watch(paths, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      persistent: true,
      ignored: ['**/node_modules/**', '**/.git/**'],
      // Polling:false is the default. Windows-first; chokidar's native
      // watcher works on Windows 11 (RESEARCH.md A2). Tests can opt into
      // polling by passing POLLING_TEST=1 — some CI runners (Windows
      // containers, sandboxed runners) don't deliver ReadDirectoryChangesW
      // events to Node's event loop.
      usePolling: process.env.LOCALBOT_WATCHER_POLLING === '1',
      interval: 200,
    });
    const handler = (eventName) => (p) => {
      const rootPath = findRoot(p);
      if (!rootPath) return;
      const rel = p.startsWith(rootPath) ? p.slice(rootPath.length).replace(/^[\\/]/, '') : p;
      const rootEntry = state.get(rootPath);
      if (!rootEntry) return;
      rootEntry.pendingChanged.add(rel);
      scheduleEmit(rootEntry);
    };
    watcher.on('add', handler('add'));
    watcher.on('change', handler('change'));
    watcher.on('unlink', handler('unlink'));
    started = true;
  }

  async function stop() {
    if (watcher) {
      try { await watcher.close(); } catch { /* ignore */ }
      watcher = null;
    }
    started = false;
    // Clear any pending timers so we don't leak Node Timer handles.
    for (const rootEntry of state.values()) {
      if (rootEntry.timer) {
        clearTimeout(rootEntry.timer);
        rootEntry.timer = null;
      }
      rootEntry.pendingChanged.clear();
    }
  }

  function on(event, cb) {
    if (event !== 'refresh') return () => {};
    globalListeners.push(cb);
    return () => {
      const i = globalListeners.indexOf(cb);
      if (i >= 0) globalListeners.splice(i, 1);
    };
  }

  return {
    start,
    stop,
    on,
    // Exposed for tests.
    __test: { state, scheduleEmit, findRoot },
  };
}

module.exports = { createWatcher };
