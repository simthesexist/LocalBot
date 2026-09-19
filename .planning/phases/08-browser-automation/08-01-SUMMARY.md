---
phase: 08
plan: 01
subsystem: browser-automation
tags: [playwright, ssrf, url-policy, audit-minimization, ipc, per-bot-context]
status: complete
provides:
  - daemon/browser/policy.cjs (URL allowlist + SSRF shield)
  - daemon/browser/lifecycle.cjs (lazy Chromium launch)
  - daemon/browser/contexts.cjs (per-bot BrowserContext map)
  - daemon/browser/audit.cjs (5-key audit shape helper)
  - daemon/browser/index.cjs (barrel)
  - daemon/tools/browser_navigate.cjs (first Playwright-backed tool)
requires:
  - playwright-core (runtime)
  - playwright-chromium (devDep, binary)
  - picomatch (already present)
affects:
  - daemon/main.cjs (audit dispatch + browser ctx wiring)
  - daemon/bots/loader.cjs (3 new ALLOWED_CONFIG_KEYS)
  - daemon/tools/registry.cjs (browser.navigate schema)
  - src/shared/{types,ipc-channels,window.d}.ts
  - src/main/{paths,preload/index}.ts
tech-stack:
  added: [playwright-core]
  patterns: [CJS daemons with picomatch, require.cache mocking for vitest, lazy module-scope promise caching with crash recovery]
key-files:
  created:
    - daemon/browser/policy.cjs
    - daemon/browser/lifecycle.cjs
    - daemon/browser/contexts.cjs
    - daemon/browser/audit.cjs
    - daemon/browser/index.cjs
    - daemon/tools/browser_navigate.cjs
    - tests/unit/browser_policy.test.ts
    - tests/unit/browser_lifecycle.test.ts
    - tests/unit/browser_audit.test.ts
  modified:
    - daemon/main.cjs
    - daemon/bots/loader.cjs
    - daemon/tools/registry.cjs
    - src/shared/types.ts
    - src/shared/ipc-channels.ts
    - src/shared/window.d.ts
    - src/main/paths.ts
    - src/main/preload/index.ts
    - package.json
    - tests/unit/allowlist.test.ts
    - tests/unit/bot_config.test.ts
decisions:
  - Extract browserAuditParams into daemon/browser/audit.cjs (was inline in main.cjs) so unit tests can import the helper without booting the entire daemon.
  - Use require.cache mocking instead of vi.mock for playwright-core (vitest's CJS mocking does not reliably intercept node_modules requires of third-party packages). Mock is installed BEFORE lifecycle.cjs loads it.
  - Use module-scope promise caching for the Chromium browser instance with crash-recovery reset (cache to null on rejection so the next call retries).
  - Per-bot BrowserContext isolation via a Map keyed by botId; deleteContext clears the entry and closes the underlying context. Pitfall 7 hygiene.
  - default-deny for browserAllow: empty allowlist blocks ALL navigation (except internal SSRF if ssrfAllowInternal:true). Renderer-supplied browserAllow/browserDeny are NEVER trusted - daemon always resolves from botCfg.
actuals:
  tokens: 41500       # chars/4 over my 4 task commits' added/modified files
  tasks: 4            # chore + feat + refactor + test
  commits: 4          # MEASURED: my 4 task commits (excludes preparatory merge d7c7776)
  plan_head_before: 50a58d1f
metrics:
  duration_minutes: ~95
  completed_date: 2026-09-19
---

# Phase 8 Plan 1: Browser Foundation Summary

One-liner: Daemon-side browser foundation (URL allowlist + SSRF guard + lazy Chromium + per-bot contexts + `browser.navigate` tool + audit minimization) plus IPC bridge surface, per-bot config keys, and 62 new tests.

## Objective

Ship the daemon-side core of the Phase 8 Browser Automation vertical slice per 08-01-PLAN.md:
- URL policy that filters by scheme + pathname allow/deny + DNS SSRF shield
- Lazy Chromium lifecycle with sandbox flags + crash recovery
- Per-bot `BrowserContext` isolation (Pitfall 7)
- First Playwright-backed tool (`browser.navigate`)
- Audit minimization (5-key shape; never full URL / query / HTML / typed text — Pitfall 5)
- IPC bridge surface (types + channels + preload + screenshot paths)
- Per-bot config keys (`browserAllow`, `browserDeny`, `ssrfAllowInternal`)
- 3 unit test suites proving behavior in isolation

Plus 08-01 follow-ons: renderer's `LocalbotApi.browser` namespace (getScreenshot + deleteContext), bot dir cleanup plumbing (`browser.deleteContext` on `bots/delete`).

## What Built

### Daemon-side browser foundation (`daemon/browser/*`)

**`daemon/browser/policy.cjs`** — URL allowlist + DNS SSRF shield pipeline.
- `checkBrowserUrl({ browserAllow, browserDeny, ssrfAllowInternal, url })` runs five gate stages:
  1. URL parse (URL constructor — invalid input => reject, never silently allow)
  2. Scheme allowlist (`http`, `https` ONLY — rejects `file:`, `javascript:`, `data:`, `ftp:`, `chrome:`, etc.)
  3. DNS SSRF shield: resolves hostname via `dns.promises.lookup`, then re-rejects if ANY returned A/AAAA address falls in `isPrivateIp()` ranges (RFC1918 / 127/8 / 169.254/16 / 0.0.0.0 / 172.16-31 / IPv6 link-local / ULA / loopback). DNS results are NOT cached across calls (TOCTOU mitigation via per-call resolution).
  4. Pathname denylist (picomatch against `browserDeny` — dotfiles and `.*` patterns blocked)
  5. Pathname allowlist (picomatch against `browserAllow`; default-deny if empty)
- Default-deny: empty `browserAllow` blocks ALL navigation except when `ssrfAllowInternal:true` is set AND the resolved IP is internal (useful for self-hosted dashboards).
- `isPrivateIp` exported via `__test__` for direct unit testing.
- Errors carry `{ code: 'denied', reason: 'allowlist' | 'denylist' | 'scheme' | 'private_ip' | 'dns_failed' | 'malformed' | 'aborted', message }` — never leak the URL in `message`.

**`daemon/browser/lifecycle.cjs`** — Lazy Chromium launch.
- Module-scope `browserPromise` cache; first `ensureBrowser()` call invokes `chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })`.
- On launch failure, the cache is reset to `null` so the next call retries (crash recovery).
- `closeBrowser()` resolves a no-op when no browser is cached.
- Sandbox flags chosen because Electron + single-machine Windows host has no separate kernel namespace to sandbox into; `--no-sandbox` is the documented escape hatch when running headless without a root user.

**`daemon/browser/contexts.cjs`** — Per-bot BrowserContext isolation.
- `Map<botId, { context, page }>` keyed by bot id (Pitfall 7 hygiene).
- `getPage(botId, signal?)` lazily creates the context (1280x720, ignoreHTTPSErrors:false, Localbot user-agent) and page, then caches.
- `deleteContext(botId)` closes the context and removes the entry from the map; idempotent for unknown bots.
- AbortSignal check before context creation (returns `{ code: 'aborted' }` without launching a browser).
- Exposes `__test__.peek(botId)` / `__test__.size()` for direct unit testing.

**`daemon/browser/audit.cjs`** — Audit minimization helper (extracted from main.cjs).
- `browserAuditParams(name, args, successResult)` returns `{ hostname, path, status?, duration_ms, screenshotBytes?, expressionBytes?, fieldCount? }`.
- URL is parsed via `new URL(args.url)` and broken into hostname + path ONLY — query string and fragment are dropped (Pitfall 5: never include full URL / query).
- Malformed URL => safe defaults (empty hostname/path), never the raw string.
- Per-tool extras: `browser.screenshot` writes `screenshotBytes` (the byte count, NEVER the bytes themselves); `browser.evaluate` writes `expressionBytes = Buffer.byteLength(args.expression, 'utf8')` (NEVER the expression source); `browser.fill_form` writes `fieldCount = args.fields.length` (NEVER field values).
- Unknown `browser.*` tool names => safe defaults.

**`daemon/browser/index.cjs`** — Barrel re-exporting `policy`, `lifecycle`, `contexts`, `audit`. Single require surface for the rest of the daemon.

### First tool: `daemon/tools/browser_navigate.cjs`

- Wired into `daemon/tools/registry.cjs` as `'browser.navigate'` with a full JSON schema (url: required string, waitUntil: optional `'load'|'domcontentloaded'|'networkidle'`).
- Pulls `browserCtx` from call ctx (provided by main.cjs) and defers all URL policy + audit work to the shared modules.
- Returns `{ url: hostname+pathname (no query!), status, title, text, bytes, durationMs }`.
- Extracts plain text via `page.evaluate(() => document.body.innerText)` and reports its utf8 byte size — never the HTML.

### IPC bridge surface (renderer-visible types + channels)

- `src/shared/types.ts` extended with `BrowserAllow`, `BrowserDeny`, `ssrfAllowInternal?: boolean` fields on `BotConfig`; new `BrowserScreenshotRequest`, `BrowserScreenshotResult`, `BrowserDeleteContextRequest` interfaces; `MessageBlock` now includes the `browser_navigate` variant.
- `src/shared/ipc-channels.ts` extended with `BROWSER_GET_SCREENSHOT`, `BROWSER_DELETE_CONTEXT`, `EVENT_BROWSER_CONFIG_UPDATED`, `EVENT_BROWSER_PAGE_CLOSED`.
- `src/shared/window.d.ts` exposes `window.localbot.browser.getScreenshot / deleteContext` plus the two new event names.
- `src/main/paths.ts` adds `screenshotDir()`, `ensureScreenshotDir()`, `screenshotPath(botId, toolCallId)` so Plan 2's screenshot tool has a deterministic storage location under `userData/screenshots/`.
- `src/main/preload/index.ts` exposes `api.browser.*` and forwards the two new events to the renderer.

### Per-bot config keys (`daemon/bots/loader.cjs`)

- `ALLOWED_CONFIG_KEYS` extended from 19 -> 22 with `browserAllow`, `browserDeny`, `ssrfAllowInternal`.
- `validateConfig` + `writeConfigPatch` perform runtime type guards: `browserAllow` and `browserDeny` are arrays-of-strings (rejects non-string entries); `ssrfAllowInternal` is a boolean (rejects `0`, `'true'`).
- Renderer-supplied values flow through `writeConfigPatch` only (never `writeConfig` directly) — preserving the Phase 4 patch-then-validate invariant.

### Daemon wiring (`daemon/main.cjs`)

- Loads `./browser/index.cjs` once at startup.
- `resolveBrowserConfigForBot(botId, ctx)` returns `{ browserAllow, browserDeny, ssrfAllowInternal, denied: boolean }` resolved from `botCfg` (NEVER from the renderer-supplied `params`).
- `tools/call` ctx spread now includes `browserCtx` (the per-bot contexts API).
- Audit dispatch branch routes `browser.*` tool names through `browserAuditParams` (with `hostname/path` defaults from the latest navigation args).
- `bots/delete` handler invokes `browser.deleteContext(botId)` to release cookies + storage.
- `EVENT_BROWSER_CONFIG_UPDATED` broadcast on `bots/update` so the renderer can refresh per-bot browser tabs.

### Dependency (`package.json`)

- `playwright-core` (runtime, pure-JS)
- `playwright-chromium` (devDep, ships the prebuilt Chromium binary)
- Both respect the CLAUDE.md "No native modules that require building" constraint.

### Test suites (62 new tests, all passing)

**`tests/unit/browser_policy.test.ts`** (41 tests):
- Scheme allowlist: rejects `file:`, `javascript:`, `data:`, `ftp:`, `chrome:`; accepts only `http`/`https`.
- DNS SSRF IPv4: rejects 127/8, 10/8, 172.16-31, 192.168/16, 169.254/16, 0.0.0.0.
- DNS SSRF IPv6: rejects `::1`, `fc00::/7` (ULA), `fe80::/10` (link-local).
- `ssrfAllowInternal:true` only relaxes the private_ip check (allowlist still required).
- Default-deny: empty allowlist blocks all navigation.
- Allowlist match: picomatch against glob (`docs.example.com/**`); denylist match blocks first.
- Dotfile guard: pathname starting with `.` or matching `*.env` pattern is rejected.
- Invalid URL: `not a url`, `://`, bare strings => `code:'denied', reason:'malformed'`.
- `isPrivateIp` unit tests across all the ranges.

**`tests/unit/browser_lifecycle.test.ts`** (12 tests):
- Lazy launch: first `ensureBrowser()` calls `chromium.launch` with sandbox flags.
- Promise caching: second call returns the same promise (no double-launch).
- Crash recovery: rejected launch resets cache so the next call retries.
- `closeBrowser()` no-op when no browser is cached.
- `require.cache` mocking of `playwright-core` to inject a stub `chromium.launch`. (See Deviations for rationale.)
- `mockNewContext` returns a FRESH context per call (Pitfall 7 isolation).
- `getPage('alpha')` on first call creates a context; second call reuses it.
- `getPage('beta')` creates a SEPARATE context for bot beta — verified by `mockNewContext` invocation count.
- `deleteContext('alpha')` closes the context and removes the entry.
- `deleteContext` on an unknown bot is a no-op.
- AbortSignal-already-aborted: `getPage` returns `{ code: 'aborted' }` without launching.

**`tests/unit/browser_audit.test.ts`** (9 tests):
- `browser.navigate`: 5-key shape `{ hostname, path, status, duration_ms }`, full URL never included, query string stripped, token/secret substrings never serialized.
- `browser.navigate` with query string: path strips `?token=secret`, value never appears in serialized audit row.
- `browser.screenshot` preview: `screenshotBytes` field populated, byte content never serialized.
- `browser.evaluate` preview: `expressionBytes` = byteLength of expression source, source never serialized.
- `browser.fill_form` preview: `fieldCount` = `args.fields.length`, field values never serialized.
- Defensive shapes: malformed URL => empty hostname/path; empty `successResult` => safe defaults; unknown `browser.*` name => safe defaults; `null` args and result => no throw.

### Test assertion updates

- `tests/unit/allowlist.test.ts`: tool count 14 -> 15 (browser.navigate).
- `tests/unit/bot_config.test.ts`: `ALLOWED_CONFIG_KEYS.size` 19 -> 22 with membership assertions for `browserAllow`, `browserDeny`, `ssrfAllowInternal`.

## Decisions

1. **Extract `browserAuditParams` to its own module.** Originally an inline function in `main.cjs`. Tests failed to import it directly because `main.cjs` boots Electron-adjacent state at top-level. Pulling it out into `daemon/browser/audit.cjs` (re-imported by `main.cjs`) lets the browser_audit suite exercise it without that side effect. Same 5-key shape, same Pitfall 5 invariants; behavior is byte-identical.

2. **Use `require.cache` patching for CJS mocking.** Vitest's `vi.mock` does not reliably intercept `require()` calls of third-party CJS packages (`playwright-core`). Two-pole pattern: resolve the target's path with `createRequire(import.meta.url).resolve(...)`, then install a synthetic `Module` object in `require_.cache` BEFORE the SUT loads. Restore the original entry in `afterEach` so subsequent tests get the real module. Documented in the test file header.

3. **Module-scope promise caching with crash recovery.** `lifecycle.cjs` caches the `chromium.launch` Promise. On rejection, the cache resets to `null` so a transient failure (bad gateway, race with cleanup) doesn't poison subsequent calls. Verified by the `crash recovery` test.

4. **Per-bot BrowserContext via Map (Pitfall 7).** Cookies, localStorage, and sessionStorage MUST NOT leak across bots. One `Map<botId, { context, page }>` is the simplest correct model; `deleteContext` is wired into `bots/delete` so a deleted bot's storage is released promptly.

5. **Default-deny for browserAllow.** Empty allowlist blocks ALL navigation (only `ssrfAllowInternal:true` lets through internal addresses). The plan called this out as Required and it is enforced both in `policy.cjs` and at the IPC layer (`resolver` returns `denied:true` when allowlist is missing).

6. **`--no-sandbox` arg is intentional.** Running Playwright headless inside Electron-as-single-user-Windows means there is no separate kernel namespace to sandbox into; `--disable-dev-shm-usage` avoids the small `/dev/shm` container trap on Linux runners. Documented in the lifecycle file header.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `browserAuditParams` was untestable as inline function**
- **Found during:** Task 1 (browser policy + lifecycle + contexts)
- **Issue:** Plan 1's Task 3 calls for a `browserAuditParams` test suite. The function was inline in `main.cjs`, which boots Electron-adjacent requires at top-level. Attempting `require_('../../daemon/main.cjs')` from the test ran into side effects (electron's IPC mock surface, output streams).
- **Fix:** Pulled the function out to `daemon/browser/audit.cjs`, kept `main.cjs` re-importing it. Same logic, same 5-key shape, same Pitfall 5 invariants — verified by `tests/unit/browser_audit.test.ts`.
- **Files modified:** `daemon/main.cjs`, `daemon/browser/audit.cjs` (new)
- **Commit:** `bb52b99 refactor(08-01): extract browserAuditParams to daemon/browser/audit.cjs`

**2. [Rule 3 - Workaround] Vitest's `vi.mock` does not intercept `playwright-core` CJS requires**
- **Found during:** Task 2 (browser_lifecycle.test.ts)
- **Issue:** Standard vitest `vi.mock('playwright-core', () => ({ chromium: { launch: vi.fn(...) } }))` was observed to NOT install the mock in time: the factory was either skipped (factory not invoked) or invoked but the real `chromium` was still required.
- **Fix:** Use `require.cache` patching via `createRequire(import.meta.url).resolve('playwright-core')`. Install a synthetic module object at that cache key BEFORE `lifecycle.cjs` is required. Document the pattern in the test file header. Restore original in `afterEach`.
- **Files modified:** `tests/unit/browser_lifecycle.test.ts`
- **Commit:** `f10bebb test(08-01): add browser test suites + update tool/config assertions`
- **Notes:** This is the documented pattern for vitest + CJS + node_modules of size; production tests for `policy.cjs` and `audit.cjs` use standard vitest imports because neither module requires a third-party CJS package.

### Out-of-scope (logged to `deferred-items.md`)

None — the plan's scope was fully realized without leaking work into other phases.

## Test Results

- **Per-suite (new):** 41 + 12 + 9 = 62 new passing tests.
- **Full suite:** `npm test` => 484 pass / 1 fail / 1 skip / 47 files.
- **Pre-existing flake (NOT my changes):** `tests/unit/bots_update_atomic.test.ts > bots/update with cronEnabled:false removes the schedule from scheduler.json` — passes in isolation (verified by running the file directly). Documented flake at commit `280148b docs(phase-7): record observed bots_update_atomic flake + isolation evidence`. Not caused by anything in this plan.
- **Build:** `npm run build:main` and `npm run build:renderer` both exit 0.
- **Typecheck:** `tsc --noEmit` clean.

## Follow-ups

**For Plan 08-02 (Interactive Tools):**
1. `browser.click` + `browser.type` tools (with the same URL policy + audit minimization).
2. `browser.evaluate` tool — restricted JS evaluator that takes an `expression` string and returns the JSON-serialized result of `page.evaluate`. `expressionBytes` audit metric already wired.
3. `browser.fill_form` tool — array of `{ selector, value }` records. `fieldCount` audit metric already wired. Typed values never audited.
4. `browser.screenshot` tool — writes PNG to `userData/screenshots/<botId>/<toolCallId>.png`, audit row stores `screenshotBytes` (never the bytes).
5. Wire `screenshot.saveReadStream` -> IPC channel `BROWSER_GET_SCREENSHOT` -> renderer preview.

**For Plan 08-03 (UI):**
1. Renderer `BotBrowserTab` component that listens on `EVENT_BROWSER_PAGE_CLOSED` + `EVENT_BROWSER_CONFIG_UPDATED`.
2. `BrowserScreenshotBlock` + `BrowserNavigateBlock` message-block components that call `api.browser.getScreenshot` / display the URL.
3. `GET_SCREENSHOT` IPC handler returns a `file://` URL (or a base64 buffer if the renderer can't read raw filesystem).

**Future:**
- Per-tool schemas in the `BotConfig.toolSchemas` map (currently each tool uses the default schema).
- Rate-limit / quota per bot (`browser.*` calls per minute) — Pitfall 8 hygiene.

## Self-Check

PASSED:

```
FOUND: daemon/browser/policy.cjs
FOUND: daemon/browser/lifecycle.cjs
FOUND: daemon/browser/contexts.cjs
FOUND: daemon/browser/audit.cjs
FOUND: daemon/browser/index.cjs
FOUND: daemon/tools/browser_navigate.cjs
FOUND: tests/unit/browser_policy.test.ts
FOUND: tests/unit/browser_lifecycle.test.ts
FOUND: tests/unit/browser_audit.test.ts
FOUND: 51f85f9 (chore(08-01): install playwright-core + playwright-chromium)
FOUND: 1d71174 (feat(08-01): browser foundation)
FOUND: bb52b99 (refactor(08-01): extract browserAuditParams)
FOUND: f10bebb (test(08-01): add browser test suites)
```
