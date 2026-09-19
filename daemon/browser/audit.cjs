// Phase 8 Plan 1: browser audit minimization (T-8-02). Extracted into a
// standalone module so unit tests can import it without booting the entire
// daemon. `daemon/main.cjs` requires this module and re-exports nothing —
// the function is referenced via `require('./browser/audit.cjs')` inside
// the audit dispatch branch.
//
// Threat model coverage:
//   - T-8-02: NEVER include the full URL or query string; NEVER include
//     rendered HTML, typed text, or screenshot bytes. The audit row carries
//     only {hostname, path, status?, duration_ms, screenshotBytes?,
//     expressionBytes?, fieldCount?}.
//
// `pattern` and other future per-rejection fields are intentionally NOT
// included; the goal is a fixed, minimal shape so audit readers never have
// to special-case tool-specific shapes.

/**
 * browserAuditParams(name, args, successResult)
 *   → {hostname, path, status?, duration_ms, screenshotBytes?,
 *      expressionBytes?, fieldCount?}
 *
 * Per-tool deltas:
 *   - browser.navigate: hostname + path + status + duration_ms
 *   - browser.click / browser.type: hostname + path + status + duration_ms
 *     (Plan 2)
 *   - browser.screenshot: hostname + path + screenshotBytes (Plan 2)
 *   - browser.evaluate: hostname + path + expressionBytes (Plan 2)
 *   - browser.fill_form: hostname + path + fieldCount (Plan 2)
 *
 * For unknown browser.* names or malformed URLs, hostname + path fall
 * back to empty strings — never the raw URL or the query string.
 */
function browserAuditParams(name, args, successResult) {
  const out = {
    hostname: '',
    path: '',
    status: undefined,
    duration_ms: 0,
    screenshotBytes: undefined,
    expressionBytes: undefined,
    fieldCount: undefined,
  };

  // Plan 1 (browser.navigate): args.url carries the URL.
  // Plan 2 (click/type/fill_form/screenshot/evaluate): args has no URL —
  // the URL is in successResult.{hostname, path} because the tool
  // parses `page.url()` after the Playwright action. Fall back to
  // successResult when args.url is absent so the audit row still has
  // hostname/path for the Plan 2 tools.
  let parsed = null;
  const candidate = (args && typeof args.url === 'string') ? args.url : '';
  if (candidate) {
    try { parsed = new URL(candidate); } catch { /* malformed — leave hostname/path empty */ }
  }
  if (parsed) {
    out.hostname = parsed.hostname || '';
    out.path = parsed.pathname || '';
  } else if (successResult && typeof successResult === 'object') {
    if (typeof successResult.hostname === 'string') out.hostname = successResult.hostname;
    if (typeof successResult.path === 'string') out.path = successResult.path;
  }

  if (successResult && typeof successResult === 'object') {
    if (typeof successResult.status === 'number') out.status = successResult.status;
    if (typeof successResult.durationMs === 'number') out.duration_ms = successResult.durationMs;
  }

  if (name === 'browser.screenshot') {
    out.screenshotBytes = (successResult && typeof successResult.bytes === 'number') ? successResult.bytes : 0;
  } else if (name === 'browser.evaluate') {
    const expr = (args && typeof args.expression === 'string') ? args.expression : '';
    out.expressionBytes = Buffer.byteLength(expr, 'utf8');
  } else if (name === 'browser.fill_form') {
    out.fieldCount = (args && Array.isArray(args.fields)) ? args.fields.length : 0;
  }

  return out;
}

module.exports = { browserAuditParams };