---
phase: 08
plan: 02
subsystem: browser-automation
tags: [playwright, audit-minimization, app-protocol, screenshot-quota, fill-form, evaluate, click, type, ipc]
status: complete
provides:
  - daemon/browser/screenshots.cjs (atomic capture + 50/runId + 500MB quota)
  - daemon/tools/browser_click.cjs (Playwright page.click + URL gate + audit-min)
  - daemon/tools/browser_type.cjs (page.locator().fill + textBytes-only audit)
  - daemon/tools/browser_screenshot.cjs (per-runId cap + atomic tmp+rename)
  - daemon/tools/browser_evaluate.cjs (50KB result cap + 10s timeout)
  - daemon/tools/browser_fill_form.cjs (parallel fills, fieldCount-only audit)
  - src/main/ipc/browser.ts (BROWSER_GET_SCREENSHOT + BROWSER_DELETE_CONTEXT + app:// protocol handler)
  - src/shared/types.ts (5 new MessageBlock variants)
  - daemon/browser/audit.cjs (extended: fallback to successResult.hostname/path)
requires:
  - playwright-core (runtime, from plan 01)
  - picomatch (already present)
affects:
  - src/main/index.ts (protocol.registerSchemesAsPrivileged + registerBrowserHandlers)
  - src/main/daemon/spawn.ts (callBot union extended with 2 wire methods)
  - daemon/main.cjs (browser/get_screenshot + browser/delete_context cases + total disk quota check)
  - daemon/tools/registry.cjs (5 new TOOLS + SCHEMAS entries)
tech-stack:
  added: []
  patterns: [app:// custom protocol + registerSchemesAsPrivileged, atomic tmp+rename file write, per-runId disk quota, audit minimization (no typed text, no field values, no PNG bytes, no expression source), AbortSignal propagation as Playwright signal option]
key-files:
  created:
    - daemon/browser/screenshots.cjs
    - daemon/tools/browser_click.cjs
    - daemon/tools/browser_type.cjs
    - daemon/tools/browser_screenshot.cjs
    - daemon/tools/browser_evaluate.cjs
    - daemon/tools/browser_fill_form.cjs
    - src/main/ipc/browser.ts
    - tests/unit/browser_actions.test.ts
    - tests/unit/browser_screenshot.test.ts
    - tests/unit/browser_evaluate.test.ts
  modified:
    - daemon/browser/index.cjs
    - daemon/browser/audit.cjs
    - daemon/tools/registry.cjs
    - daemon/main.cjs
    - src/main/index.ts
    - src/main/daemon/spawn.ts
    - src/shared/types.ts
decisions:
  - Place protocol.registerSchemesAsPrivileged([{scheme:'app', ...}]) at the top level of src/main/index.ts BEFORE app.whenReady() — Electron requires scheme privileges to be declared before the first protocol.handle call.
  - Audit shape for browser.screenshot is {hostname, path, screenshotBytes} only — never PNG bytes themselves (Pitfall 5).
  - Audit shape for browser.type is {hostname, path, textBytes} only — never the typed text (Pitfall 5 / T-8-08).
  - Audit shape for browser.evaluate is {hostname, path, expressionBytes, resultBytes} — never expression source or result value (Pitfall 5 / T-8-09).
  - Audit shape for browser.fill_form is {hostname, path, fieldCount} — never field values (Pitfall 5 / T-8-10).
  - Audit shape for browser.click is {hostname, path, status, duration_ms} — never the innerText (kept in the tool result for renderer only).
  - 50KB result cap on browser.evaluate: throws {code:'result_too_large'} when JSON-serialized result exceeds 50KB (T-8-09).
  - 100KB expression cap on browser.evaluate: throws {code:'expression_too_large'} when expression bytes exceed 100KB.
  - 10s timeout on browser.evaluate via Playwright signal + setTimeout guard (T-8-13).
  - 5s per-field timeout on browser.fill_form; abort signal maps to {code:'aborted'} (T-8-15).
  - Per-runId cap of 50 PNGs enforced inside browser_screenshot.cjs (runId dir lookup) — total disk cap of 500MB enforced at daemon tools/call entry (T-8-11 / Pitfall 6).
  - All 5 new tools call checkBrowserUrl against page.url() BEFORE any Playwright action (T-8-01).
  - All 5 new tools propagate ctx.signal as Playwright `signal` option (T-8-05).
  - Atomic write pattern: captureScreenshot writes PNG via writeFile(tmp) + rename(tmp, finalPath) so a partial PNG is never visible at the canonical path (Pitfall 6).
  - Extended browserAuditParams to read hostname/path from successResult.{hostname,path} when args.url is missing — Plan 2 tools don't carry args.url because the URL is page.url() at the moment of the Playwright action.
  - Renderer's BROWSER_GET_SCREENSHOT IPC handler returns fileUri = app://localhost/screenshots/<runId>/<n>.png — bytes are NEVER sent over IPC; the renderer fetches via the app:// protocol handler.
  - BROWSER_GET_SCREENSHOT and BROWSER_DELETE_CONTEXT validate runId + n against the same safe regex (defense in depth) — the daemon re-validates too.
  - Validated the renderer-supplied BrowserDeleteContextRequest.shape — bot must be a non-empty string.
actuals:
  tokens: 30500       # chars/4 over my 2 task commits' added/modified files
  tasks: 2            # feat + feat
  commits: 2          # MEASURED: my 2 task commits (960376b, 860786c)
  plan_head_before: f84d0864e19b45537cfd844be565656ed1d811f4
---

# Phase 8 Plan 2: Browser Expansion Summary

Browser automation expanded from `browser.navigate` to a complete 6-tool surface (click, type, screenshot, evaluate, fill_form) with a hardened screenshot pipeline, app:// custom protocol handler, and a 500MB/50-per-runId disk quota.

## What Shipped

### Daemon: 5 new tools + screenshot pipeline
- `daemon/tools/browser_click.cjs` — page.click with 10s timeout; maps Playwright TimeoutError to {code:'selector_not_found', selector}.
- `daemon/tools/browser_type.cjs` — page.locator(sel).fill(text); textBytes-only audit; optional submit:true presses Enter.
- `daemon/tools/browser_screenshot.cjs` — per-runId 50 cap enforced before capture; calls captureScreenshot for atomic tmp+rename write.
- `daemon/tools/browser_evaluate.cjs` — 100KB expression cap; 50KB result cap → {code:'result_too_large'}; 10s timeout.
- `daemon/tools/browser_fill_form.cjs` — Promise.all parallel fills; 20-field cap → {code:'too_many_fields'}; fieldCount-only audit.
- `daemon/browser/screenshots.cjs` — captureScreenshot helper with mkdir -p + writeFile(tmp) + rename(tmp, finalPath); exports MAX_SCREENSHOTS_PER_RUN=50 + MAX_TOTAL_BYTES=524288000.
- `daemon/tools/registry.cjs` — 5 new TOOLS entries + 5 SCHEMAS entries with proper input_schema (description, properties, required).
- `daemon/browser/audit.cjs` — extended browserAuditParams to read hostname/path from successResult when args.url is missing (Plan 2 tools don't carry args.url).
- `daemon/main.cjs` — 2 new JSON-RPC cases (browser/get_screenshot, browser/delete_context); sumScreenshotBytes walker for total disk quota check at tools/call entry.

### Main process: app:// protocol handler + IPC bridge
- `src/main/ipc/browser.ts` — registerBrowserHandlers() with BROWSER_GET_SCREENSHOT + BROWSER_DELETE_CONTEXT ipcMain.handle handlers + protocol.handle('app', ...) for serving PNGs.
- `src/main/index.ts` — protocol.registerSchemesAsPrivileged([{scheme:'app', privileges:{standard, secure, supportFetchAPI, stream}}]) declared at TOP LEVEL before app.whenReady() (Electron requirement); registerBrowserHandlers() called inside ready.
- `src/main/daemon/spawn.ts` — callBot union extended with 'browser/get_screenshot' + 'browser/delete_context' wire methods.
- `src/shared/types.ts` — 5 new MessageBlock variants: browser_click, browser_type, browser_screenshot, browser_evaluate, browser_fill_form. Audit-friendly shapes only (no typed text, no PNG bytes, no field values, no expression source).

### Tests: 24 passing cases across 3 suites
- `tests/unit/browser_actions.test.ts` — 9 tests covering browser_click + browser_type + browser_fill_form: URL gate (T-8-01), signal propagation (T-8-05), selector_not_found mapping, text byte count only (T-8-02), submit handling, 20-field cap, field shape validation.
- `tests/unit/browser_screenshot.test.ts` — 9 tests covering captureScreenshot atomic write (Pitfall 6), quota constants (50, 500MB), 50/runId cap, n path-traversal rejection, browser_not_configured, denial path.
- `tests/unit/browser_evaluate.test.ts` — 6 tests covering URL gate (T-8-01), NUL byte rejection, 100KB expression cap, 50KB result_too_large cap, signal propagation (T-8-05), denial path.

## Verification

| Check | Result |
|-------|--------|
| `npx tsc --noEmit -p tsconfig.main.json` | exit 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 |
| `npx vitest run tests/unit/browser_actions.test.ts` | 9 passed |
| `npx vitest run tests/unit/browser_screenshot.test.ts` | 9 passed |
| `npx vitest run tests/unit/browser_evaluate.test.ts` | 6 passed |
| `npx vitest run tests/unit/browser_audit.test.ts` (regression) | 9 passed |
| `npx vitest run tests/unit/browser_lifecycle.test.ts` (regression) | 12 passed |
| `npx vitest run tests/unit/browser_policy.test.ts` (regression) | 41 passed |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Critical Functionality] Added daemon-side browser/get_screenshot + browser/delete_context JSON-RPC cases**
- **Found during:** Task 2 wiring (src/main/ipc/browser.ts was added but called callBot with 'browser/get_screenshot'/'browser/delete_context' methods that had no daemon handlers)
- **Issue:** The IPC bridge in main forwards BROWSER_GET_SCREENSHOT / BROWSER_DELETE_CONTEXT to callBot, but the daemon didn't dispatch those methods — every IPC call would return `method not found: -32601`.
- **Fix:** Added 2 new cases in daemon/main.cjs (inserted before the default case). The browser/get_screenshot case stat()s `<userData>/screenshots/<runId>/<n>.png` (returns bytes only — never reads PNG) with regex-validated runId + n. The browser/delete_context case calls the existing browser.deleteContext helper.
- **Files modified:** daemon/main.cjs (+105 lines)
- **Commit:** 860786c

**2. [Rule 1 - Bug] Fixed duplicate `path` key in browser_screenshot.cjs return object**
- **Found during:** Task 1 review (object literal had `path: result.path, path: parsed.pathname` — silently overwritten)
- **Issue:** JavaScript object literals with duplicate keys silently overwrite; the audit shape's `path` field would have been the screenshot filename, not the URL pathname.
- **Fix:** Renamed the screenshot filename key to `filename` (kept the URL `path` separate).
- **Files modified:** daemon/tools/browser_screenshot.cjs
- **Commit:** 960376b

**3. [Rule 2 - Critical Functionality] Extended browserAuditParams to read hostname/path from successResult**
- **Found during:** Task 1 verification (Plan 2 tools don't carry args.url because URL is page.url() at the moment of action)
- **Issue:** browserAuditParams was reading hostname/path from args.url; Plan 2 tools (click, type, screenshot, evaluate, fill_form) don't have args.url — the URL is parsed from page.url() in the tool's success result.
- **Fix:** Added fallback to successResult.hostname + successResult.path when args.url is missing.
- **Files modified:** daemon/browser/audit.cjs
- **Commit:** 960376b

**4. [Rule 2 - Critical Functionality] Added sumScreenshotBytes total disk quota check in daemon/main.cjs**
- **Found during:** Task 1 (T-8-11 calls for 500MB total cap; screenshots.cjs only exports the constant)
- **Issue:** The MAX_TOTAL_BYTES=500MB constant was exported but no consumer enforced it.
- **Fix:** Added recursive dir walker `sumScreenshotBytes` + quota check at tools/call entry BEFORE any browser.screenshot call.
- **Files modified:** daemon/main.cjs
- **Commit:** 960376b

### Pre-existing Flakiness (Out of Scope)

`bots_update_atomic.test.ts` intermittently fails when run as part of the full `npx vitest run` (3 of 6 tests fail under parallel execution). All 6 tests pass in isolation. This is a pre-existing test ordering issue not related to plan 08-02 — logged here for visibility but not fixed.

## Threat Coverage

| Threat ID | Mitigated By |
|-----------|--------------|
| T-8-01 (URL gate before action) | All 5 tools call checkBrowserUrl against page.url() BEFORE page.click/locator.fill/screenshot/evaluate; test verifies call order |
| T-8-02 (audit minimization) | browser.type returns textBytes-only; browser.fill_form returns fieldCount-only; tests assert no secret leaks |
| T-8-05 (signal propagation) | All 5 tools pass ctx.signal as Playwright `signal` option; tests verify |
| T-8-08 (typed text never logged) | browser.type result + audit carry textBytes only |
| T-8-09 (50KB result cap) | browser.evaluate throws {code:'result_too_large'} when resultBytes > 50KB |
| T-8-10 (field values never logged) | browser.fill_form result + audit carry fieldCount only |
| T-8-11 (disk quota) | 50/runId + 500MB total; tests verify per-runId cap |
| T-8-12 (path traversal in app://) | runId + n validated against /^[a-zA-Z0-9._-]{1,32}$/ at IPC handler + protocol handler + daemon |
| T-8-13 (10s evaluate timeout) | Playwright signal + setTimeout guard |
| T-8-14 (selector_not_found mapping) | browser.click maps Playwright TimeoutError to {code:'selector_not_found', selector} |
| T-8-15 (fill_form signal abort) | Maps ctx.signal.aborted to {code:'aborted'} |

## Self-Check: PASSED

- All 8 new/modified files exist
- All 24 new test cases pass
- TypeScript compiles cleanly
- All 62 pre-existing browser tests still pass (no regressions)
