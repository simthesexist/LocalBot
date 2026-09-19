// Phase 8 Plan 2: browser.screenshot tool.
//
// Captures a PNG of the current viewport (or full page when fullPage:true)
// and writes it atomically to `<screenshotDir>/<runId>/<n>.png`.
// Quota enforcement:
//   - 50 PNGs per runId (Pitfall 6 / T-8-11)
//   - 500 MB total disk (checked at tools/call entry in main.cjs)
//
// ctx shape (provided by daemon/tools/call):
//   - screenshotDir: string     (e.g. <userData>/screenshots)
//   - runId:         string     (e.g. toolCallId; primary key for the dir)
//   - browserAllow / browserDeny / ssrfAllowInternal / bot / signal
//
// Returns:
//   {
//     path:         '<n>.png'  (filename, relative to <runId>/)
//     absolutePath: <full path under <screenshotDir>/<runId>/>
//     bytes:        PNG byte count,
//     hostname:     page.url() hostname (no query string),
//     path:         page.url() pathname,
//     fullPage:     boolean,
//     durationMs:   ms since t0,
//   }
//
// Threat model coverage:
//   - T-8-11: 50/runId + 500MB total disk quota (Pitfall 6).
//   - T-8-01: checkBrowserUrl runs BEFORE captureScreenshot.

const { checkBrowserUrl, getPage, captureScreenshot, MAX_SCREENSHOTS_PER_RUN } =
  require('../browser/index.cjs');

const fs = require('node:fs/promises');
const path = require('node:path');

const N_REGEX = /^[a-zA-Z0-9._-]{1,32}$/;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Count the existing PNG files in `<screenshotDir>/<runId>/`.
 * Returns 0 when the directory does not exist (ENOENT).
 */
async function countPngsInRun(screenshotDir, runId) {
  const runDir = path.join(screenshotDir, runId);
  let entries;
  try {
    entries = await fs.readdir(runDir);
  } catch (e) {
    if (e && e.code === 'ENOENT') return 0;
    throw e;
  }
  let count = 0;
  for (const name of entries) {
    if (typeof name === 'string' && name.endsWith('.png') && !name.endsWith('.tmp')) count++;
  }
  return count;
}

async function call(args, ctx) {
  if (!ctx || typeof ctx.bot !== 'string' || ctx.bot.length === 0) {
    throw err('browser_not_configured', 'bot context missing');
  }
  if (typeof ctx.screenshotDir !== 'string' || ctx.screenshotDir.length === 0 ||
      typeof ctx.runId !== 'string' || ctx.runId.length === 0) {
    throw err('browser_not_configured', 'screenshotDir or runId missing');
  }

  // Per-runId cap (Pitfall 6). Total cap is checked in main.cjs at the
  // tools/call entry — the disk walker lives there.
  const existingCount = await countPngsInRun(ctx.screenshotDir, ctx.runId);
  if (existingCount >= MAX_SCREENSHOTS_PER_RUN) {
    throw err('screenshot_quota_exceeded',
      `${MAX_SCREENSHOTS_PER_RUN} screenshots per runId exceeded`);
  }

  const page = await getPage(ctx.bot, ctx.signal);
  const currentUrl = page.url();

  const verdict = await checkBrowserUrl({
    browserAllow: Array.isArray(ctx.browserAllow) ? ctx.browserAllow : [],
    browserDeny: Array.isArray(ctx.browserDeny) ? ctx.browserDeny : [],
    ssrfAllowInternal: ctx.ssrfAllowInternal === true,
    url: currentUrl,
  });
  if (!verdict.allowed) {
    const e = new Error(`access denied: ${verdict.reason}`);
    e.code = 'browser_denied';
    e.reason = verdict.reason;
    if (verdict.pattern) e.pattern = verdict.pattern;
    throw e;
  }

  // Default n = timestamp in base36. Validated against safe regex (no path
  // traversal) so the IPC handler can echo it back into an app:// URI.
  const rawN = (args && typeof args.n === 'string' && args.n.length > 0)
    ? args.n
    : Date.now().toString(36);
  if (!N_REGEX.test(rawN)) {
    throw err('invalid_n',
      'n must match /^[a-zA-Z0-9._-]{1,32}$/');
  }

  const fullPage = !!(args && args.fullPage === true);
  const t0 = Date.now();
  const result = await captureScreenshot({
    page,
    screenshotDir: ctx.screenshotDir,
    runId: ctx.runId,
    n: rawN,
    fullPage,
    signal: ctx.signal,
  });
  const parsed = new URL(currentUrl);
  const durationMs = Date.now() - t0;

  return {
    // The audit shape wants `screenshotBytes` + URL `path`, but the tool
    // result also exposes `filename` + `absolutePath` so the IPC handler
    // can build the `app://localhost/screenshots/<runId>/<n>.png` URI
    // without re-reading the file. `path` here is the URL pathname
    // (consumed by browserAuditParams when args.url is missing).
    filename: result.path,
    absolutePath: result.absolutePath,
    bytes: result.bytes,
    hostname: parsed.hostname,
    path: parsed.pathname,
    fullPage: result.fullPage,
    durationMs,
  };
}

module.exports = { call };
