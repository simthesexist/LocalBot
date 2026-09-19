// Phase 8 Plan 1: browser.navigate tool. The first Playwright-backed
// tool in the daemon — navigates to a URL in the bot's per-bot
// BrowserContext and returns the rendered page title + visible text.
//
// Template: `daemon/tools/vault_read.cjs` — same shape (ctx carries the
// resolved per-bot config; result is the minimal data the LLM needs).
//
// ctx shape (provided by daemon/tools/call through registry.callTool +
// resolveBrowserConfigForBot):
//   - browserAllow:     string[]  (per-bot URL allowlist)
//   - browserDeny:      string[]  (per-bot URL denylist)
//   - ssrfAllowInternal: boolean  (opt-out flag for RFC1918/127/etc.)
//   - bot:              string    (current bot id)
//   - signal:           AbortSignal (cancellation hook for tools/cancel)
//   - workspaceRoot, botDir, toolCallId, ... (Phase 2 baseline ctx)
//
// Returns:
//   {
//     url:         hostname + pathname (NO query string — Pitfall 5),
//     status:      HTTP status code | null,
//     title:       page.title(),
//     text:        page.evaluate(() => document.body.innerText.slice(0, 50000)),
//     bytes:       Buffer.byteLength(text, 'utf8'),
//     durationMs:  ms since t0,
//   }
//
// Threat model coverage:
//   - T-8-01: checkBrowserUrl runs BEFORE any Playwright API.
//   - T-8-04: --no-sandbox flag is set in lifecycle.cjs (not here).
//   - T-8-02: normalizedUrl never carries the query string so audit rows
//     stay free of `?token=...` style leakage.

const { checkBrowserUrl, getPage } = require('../browser/index.cjs');

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * browser_navigate.call(args, ctx) → Promise<{url,status,title,text,bytes,durationMs}>
 *
 * Throws `{code:'browser_not_configured'}` when ctx.bot is missing,
 * `{code:'browser_denied', reason, pattern}` when checkBrowserUrl rejects
 * the URL, `{code:'aborted'}` when the per-call AbortController fires.
 */
async function call(args, ctx) {
  const url = (args && typeof args.url === 'string') ? args.url : '';
  if (!url) throw err('invalid_url', 'url required');

  if (!ctx || typeof ctx.bot !== 'string' || ctx.bot.length === 0) {
    throw err('browser_not_configured', 'bot context missing');
  }

  const verdict = await checkBrowserUrl({
    browserAllow: Array.isArray(ctx.browserAllow) ? ctx.browserAllow : [],
    browserDeny: Array.isArray(ctx.browserDeny) ? ctx.browserDeny : [],
    ssrfAllowInternal: ctx.ssrfAllowInternal === true,
    url,
  });

  if (!verdict.allowed) {
    const e = new Error(`access denied: ${verdict.reason}`);
    e.code = 'browser_denied';
    e.reason = verdict.reason;
    if (verdict.pattern) e.pattern = verdict.pattern;
    throw e;
  }

  // Compute normalizedUrl (hostname + pathname ONLY) for the success
  // payload + audit row. We re-parse here because the URL was already
  // validated by checkBrowserUrl, so a second parse is safe.
  const parsed = new URL(url);
  const normalizedUrl = parsed.hostname + parsed.pathname;

  const t0 = Date.now();
  const page = await getPage(ctx.bot, ctx.signal);
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
    signal: ctx.signal,
  });
  const title = await page.title();
  const text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 50000) : '');
  const durationMs = Date.now() - t0;
  const status = response && typeof response.status === 'function' ? response.status() : null;

  return {
    url: normalizedUrl,
    status,
    title,
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    durationMs,
  };
}

module.exports = { call };