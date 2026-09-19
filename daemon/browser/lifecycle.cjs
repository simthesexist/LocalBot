// Phase 8 Plan 1: lazy Chromium lifecycle. The daemon does NOT launch
// Chromium at startup; it caches the launch promise on first `browser_*`
// tool call so bots that never browse save ~150MB of RAM and the
// Playwright driver cost (Pitfall: lazy launch).
//
// Mirrors the `resolveRipgrepBinary` lazy-promise pattern at
// `daemon/scheduler/index.cjs:34-64` — module-scope cached promise, reset
// on transient failure so a Chromium crash doesn't poison the daemon.
//
// Launch flags:
//   - `--no-sandbox`: required because the daemon child is spawned by
//     Electron (main process), not a root shell. Chromium's sandbox would
//     refuse to run; the daemon's process boundary already isolates the
//     daemon from the bot's content.
//   - `--disable-dev-shm-usage`: documented workaround for /dev/shm being
//     too small in some Linux containers. Harmless on Windows.
//
// Threat model coverage:
//   - T-8-05: crash recovery — `.catch(() => { browserPromise = null; })`
//     resets the cache on transient launch failures so the next call
//     retries rather than poisoning the daemon forever.

const { chromium } = require('playwright-core');

let browserPromise = null;

/**
 * ensureBrowser() → Promise<Browser>. Caches the launch promise so
 * concurrent first-callers don't double-launch. On rejection the cache is
 * cleared so the next call retries Chromium from scratch.
 */
function ensureBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

/**
 * closeBrowser() → Promise<void>. Best-effort shutdown of the cached
 * Chromium instance; clears the cache so the next ensureBrowser() relaunches.
 * Called from `bots/delete` cleanup (Pitfall 7) and from daemon shutdown.
 */
async function closeBrowser() {
  if (browserPromise) {
    let b;
    try {
      b = await browserPromise;
    } catch {
      // Already rejected — cache is already null per the .catch above.
      return;
    }
    try {
      if (b && typeof b.close === 'function') await b.close();
    } catch {
      /* ignore — Chromium may already be gone */
    }
    browserPromise = null;
  }
}

module.exports = {
  ensureBrowser,
  closeBrowser,
  // Test seam — unit tests clear the promise cache between cases.
  __test__: {
    reset: () => {
      browserPromise = null;
    },
  },
};