// Phase 8 Plan 2: browser.evaluate tool.
//
// Executes an arbitrary JavaScript expression in the page context via
// `page.evaluate(expression, {timeout, signal})`. 10s timeout + 50KB result
// cap. Audit minimization: NEVER log the expression source or the result
// value (Pitfall 5). The audit shape carries `expressionBytes` (count)
// and `resultBytes` only.
//
// ctx shape matches browser_navigate.cjs (Phase 1).
//
// Threat model coverage:
//   - T-8-09: 50KB result cap (result_too_large); expressionBytes audit.
//   - T-8-13: 10s timeout via Playwright signal option + setTimeout guard.

const { checkBrowserUrl, getPage } = require('../browser/index.cjs');

const MAX_EXPRESSION_BYTES = 100 * 1024; // 100 KB
const MAX_RESULT_BYTES = 50 * 1024;      // 50 KB
const TIMEOUT_MS = 10_000;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function call(args, ctx) {
  const expression = (args && typeof args.expression === 'string') ? args.expression : '';
  if (!expression) {
    throw err('invalid_expression', 'expression required');
  }
  if (expression.includes('\x00')) {
    throw err('invalid_expression', 'expression contains NUL byte');
  }
  const exprBytes = Buffer.byteLength(expression, 'utf8');
  if (exprBytes > MAX_EXPRESSION_BYTES) {
    throw err('expression_too_large', `expression exceeds ${MAX_EXPRESSION_BYTES} bytes`);
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

  // Set up a local abort guard so we can surface {code:'tool_timeout'} when
  // Playwright's evaluate doesn't honor our signal option on its own. The
  // setTimeout fires unconditionally; we only treat it as a real timeout
  // when the page.evaluate Promise hasn't resolved yet.
  let timedOut = false;
  const guard = setTimeout(() => { timedOut = true; }, TIMEOUT_MS);
  const outerSignal = ctx && ctx.signal;
  if (outerSignal && typeof outerSignal.addEventListener === 'function') {
    outerSignal.addEventListener('abort', () => { timedOut = true; }, { once: true });
  }

  const t0 = Date.now();
  let result;
  try {
    result = await page.evaluate(expression, { timeout: TIMEOUT_MS, signal: outerSignal });
  } catch (e) {
    clearTimeout(guard);
    if (timedOut) {
      throw err('tool_timeout', 'evaluation timed out');
    }
    throw e;
  }
  clearTimeout(guard);

  const resultStr = (typeof result === 'string') ? result : JSON.stringify(result);
  const resultBytes = Buffer.byteLength(resultStr, 'utf8');
  if (resultBytes > MAX_RESULT_BYTES) {
    throw Object.assign(new Error('evaluation result exceeds 50KB'),
      { code: 'result_too_large', resultBytes });
  }
  const durationMs = Date.now() - t0;
  if (timedOut) {
    throw err('tool_timeout', 'evaluation timed out');
  }

  const parsed = new URL(currentUrl);
  // Pitfall 5: NEVER include the expression source in the result. Audit
  // shape carries `expressionBytes` (the count) but not the source.
  return {
    expressionBytes: exprBytes,
    resultBytes,
    result: resultStr,
    hostname: parsed.hostname,
    path: parsed.pathname,
    durationMs,
  };
}

module.exports = { call };
