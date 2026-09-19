// Phase 8 Plan 2: browser screenshot capture helper.
//
// Mirrors the atomic tmp + rename pattern from `daemon/tools/vault_write.cjs`
// (Pitfall 6). Writes the PNG via `fs.writeFile(tmp, buf)` then
// `fs.rename(tmp, finalPath)` so a partial PNG is never visible at the
// canonical path. The intermediate <runId>/ directory is created via
// `fs.mkdir(..., { recursive: true })` so the daemon never has to know in
// advance which runIds exist.
//
// Quota constants live here so the audit dispatcher in main.cjs and the
// tool handler in browser_screenshot.cjs share a single source of truth.
// The 500 MB total cap is enforced at the tools/call entry in main.cjs
// (it owns the directory walker); the per-runId 50 cap is enforced inside
// browser_screenshot.cjs (it owns the runId dir lookup).
//
// Threat model coverage:
//   - T-8-11: disk quota — 50 per runId + 500 MB total.
//   - Pitfall 6: atomic write — no partial PNG at canonical path.

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_SCREENSHOTS_PER_RUN = 50;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * captureScreenshot({page, screenshotDir, runId, n, fullPage})
 *   → Promise<{bytes, path: filename, absolutePath, fullPage}>
 *
 * Captures a PNG via Playwright's `page.screenshot({type:'png', fullPage})`,
 * mkdir -p's `<screenshotDir>/<runId>/`, writes the PNG via tmp + rename.
 *
 * Throws `{code:'aborted'}` if `signal` is already aborted. Returns the
 * filename (`<n>.png`), the absolute path, and the byte count. Callers
 * (browser_screenshot.cjs) thread the relative path + bytes into the tool
 * result; the IPC handler builds the `app://` URI from filename.
 */
async function captureScreenshot({ page, screenshotDir, runId, n, fullPage, signal }) {
  if (!page || typeof page.screenshot !== 'function') {
    throw err('screenshot_invalid_page', 'page.screenshot not available');
  }
  if (typeof screenshotDir !== 'string' || screenshotDir.length === 0) {
    throw err('screenshot_invalid_dir', 'screenshotDir required');
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw err('screenshot_invalid_run', 'runId required');
  }
  if (typeof n !== 'string' || n.length === 0) {
    throw err('screenshot_invalid_n', 'n required');
  }
  if (signal && signal.aborted) {
    throw err('aborted', 'aborted');
  }

  const useFullPage = fullPage === true;
  const buf = await page.screenshot({ type: 'png', fullPage: useFullPage });
  if (signal && signal.aborted) {
    throw err('aborted', 'aborted');
  }

  const runDir = path.join(screenshotDir, runId);
  await fs.mkdir(runDir, { recursive: true });
  const filename = `${n}.png`;
  const fullPath = path.join(runDir, filename);
  const tmp = `${fullPath}.tmp`;
  try {
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, fullPath);
  } catch (e) {
    try { await fs.unlink(tmp); } catch { /* ignore — tmp may be missing */ }
    throw e;
  }

  return {
    bytes: buf.length,
    path: filename,
    absolutePath: fullPath,
    fullPage: useFullPage,
  };
}

module.exports = {
  captureScreenshot,
  MAX_SCREENSHOTS_PER_RUN,
  MAX_TOTAL_BYTES,
  // Test seam — unit tests import captureScreenshot through this seam so
  // the module surface stays minimal in production.
  __test__: { captureScreenshot, MAX_SCREENSHOTS_PER_RUN, MAX_TOTAL_BYTES },
};
