// Phase 8 Plan 2: browser.fill_form tool.
//
// Fills multiple form fields in a single tool call via Promise.all (parallel,
// not sequential). Each field is `{selector: string, value: string}`.
// Optional `submit: {selector: string}` clicks a final button after all
// fills complete. Audit minimization: NEVER log field values (Pitfall 5).
// The audit shape carries `fieldCount` only.
//
// ctx shape matches browser_navigate.cjs (Phase 1).
//
// Threat model coverage:
//   - T-8-10: audit NEVER includes field values; fieldCount only.
//   - T-8-15: 5s per-field timeout + abort signal propagation.

const { checkBrowserUrl, getPage } = require('../browser/index.cjs');

const MAX_FIELDS = 20;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function validateFields(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw err('invalid_fields', 'fields must be a non-empty array');
  }
  if (raw.length > MAX_FIELDS) {
    throw err('too_many_fields', `up to ${MAX_FIELDS} fields per call`);
  }
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    if (!f || typeof f !== 'object') {
      throw err('invalid_fields', `field[${i}] must be an object`);
    }
    if (typeof f.selector !== 'string' || f.selector.length === 0) {
      throw err('invalid_fields', `field[${i}].selector must be a non-empty string`);
    }
    if (typeof f.value !== 'string') {
      throw err('invalid_fields', `field[${i}].value must be a string`);
    }
  }
}

async function call(args, ctx) {
  if (!args || !Array.isArray(args.fields)) {
    throw err('invalid_fields', 'fields must be array');
  }
  validateFields(args.fields);

  let submitSelector = null;
  if (args.submit && typeof args.submit === 'object') {
    if (typeof args.submit.selector !== 'string' || args.submit.selector.length === 0) {
      throw err('invalid_submit', 'submit.selector must be a non-empty string');
    }
    submitSelector = args.submit.selector;
  }

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
  // Parallel fills — Promise.all so a multi-field form completes in
  // ~max(per-field) instead of sum(per-field). signal propagation: each
  // fill accepts the same signal so an abort fires the AbortError on the
  // first in-flight .fill() and the rest reject promptly.
  try {
    await Promise.all(args.fields.map(async (f) => {
      await page.locator(f.selector).fill(f.value, { timeout: 5000, signal: ctx.signal });
    }));
  } catch (e) {
    if (ctx && ctx.signal && ctx.signal.aborted) {
      throw Object.assign(new Error('aborted'), { code: 'aborted' });
    }
    throw e;
  }

  let submitted = false;
  if (submitSelector) {
    await page.click(submitSelector, { timeout: 5000, signal: ctx.signal });
    submitted = true;
  }

  const text = await page.evaluate(() =>
    document.body ? document.body.innerText.slice(0, 5000) : ''
  );
  const parsed = new URL(currentUrl);
  const durationMs = Date.now() - t0;

  // Pitfall 5: NEVER include field values in the return value or audit.
  return {
    fieldCount: args.fields.length,
    hostname: parsed.hostname,
    path: parsed.pathname,
    submitted,
    text,
    durationMs,
  };
}

module.exports = { call };
