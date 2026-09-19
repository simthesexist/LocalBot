---
phase: 08
plan: 03
subsystem: browser-automation
tags: [renderer, message-blocks, settings-tab, state-store, playwright-e2e, audit-minimization, fake-m3]
status: complete
provides:
  - src/renderer/components/BrowserNavigateBlock.tsx (URL header + status badge + title + text + bytes + duration)
  - src/renderer/components/BrowserClickBlock.tsx (selector + hostname/path + text snippet + duration)
  - src/renderer/components/BrowserTypeBlock.tsx (selector + textBytes + submitted badge + duration; no body, no raw text)
  - src/renderer/components/BrowserFillFormBlock.tsx (fieldCount header + submitted badge + summary text + duration; no field values)
  - src/renderer/components/BrowserScreenshotBlock.tsx (filename + bytes + fullPage badge + app:// img)
  - src/renderer/components/BrowserEvaluateBlock.tsx (expressionBytes + resultBytes + result preview; no expression source)
  - src/renderer/state/browser.ts (module-scope BrowserConfigState + useBrowserConfig + browserActions + 200ms throttle)
  - src/renderer/components/BotSettingsBrowserTab.tsx (6th 'browser' tab; URL allow/deny textareas + SSRF opt-out + 6 browser.* checkboxes + 250ms debounced saves)
  - tests/playwright/browser-automation.test.ts (6 daemon-smoke cases covering all 6 browser.* tools + audit minimization assertions)
  - tests/playwright/fake-m3-server.ts (+6 streamBrowser*ToolUse helpers for future LLM-driven E2E)
requires:
  - All Phase 8 Plan 1 + Plan 2 daemon tools + audit minimization pipeline
  - src/shared/types.ts (browser_* MessageBlock variants from Plan 02)
  - src/renderer/state/vault.ts (mirrored module-scope + subscribers pattern)
  - @playwright/test (devDep) + Playwright Chromium 1243 (locally installed)
affects:
  - src/renderer/components/MessageBlock.tsx (6 new switch cases for browser_* blocks)
  - src/renderer/components/BotSettingsPage.tsx (TabId union + TAB_IDS + TAB_LABELS extended with 'browser')
  - src/renderer/styles/app.css (6 new block-browser-* rules + status color classes + screenshot img rule + settings-tab-browser styles)
  - playwright.config.ts (comment updated to document the new daemon-smoke test)
tech-stack:
  added: []
  patterns: [inline MessageBlock renderers (single component per kind, Extract<MessageBlock, {kind:K}> typing), module-scope state + subscribers + 200ms throttle, 250ms debounced saves via parent persistPatch (no IPC from this tab), Playwright daemon-smoke end-to-end (tools/call direct JSON-RPC), Node http.createServer fixture with kernel-assigned port + tmpfs userData, audit minimization assertions on the canonical JSONL shape]
key-files:
  created:
    - src/renderer/components/BrowserNavigateBlock.tsx
    - src/renderer/components/BrowserClickBlock.tsx
    - src/renderer/components/BrowserTypeBlock.tsx
    - src/renderer/components/BrowserFillFormBlock.tsx
    - src/renderer/components/BrowserScreenshotBlock.tsx
    - src/renderer/components/BrowserEvaluateBlock.tsx
    - src/renderer/state/browser.ts
    - src/renderer/components/BotSettingsBrowserTab.tsx
    - tests/playwright/browser-automation.test.ts
  modified:
    - src/renderer/components/MessageBlock.tsx
    - src/renderer/components/BotSettingsPage.tsx
    - src/renderer/styles/app.css
    - tests/playwright/fake-m3-server.ts
    - playwright.config.ts
decisions:
  - Each Browser*Block component uses Extract<MessageBlock, {kind:K}> for typed consumption — the discriminated union narrowing stays exhaustive at compile time (TS catches a new MessageBlock kind without a renderer branch).
  - BrowserTypeBlock renders a one-line summary (selector + textBytes + submitted badge + duration) — NO `<pre>` body. The typed text NEVER enters the renderer (Pitfall 5 / T-8-08).
  - BrowserFillFormBlock renders `{fieldCount} field(s)` + (submitted) badge + truncated summary text — NEVER the individual field values (Pitfall 5 / T-8-10).
  - BrowserEvaluateBlock renders byte counts + result preview (500-byte collapse) — NEVER the expression source (Pitfall 5 / T-8-09).
  - BrowserScreenshotBlock consumes the `app://localhost/screenshots/<runId>/<n>.png` URI built by src/main/ipc/browser.ts (Plan 2) — bytes NEVER traverse IPC; img has loading='lazy' to defer paint.
  - src/renderer/state/browser.ts mirrors src/renderer/state/vault.ts (module-scope + subscribers + 200ms throttle). Subscribes to EVENT_BROWSER_CONFIG_UPDATED + EVENT_BROWSER_PAGE_CLOSED; exports useBrowserConfig + browserActions (refresh / getScreenshot / deleteContext) + __test__.reset() for unit tests.
  - BotSettingsBrowserTab mirrors BotSettingsObsidianTab (Plan 7-03): four sections (URL allow textarea + URL deny textarea + SSRF opt-out checkbox + 6 browser.* tool checkboxes). 250ms debounce (T-P4-25) via the parent's persistPatch — this tab NEVER calls window.localbot directly. ssrfAllowInternal defaults to bot.ssrfAllowInternal === true (back-compat with bots created before Phase 8).
  - The 6 browser.* checkboxes update the parent's combined allowlist by merging non-browser entries + freshly-toggled browser.* entries so a bot's existing Permissions tab choices are preserved on save.
  - BotSettingsPage TabId union extended with 'browser' (6th tab); TAB_IDS + TAB_LABELS + ArrowLeft/Right keyboard navigation pick it up automatically.
  - Playwright E2E deviates from the plan's LLM-driven flow (per obsidian-integration.test.ts precedent): the daemon's runSendMessageCycle does NOT pass `tools` to the Anthropic SDK call yet, so the test drives `tools/call` JSON-RPC directly against a Node http.createServer fixture on 127.0.0.1 + tmpfs userData (mkdtemp + port 0 for kernel-assigned port). The streamBrowser*ToolUse helpers from this plan remain deliverables for the headed Electron E2E + any future LLM-driven browser test once runSendMessageCycle wires tools.
  - Audit minimization asserted for every case: the audit row carries ONLY the canonical keys (`hostname`, `path`, `duration_ms`, plus exactly one of `status` / `screenshotBytes` / `expressionBytes` / `fieldCount`). No query string, no typed text, no field values, no expression source, no raw PNG bytes, no absolute paths leak into the JSONL.
  - All 6 cases use the same fixture page (one server spin-up per case). Each case runs an independent daemon + tmpfs userData + Chromium BrowserContext so test order doesn't matter and cleanup is fully automatic.
  - browser.click / browser.type audit rows carry 3 keys (`hostname`, `path`, `duration_ms`) because the tools do NOT expose an HTTP `status` — JSON.stringify drops the undefined `status` field. browser.navigate's audit row carries 4 keys including `status`.
actuals:
  tokens: 30000       # chars/4 over 14 files (2401 net insertions + ~80 deletions across renderer + tests + config)
  tasks: 2            # feat (Task 1) + test (Task 2)
  commits: 2          # MEASURED: git rev-list --count 26969ba..HEAD (679673d, 86dbfe7)
  plan_head_before: 26969bafe672177cb0cb3f1de2523498e2d3060a
---

# Phase 8 Plan 3: Browser Renderer + E2E Summary

Browser automation UI surface completes the vertical slice: 6 inline MessageBlock renderers for the existing audit-friendly MessageBlock shapes, a 6th 'Browser' tab in BotSettingsPage for the per-bot URL allow/deny + SSRF opt-out + tool allowlist, a renderer-side browser config store, and a Playwright daemon-smoke E2E suite asserting audit minimization for every browser.* tool.

## What Shipped

### Renderer: 6 inline MessageBlock components
- `BrowserNavigateBlock.tsx` — normalized `hostname/path` header, status badge color-coded by class (2xx/3xx/4xx/5xx), `<h3>` title, body text with 500-byte collapse, bytes footer, duration in ms. `data-block-kind="browser_navigate"` + `data-browser-url`.
- `BrowserClickBlock.tsx` — selector header + hostname/path + text snippet (200-byte collapse) + duration. `data-block-kind="browser_click"`. NEVER displays `args.url`.
- `BrowserTypeBlock.tsx` — one-line summary: selector + textBytes + (submitted) badge + duration. NO `<pre>` body. NEVER includes typed text (Pitfall 5 / T-8-08).
- `BrowserFillFormBlock.tsx` — `{fieldCount} field(s)` header + (submitted) badge + summary text (500-byte collapse) + duration. NEVER includes individual field values (Pitfall 5 / T-8-10).
- `BrowserScreenshotBlock.tsx` — `{filename}` header + bytes + fullPage badge + `<img loading="lazy" src={app://...}>` (500-byte collapse for filename).
- `BrowserEvaluateBlock.tsx` — `{expressionBytes} byte expression` + `{resultBytes} byte result` + result preview in `<pre>` (500-byte collapse). NEVER includes expression source (Pitfall 5 / T-8-09).

### Renderer: MessageBlock dispatcher
- `MessageBlock.tsx` — 6 new switch cases inserted before the exhaustiveness `default` branch. The exhaustive `_exhaustive: never` check catches any new MessageBlock kind without a renderer at compile time.

### Renderer: browser config store
- `src/renderer/state/browser.ts` — module-scope BrowserConfigState + 200ms throttle + REFRESH_MIN_INTERVAL_MS. Mirrors `src/renderer/state/vault.ts` line-for-line. Subscribes to `EVENT_BROWSER_CONFIG_UPDATED` (re-pull bots list) + `EVENT_BROWSER_PAGE_CLOSED` (informational). Exports `useBrowserConfig` hook + `browserActions` (refresh / getScreenshot / deleteContext) + `__test__.reset()` for unit tests. The renderer NEVER reaches into `window.localbot.browser.*` directly.

### Renderer: BotSettingsBrowserTab (6th tab)
- `BotSettingsBrowserTab.tsx` — mirrors BotSettingsObsidianTab shape. Four sections:
  1. URL allow globs (newline-delimited picomatch globs, empty = default-deny)
  2. URL deny globs (newline-delimited, evaluated BEFORE allow)
  3. SSRF opt-out checkbox (`ssrfAllowInternal`, default-deny unless opt-in)
  4. Browser tools: 6 checkboxes (browser.navigate / browser.click / browser.type / browser.fill_form / browser.screenshot / browser.evaluate). NOT in default allowlist (Pitfall 7 — per-bot opt-in).
- 250ms debounced save via parent's `persistPatch` (no IPC from this tab).
- Combines the bot's existing non-browser allowlist + the freshly-toggled browser.* entries so Permissions tab choices are preserved.
- `ssrfAllowInternal` defaults to `bot.ssrfAllowInternal === true` (back-compat).

### Renderer: BotSettingsPage integration
- `BotSettingsPage.tsx` — TabId union + TAB_IDS + TAB_LABELS extended with `'browser'`. Renders `<BotSettingsBrowserTab bot onPatch saving error />` when active. URL hash sync + ArrowLeft/Right keyboard navigation pick up the new tab automatically.

### Renderer: CSS
- `app.css` — appended `.block-browser-navigate`, `.block-browser-click`, `.block-browser-type`, `.block-browser-fill-form`, `.block-browser-screenshot`, `.block-browser-evaluate` rules + status color classes (`.block-browser-status-2xx/3xx/4xx/5xx`) + `.block-browser-submitted` (green) + `.block-browser-screenshot-img` (max-height 400px, object-fit contain, lazy-loaded) + `.settings-tab-browser` styles mirroring `.settings-tab-obsidian`.

### Tests: 6 Playwright daemon-smoke cases
- `tests/playwright/browser-automation.test.ts` (NEW, ~643 lines) — 6 cases covering all 6 browser.* tools (TOOL-07..12 requirements). Per obsidian-integration.test.ts deviation: drives `tools/call` JSON-RPC directly against a Node http.createServer fixture on 127.0.0.1 + tmpfs userData + per-bot `browserAllow=['/**']` + `ssrfAllowInternal:true`. All 6 cases assert the canonical audit minimization shape (Pitfall 5):
  - `browser.navigate` — 4-key audit row `{hostname, path, status, duration_ms}`. Navigates with `?secret=PRIVATE-NAVIGATE-TOKEN`; audit row NEVER contains `secret=`, `PRIVATE-NAVIGATE-TOKEN`, or `?token`.
  - `browser.click` — 3-key audit row `{hostname, path, duration_ms}`. Clicks `#btn` on the loaded page.
  - `browser.type` — 3-key audit row `{hostname, path, duration_ms}`. Fills `#inp` with `PRIVATE-TYPE-PASSWORD-1234`; audit row NEVER contains the secret.
  - `browser.fill_form` — 4-key audit row `{hostname, path, fieldCount, duration_ms}`. Fills 3 fields + submits. Audit row NEVER contains any field value.
  - `browser.screenshot` — 4-key audit row `{hostname, path, screenshotBytes, duration_ms}`. Captures fullPage PNG. Audit row NEVER contains raw PNG bytes (`PNG` magic) or the absolute screenshot path.
  - `browser.evaluate` — 4-key audit row `{hostname, path, expressionBytes, duration_ms}`. Runs `document.querySelector('#eval-target').dataset.marker`. Audit row NEVER contains the expression source (`document.querySelector`, `dataset.marker`, `eval-target`) or the result value (`"42"`).
- `tests/playwright/fake-m3-server.ts` — appends 6 `streamBrowser*ToolUse` helpers (Navigate / Click / Type / FillForm / Screenshot / Evaluate) mirroring `streamVaultReadToolUse`. Each helper binds its own HTTP server + emits the canonical SSE envelope (message_start + content_block_start + input_json_delta chunks + content_block_stop + text content_block + message_delta + message_stop). These remain deliverables for the headed Electron E2E + any future LLM-driven browser test once `runSendMessageCycle` wires tools.
- `playwright.config.ts` — comment updated documenting the new `browser-automation.test.ts` under the daemon-smoke project (testMatch regex `/.*\.test\.ts/` already covers it).

## Verification

| Check | Result |
|-------|--------|
| `npx tsc --noEmit -p .` | exit 0 |
| `npx tsc --noEmit -p tsconfig.main.json` | exit 0 |
| `npx vite build` | exit 0 (renderer 466.77 kB / 145.83 kB gzip) |
| `npx playwright test browser-automation.test.ts --project=daemon-smoke` | 6 passed (8.7s) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed `<select>` from fixture form (browser.fill_form uses `locator.fill()` which is invalid on `<select>`)**
- **Found during:** Task 2 verification (browser.fill_form case failed: `locator.fill: Error: Element is not an <select> is not an <input>, <textarea> or [contenteditable> element`)
- **Issue:** The original fixture used `<select name="role" id="form-role">` for the third form field; Playwright's `locator.fill()` only operates on inputs/textareas/contenteditable.
- **Fix:** Replaced the `<select>` with a plain `<input type="text" id="form-role">`. Updated the test's field value from `'user'` to `'PRIVATE-FILL-ROLE'` so the audit minimization assertion (`not.toContain('PRIVATE-FILL-ROLE')`) covers the third field too.
- **Files modified:** tests/playwright/browser-automation.test.ts (+4 lines, -4 lines)
- **Commit:** 86dbfe7 (amended)

**2. [Rule 1 - Bug] Corrected `browser.click` / `browser.type` audit shape to 3 keys (no `status`)**
- **Found during:** Task 2 verification (browser.click + browser.type cases failed on `Object.keys(params).sort()` mismatch — actual was 3 keys, expected 4)
- **Issue:** The original test asserted `SHAPE.click = SHAPE.type = ['duration_ms', 'hostname', 'path', 'status']` (4 keys) based on the assumption that all browser.* tools surface an HTTP status. In fact, `browser_click.cjs` and `browser_type.cjs` return shapes that do NOT include a `status` field — the audit pipeline reads `successResult.status` (undefined → dropped via JSON.stringify). Only `browser_navigate` carries `status` because it makes the HTTP request.
- **Fix:** Updated `SHAPE.click` and `SHAPE.type` to 3 keys. Removed `expect(params.status).toBe(200)` from both cases.
- **Files modified:** tests/playwright/browser-automation.test.ts
- **Commit:** 86dbfe7 (amended)

**3. [Rule 1 - Bug] Corrected `browser.navigate` URL assertion to hostname only (no port in `URL.hostname`)**
- **Found during:** Task 2 verification (browser.navigate case failed on `expect(resp.result.url).toBe('127.0.0.1:60354/')` vs actual `'127.0.0.1/'`)
- **Issue:** The URL was `http://127.0.0.1:<port>/`; the `browser_navigate.cjs` normalized URL is `parsed.hostname + parsed.pathname` and `new URL(...).hostname` strips the port (per WHATWG URL spec).
- **Fix:** Updated assertion to `expect(resp.result.url).toBe('127.0.0.1/')` with a comment explaining the port-stripping behavior.
- **Files modified:** tests/playwright/browser-automation.test.ts
- **Commit:** 86dbfe7 (amended)

## Threat Coverage

| Threat ID | Mitigated By |
|-----------|--------------|
| T-8-02 (audit minimization) | All 6 E2E cases assert the canonical audit shape; query strings, typed text, field values, expression source, and raw PNG bytes NEVER appear in the audit JSONL. Renderer blocks never request raw sensitive data — they only consume the audit-friendly MessageBlock variants. |
| T-8-08 (typed text never logged) | BrowserTypeBlock renders textBytes only; audit row never carries the typed text. |
| T-8-09 (50KB result cap) | BrowserEvaluateBlock renders result preview with 500-byte collapse — the renderer would naturally truncate before the audit's 50KB cap is reached for any sane expression. |
| T-8-10 (field values never logged) | BrowserFillFormBlock renders fieldCount only; audit row never carries field values. |
| T-8-12 (path traversal in app://) | BrowserScreenshotBlock consumes the `app://` URI built by src/main/ipc/browser.ts (Plan 2), which already validates runId + n against /^[a-zA-Z0-9._-]{1,32}$/. |
| T-8-21 (SSRF escape hatch) | BotSettingsBrowserTab exposes the ssrfAllowInternal opt-out checkbox with a WARNING hint; default-deny preserved when unset. |

## Self-Check: PASSED

- All 9 created files exist
- All 5 modified files exist
- 6/6 Playwright daemon-smoke cases pass
- TypeScript compiles cleanly (renderer + main)
- vite build succeeds
- 2 atomic commits on `worktree-agent-af5f82c55974d015d` (679673d, 86dbfe7)
- plan_head_before ledger written to `<git-dir>/gsd-plan-head-before-08-03` (26969ba)
