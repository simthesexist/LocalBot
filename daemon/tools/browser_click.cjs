// Phase 8 Plan 2: browser.click tool.
//
// Clicks a DOM element by CSS selector in the bot's per-bot
// BrowserContext and returns the resulting page innerText (truncated to
// 5KB). Mirrors `daemon/tools/browser_navigate.cjs` (Plan 1): the URL
// allowlist check runs against `page.url()` (the CURRENT URL, not the
// intended click target — page state may have changed since the last
// navigate).
//
// ctx shape (provided by daemon/tools/call through registry.callTool +
// resolveBrowserConfigForBot):
//   - browserAllow:     string[]  (per-bot URL allowlist)
//   - browserDeny:      string[]  (per-bot URL denylist)
//   - ssrfAllowInternal: boolean  (opt-out flag for RFC1918/127/etc.)
//   - bot:              string    (current bot id)
//   - signal:           AbortSignal (cancellation hook for tools/cancel)
//
// Returns:
//   {
//     selector:   args.selector,
//     hostname:   page.url() hostname (no query string — Pitfall 5),
//     path:       page.url() pathname,
//     text:       document.body.innerText.slice(0, 5000),
//     durationMs: ms since t0,
//   }
//
// Threat model coverage:
//   - T-8-14: 10s page.click timeout; selector_not_found error mapping.
//   - T-8-01: checkBrowserUrl runs BEFORE page.click.

const { checkBrowserUrl, getPage } = require('../browser/index.cjs');

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function call(args, ctx) {
  const selector = (args && typeof args.selector === 'string') ? args.selector : '';
  if (!selector) throw err('selector_required', 'selector required');

  if (!ctx || typeof ctx.bot !== 'string' || ctx.bot.length === 0) {
    throw err('browser_not_configured', 'bot context missing');
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

  const t0 = Date.now();
  try {
    await page.click(selector, { timeout: 10000, signal: ctx.signal });
  } catch (e) {
    // Playwright timeout → selector_not_found. Other Playwright errors
    // (e.g. strict mode violation) surface with their own code.
    if (e && (e.name === 'TimeoutError' || /timeout/i.test(e.message || ''))) {
      throw Object.assign(new Error(`selector not found: ${selector}`),
        { code: 'selector_not_found', selector });
    }
    throw e;
  }
  const parsed = new URL(currentUrl);
  const text = await page.evaluate(() =>
    document.body ? document.body.innerText.slice(0, 5000) : ''
  );
  const durationMs = Date.now() - t0;

  return {
    selector,
    hostname: parsed.hostname,
    path: parsed.pathname,
    text,
    durationMs,
  };
}

module.exports = { call };
