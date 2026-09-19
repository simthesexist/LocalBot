// Phase 8 Plan 2: browser.type tool.
//
// Fills an input via `page.locator(selector).fill(text)` (NOT page.type —
// Playwright's `.fill()` triggers the proper input/change events; raw
// page.type fires keypress events that can confuse frameworks like React).
// Optional `submit: true` flag presses Enter after fill.
//
// Pitfall 5: the audit row NEVER contains the typed text. The return
// payload exposes `textBytes` (Buffer.byteLength) so the audit shape can
// record the size without the content. There is no `text` field on the
// success result.
//
// ctx shape matches browser_navigate.cjs (Phase 1).
//
// Threat model coverage:
//   - T-8-08: audit NEVER includes typed text; textBytes only.

const { checkBrowserUrl, getPage } = require('../browser/index.cjs');

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function call(args, ctx) {
  const selector = (args && typeof args.selector === 'string') ? args.selector : '';
  const text = (args && typeof args.text === 'string') ? args.text : '';
  const submit = !!(args && args.submit === true);

  if (!selector) throw err('selector_required', 'selector required');
  if (!text) throw err('invalid_text', 'text required');
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
  await page.locator(selector).fill(text, { timeout: 5000, signal: ctx.signal });
  if (submit) {
    await page.press('Enter', { timeout: 5000, signal: ctx.signal });
  }
  const parsed = new URL(currentUrl);
  const durationMs = Date.now() - t0;

  // Pitfall 5: NEVER include typed text. Audit shape carries textBytes only.
  return {
    selector,
    textBytes: Buffer.byteLength(text, 'utf8'),
    hostname: parsed.hostname,
    path: parsed.pathname,
    submitted: submit,
    durationMs,
  };
}

module.exports = { call };
