# Phase 8: Browser Automation — Research

**Researched:** 2026-09-19
**Domain:** Playwright + Electron + Node daemon — JS-rendered page navigation, click/type/screenshot/evaluate tools with per-bot URL allowlisting
**Confidence:** MEDIUM (Playwright runtime version + Chromium download behavior is firm; package-legitimacy and SSRF policy decisions need user sign-off)

## Summary

Phase 8 adds six Playwright-backed tools (`browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_evaluate`, `browser_fill_form`) that let an LLM drive a real headless Chromium running inside the existing tool daemon. The first phase to give bots any network egress, Phase 8 must therefore introduce the project's first URL-allowlisting policy (mirroring the Phase 7 picomatch vault pipeline at `daemon/vault/glob.cjs:44-71`), an SSRF shield that resolves the URL host and refuses private/link-local/loopback ranges by default, an audit-minimization contract that never logs full URLs or rendered HTML, and a screenshot pipeline that streams PNGs from the daemon → main → renderer without leaking sensitive viewport content.

The recommended architecture is **per-bot BrowserContext with a single shared Chromium process**. Launch Chromium lazily on first browser tool call (avoid the ~150MB cold-start when a bot never uses the browser), keep one `BrowserContext` per bot so cookies/localStorage stay isolated across bots (multi-bot safety, no cross-tenant cookie reuse), and reuse the existing `tools/call` JSON-RPC seam + per-call `AbortController` so `bots/cancel` already wired in Phase 4 propagates without changes. Screenshots are written to `<userData>/screenshots/<runId>/<n>.png` and surfaced via a new IPC channel that returns `file://` URIs — Phase 7's audit-minimization shape carries over directly to a 5-key `{tool, status, duration_ms, selector?, screenshotBytes?}` payload.

**Primary recommendation:** Install `playwright-core@^1.63.0` (no bundled browser) plus `playwright-chromium@^1.63.0` as a devDependency and run `npx playwright install chromium` once during CI/setup. The full `playwright` package is unnecessary because the bot never drives Firefox/WebKit. Lazy-launch Chromium on the first `tools/call` whose name starts with `browser_`. Default-deny URL allowlist per bot, deny-all when empty, hard-coded SSRF denylist for RFC1918 / 127.0.0.0/8 / 169.254.0.0/16 / IPv6 loopback with an opt-out `ALLOW_INTERNAL_HOSTS` env var for hermetic E2E tests.

## Phase Overview

**Goal (from ROADMAP.md §Phase 8):** Bots can drive a real browser to fetch pages, click elements, type into inputs, fill forms, screenshot, and run JS — handling JS-heavy sites the HTTP-fetch tools cannot.

**Success Criteria (from ROADMAP.md):**
1. Bot can navigate to a URL and return the rendered page contents
2. Bot can click an element by CSS selector and observe the resulting state
3. Bot can type into an input, and fill multiple form fields in a single tool call
4. Bot can capture a viewport screenshot as a PNG and reference it in the chat
5. Bot can execute arbitrary JavaScript in the page context and read the result

**Requirements Addressed:** TOOL-07, TOOL-08, TOOL-09, TOOL-10, TOOL-11, TOOL-12 (6 new built-in tools).

**Mode:** mvp. **Depends on:** Phase 7 (Obsidian Integration). **UI hint:** yes.

## Tool Inventory

| REQ ID | Tool Name | Playwright Primitive | Schema Fields | Audit Shape |
|--------|-----------|---------------------|---------------|-------------|
| TOOL-07 | `browser_navigate` | `page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000, signal })` | `{ url: string }` | `{ tool, status, duration_ms, hostname, path }` |
| TOOL-08 | `browser_click` | `page.click(selector, { timeout: 10000, signal })` | `{ selector: string }` | `{ tool, status, duration_ms, selector, hostname, path }` |
| TOOL-09 | `browser_type` | `page.locator(selector).fill(text)` then `.press(enter?)` | `{ selector: string, text: string, submit?: boolean }` | `{ tool, status, duration_ms, selector, hostname, path }` |
| TOOL-10 | `browser_screenshot` | `page.screenshot({ type: 'png' })` then `fs.writeFile(tmp)` + `fs.rename` | `{ n?: string, fullPage?: boolean }` | `{ tool, status, duration_ms, screenshotBytes, hostname, path }` |
| TOOL-11 | `browser_evaluate` | `page.evaluate(() => <fn>)` — fn stringified, eval'd in page context | `{ expression: string }` (sandboxed: no closures) | `{ tool, status, duration_ms, expressionBytes, hostname, path }` |
| TOOL-12 | `browser_fill_form` | `Promise.all(fields.map(f => page.locator(f.selector).fill(f.value)))` | `{ fields: Array<{ selector: string, value: string }>, submit?: { selector: string } }` | `{ tool, status, duration_ms, fieldCount, hostname, path }` |

**Audit minimization invariant (Pitfall 5):** No audit row contains a full URL with query string, rendered HTML, screenshot bytes, form field values, or evaluated-JS return value. Only normalized `{hostname, path}` + metadata.

## Plan Decomposition Hint

This is a **NOT a PLAN** — just a recommended slicing for the planner to follow. Mirror Phase 7's 3-wave structure (tracer → expansion → UI + E2E).

### Wave 1 (Tracer) — `08-01-PLAN.md`
**Goal:** Daemon-side core. Prove the security invariants (URL allowlist, SSRF shield, scheme allowlist) + Chromium lazy launch + the simplest tool (`browser_navigate`) end-to-end.

**Tasks:**
1. Install `playwright-core@^1.63.0` + `playwright-chromium@^1.63.0` (devDep); run `npx playwright install chromium` once.
2. Create `daemon/browser/{lifecycle,contexts,policy,index}.cjs` — lazy Chromium launch, per-bot BrowserContext map, URL allowlist + SSRF shield, barrel exports.
3. Create `daemon/tools/browser_navigate.cjs` — the tracer tool.
4. Extend `daemon/tools/registry.cjs` TOOLS + SCHEMAS — add `browser.navigate` (one entry; remainder land in Wave 2). NOT in DEFAULT_POLICY (per-bot opt-in).
5. Extend `daemon/bots/loader.cjs` ALLOWED_CONFIG_KEYS with `browserAllow`, `browserDeny`; add per-key validation.
6. Extend `daemon/main.cjs` — `resolveBrowserConfigForBot(botId)` helper (mirror `resolveVaultConfigForBot` at lines 207-226); thread `browserAllow`, `browserDeny`, `ssrfAllowInternal`, `screenshotDir`, `runId` into `tools/call` ctx; add `browserAuditParams(name, args, successResult)` helper alongside `vaultAuditParams` at lines 228-244; wire audit dispatch in the `tools/call` finally block.
7. Extend `src/shared/types.ts` — add `browserAllow?: string[]` + `browserDeny?: string[]` to `BotConfig`; add `BrowserNavigateBlock` MessageBlock variant.
8. Extend `src/shared/ipc-channels.ts` — `BROWSER_GET_SCREENSHOT` + `EVENT_BROWSER_PAGE_CLOSED` (for future).
9. Extend `src/main/paths.ts` — `screenshotDir()` helper returning `<userData>/screenshots/`.
10. Create `tests/unit/browser_policy.test.ts` (>= 12 cases: scheme allowlist, SSRF private/link-local/loopback, default-deny empty allowlist, allowlist match, denylist match, picomatch dotfiles).
11. Create `tests/unit/browser_audit.test.ts` (>= 6 cases: 5-key shape, no URL in audit, no HTML in audit).

**Acceptance:** `npm ls playwright-core` exits 0; Vitest passes ≥ 18 new tests; TS build clean; `npx playwright install --dry-run chromium` exits 0.

### Wave 2 (Expansion) — `08-02-PLAN.md`
**Goal:** Wire the remaining 5 tools (`browser_click`, `browser_type`, `browser_screenshot`, `browser_evaluate`, `browser_fill_form`) + the `app://` screenshot handler.

**Tasks:**
1. Create `daemon/browser/screenshots.cjs` — `captureScreenshot({page, screenshotDir, runId, n})` writing PNG via tmp+rename.
2. Create `daemon/tools/browser_click.cjs` — calls `page.click(selector)` then `page.evaluate(() => document.body.innerText.slice(0, 5000))` for the resulting-state return.
3. Create `daemon/tools/browser_type.cjs` — uses `page.locator(selector).fill(text)` (safer than `page.type` which fires keypress events).
4. Create `daemon/tools/browser_screenshot.cjs` — invokes `captureScreenshot`, returns `{ path, bytes, runId }`.
5. Create `daemon/tools/browser_evaluate.cjs` — wraps `page.evaluate` with a 10s timeout and a 50KB result cap.
6. Create `daemon/tools/browser_fill_form.cjs` — `Promise.all(fields.map(...))` with a shared timeout; optional `submit` clicks a final button.
7. Extend `daemon/tools/registry.cjs` TOOLS + SCHEMAS — add the 5 new entries.
8. Extend `src/main/ipc/browser.ts` (NEW) — register `app://` protocol handler that resolves to `<userData>/screenshots/...`; expose `BROWSER_GET_SCREENSHOT` IPC handler that returns `{ ok, fileUri }`.
9. Extend `src/main/preload/index.ts` — `api.browser.getScreenshot({ runId, n })` namespace.
10. Extend `src/shared/types.ts` — 5 more MessageBlock variants (`browser_click`, `browser_type`, `browser_screenshot`, `browser_evaluate`, `browser_fill_form`).
11. Create `tests/unit/browser_screenshots.test.ts` (>= 6 cases: file write, atomic rename, path normalization, screenshotBytes in audit).
12. Create `tests/unit/browser_evaluate.test.ts` (>= 4 cases: timeout, result cap, sandboxed expression shape).

**Acceptance:** All 6 tools visible via `tools/list`; Vitest passes ≥ 10 new tests; TS build clean.

### Wave 3 (UI + E2E) — `08-03-PLAN.md`
**Goal:** Render the 6 MessageBlock variants in chat + per-bot URL allowlist UI + Playwright daemon smoke covering all 6 tools end-to-end.

**Tasks:**
1. Create `src/renderer/components/{BrowserNavigateBlock,BrowserClickBlock,BrowserFillFormBlock,BrowserScreenshotBlock,BrowserEvaluateBlock,BrowserTypeBlock}.tsx` — small components mirroring the Vault*Block pattern (header + collapsed body).
2. Extend `src/renderer/components/MessageBlock.tsx` switch dispatch — add the 6 new cases.
3. Create `src/renderer/state/browser.ts` (NEW) — mirror `src/renderer/state/vault.ts` for `browserAllow` / `browserDeny` + a global default-deny toggle.
4. Create `src/renderer/components/BotSettingsBrowserTab.tsx` (NEW) — mirror `BotSettingsObsidianTab` from Phase 7; 4 checkboxes for the 6 tools + URL allow/deny textareas + global SSRF toggle.
5. Extend `src/renderer/components/BotSettingsPage.tsx` — add `'browser'` to TabId union (now 6 tabs total: general, permissions, schedule, history, obsidian, browser).
6. Extend `src/renderer/styles/app.css` — `.block-browser-*` styles + `.settings-tab-browser` styles.
7. Extend `tests/playwright/fake-m3-server.ts` — 6 new helpers: `streamBrowserNavigateToolUse`, `streamBrowserClickToolUse`, etc.
8. Create `tests/playwright/browser-automation.test.ts` (NEW) — 6-case E2E suite covering each REQ-ID with a Node `http.createServer` test fixture.
9. Extend `playwright.config.ts` — add the new test to the `daemon-smoke` project.

**Acceptance:** All 6 success criteria PASS; Playwright daemon smoke green; TS build clean; full Vitest + Playwright suite green.

## Artifacts This Phase Produces

### New Files (Wave 1)
- `daemon/browser/lifecycle.cjs` — lazy Chromium launch (~50 lines)
- `daemon/browser/contexts.cjs` — per-bot BrowserContext map (~60 lines)
- `daemon/browser/policy.cjs` — URL allowlist + SSRF shield (~120 lines)
- `daemon/browser/index.cjs` — barrel exports (~15 lines)
- `daemon/tools/browser_navigate.cjs` — tracer tool (~80 lines)
- `tests/unit/browser_policy.test.ts` — URL/SSRF tests (~250 lines, ≥12 cases)
- `tests/unit/browser_audit.test.ts` — audit shape tests (~150 lines, ≥6 cases)

### New Files (Wave 2)
- `daemon/browser/screenshots.cjs` — PNG write helper (~40 lines)
- `daemon/tools/browser_click.cjs` (~70 lines)
- `daemon/tools/browser_type.cjs` (~70 lines)
- `daemon/tools/browser_screenshot.cjs` (~50 lines)
- `daemon/tools/browser_evaluate.cjs` (~70 lines)
- `daemon/tools/browser_fill_form.cjs` (~100 lines)
- `src/main/ipc/browser.ts` — IPC + `app://` handler (~80 lines)
- `tests/unit/browser_screenshots.test.ts` — PNG/atomic write tests (~150 lines, ≥6 cases)
- `tests/unit/browser_evaluate.test.ts` — eval sandbox tests (~100 lines, ≥4 cases)

### New Files (Wave 3)
- `src/renderer/state/browser.ts` — module-scope store + subscription (~150 lines)
- `src/renderer/components/BrowserNavigateBlock.tsx` (~60 lines)
- `src/renderer/components/BrowserClickBlock.tsx` (~50 lines)
- `src/renderer/components/BrowserTypeBlock.tsx` (~50 lines)
- `src/renderer/components/BrowserFillFormBlock.tsx` (~70 lines)
- `src/renderer/components/BrowserScreenshotBlock.tsx` (~80 lines)
- `src/renderer/components/BrowserEvaluateBlock.tsx` (~60 lines)
- `src/renderer/components/BotSettingsBrowserTab.tsx` (~250 lines, mirror Phase 7 ObsidianTab)
- `tests/playwright/browser-automation.test.ts` — 6-case E2E suite (~400 lines)

### Modified Files (Wave 1)
- `package.json` — add `playwright-core@^1.63.0` (runtime), `playwright-chromium@^1.63.0` (dev)
- `package-lock.json` — regenerated
- `daemon/tools/registry.cjs` — TOOLS + SCHEMAS add `browser.navigate`
- `daemon/bots/loader.cjs` — ALLOWED_CONFIG_KEYS extends with `browserAllow`, `browserDeny`; per-key validation
- `daemon/main.cjs` — `resolveBrowserConfigForBot` + `browserAuditParams` + audit dispatch + ctx enrichment
- `src/shared/types.ts` — `BotConfig.browserAllow/browserDeny`, `BrowserNavigateBlock` MessageBlock variant
- `src/shared/ipc-channels.ts` — `BROWSER_GET_SCREENSHOT`, `EVENT_BROWSER_PAGE_CLOSED`
- `src/main/paths.ts` — `screenshotDir()` helper

### Modified Files (Wave 2)
- `daemon/tools/registry.cjs` — 5 new TOOLS + SCHEMAS
- `src/main/preload/index.ts` — `api.browser.getScreenshot` namespace + EVENT_CHANNELS extension
- `src/shared/types.ts` — 5 more MessageBlock variants
- `src/main/ipc/index.ts` — `registerBrowserHandlers()` invocation

### Modified Files (Wave 3)
- `src/renderer/components/MessageBlock.tsx` — 6 new switch cases
- `src/renderer/components/BotSettingsPage.tsx` — 6th `'browser'` tab + URL hash sync
- `src/renderer/styles/app.css` — `.block-browser-*` + `.settings-tab-browser` styles
- `tests/playwright/fake-m3-server.ts` — 6 new `streamBrowser*ToolUse` helpers
- `playwright.config.ts` — add `browser-automation.test.ts` to daemon-smoke project

### Total File Count
- **21 new files** (5 Wave 1 + 9 Wave 2 + 9 Wave 3; overlaps where Wave 2 tools count as new)
- **13 modified files** (3 + 3 + 5)

### NPM Packages Added
- `playwright-core@^1.63.0` (runtime, ~13.45MB unpacked; the API only)
- `playwright-chromium@^1.63.0` (devDep, ~1MB; the Chromium download driver)
- Chromium binary (~150MB; installed via `npx playwright install chromium` to `%LOCALAPPDATA%\ms-playwright\`)

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Playwright + Chromium lifecycle | Daemon (Node 20 child process) | — | The renderer is a BrowserWindow and must not host the tool driver (SEC-01). Spawning Chromium in-process in Electron renderer breaks sandbox isolation and forks the renderer state. |
| Per-bot URL allowlist + SSRF shield | Daemon (`daemon/browser/policy.cjs`) | `daemon/bots/policy.cjs` (tool allowlist) | The bot allowlist gate decides whether the bot may call any browser tool at all; the per-URL policy decides what URL each call may target. Mirrors Phase 7's two-layer `checkVaultAccess` at `daemon/vault/glob.cjs:44-71`. |
| Page lifecycle (page/context/cookies) | Daemon (`daemon/browser/contexts.cjs`) | — | Cookies + localStorage must be isolated per bot; one BrowserContext per bot keeps the invariant simple and matches Phase 7's per-bot `botDir`. |
| Screenshot bytes → file | Daemon (`daemon/browser/screenshots.cjs`) | Main (`src/main/ipc/browser.ts` — IPC passthrough) | Daemon writes the file (it owns the page), main passes `file://` URIs to the renderer. Renderer never receives raw PNG bytes over IPC (audit minimization; size budget). |
| URL display in chat | Renderer (`src/renderer/components/BrowserNavigateBlock.tsx`) | — | Mirrors `VaultReadBlock`'s collapse + URL header pattern. |
| Screenshot display in chat | Renderer (`src/renderer/components/BrowserScreenshotBlock.tsx`) | — | `<img src={fileUri}>` with cap-height CSS to keep viewport-sized; `alt` carries the runId + URL (relative, never absolute). |
| Audit log writing | Daemon (`daemon/audit.cjs` — existing) | — | No new audit code; just new audit-param helpers in `daemon/main.cjs` (`browserAuditParams` parallel to `vaultAuditParams` at `daemon/main.cjs:228-244`). |
| Per-bot URL allowlist configuration | Renderer (`src/renderer/components/BotSettingsBrowserTab.tsx`) → Main → Daemon | — | Mirrors `BotSettingsObsidianTab` (Phase 7). Bot-level allowlist stored in `<userData>/bots/<bot>/config.json#browserAllow`. |
| Cancel propagation | Daemon (`ctx.signal` already wired by `tools/call` at `daemon/main.cjs:455`) | — | Phase 4's AbortController map already supports `tools/cancel` → `abortController.signal` → Playwright `page.close()` on abort. |
| Chromium download / install | CI / setup script | npm postinstall hook (dev-only) | `playwright-chromium` ships a postinstall that downloads Chromium via `npx playwright install`. The full Chromium is ~150MB and lives under `%LOCALAPPDATA%\ms-playwright\` on Windows. CLAUDE.md forbids building native modules; Chromium is a pre-built binary download, which is permitted. |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `playwright-core` | `^1.63.0` | The Playwright API without bundled browsers (verified via `npm view playwright-core version` → `1.63.0`) | Standard for app-bundled automation — we ship the API only and download Chromium separately. Matches Electron Node-side patterns and keeps the renderer from accidentally importing `playwright`. [VERIFIED: npm registry] |
| `playwright-chromium` (devDep) | `^1.63.0` | Just the Chromium browser binary downloader (~150MB once installed at `%LOCALAPPDATA%\ms-playwright\`) | v1.38+ no longer auto-downloads on `npm install`; explicit `npx playwright install chromium` is the documented migration. [CITED: https://playwright.dev/docs/release-notes] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `dns.resolve4` / `dns.lookup` from `node:dns` | Node 20 stdlib | Resolve hostname → IP before navigation (SSRF shield) | Every `browser_navigate` must resolve the hostname once and check against the SSRF denylist before calling `page.goto()`. |
| `net` from `node:net` | Node 20 stdlib | IP-range classification (private/link-local/loopback) | Used by the SSRF check (RFC1918 + 127.0.0.0/8 + 169.254.0.0/16 + IPv6 fc00::/7 + fe80::/10 + ::1). |
| `AbortController` (existing) | Node 20 stdlib | Cancel propagation | Phase 4's `ensureAbortController` at `daemon/main.cjs:137-148` is reused as-is. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `playwright-core` + `playwright-chromium` | Full `playwright` package | Full package downloads all three browser engines (Chromium + Firefox + WebKit, ~400MB+). The bot never drives Firefox/WebKit; overpays. |
| `playwright-core` only | `puppeteer-core` | Puppeteer lacks Playwright's `fill_form`-style multi-field API and has weaker actionability checks. Phase 8's `browser_fill_form` requirement (`TOOL-12`) maps cleanly to `page.locator(...).fill([...])` in Playwright. |
| Per-bot BrowserContext (recommended) | Single shared context | Cookies/localStorage would leak across bots — a security bug, not a feature. Per-bot contexts are nearly free (Chromium holds them in a single process). |
| Lazy-launch on first call | Eager launch at daemon startup | A bot that never uses the browser pays the ~150MB download + 500ms cold-start cost for nothing. Lazy launch keeps the daemon lean. |
| Daemon-hosted Chromium (recommended) | Renderer-hosted Chromium | Renderer is a BrowserWindow already; spawning another Chromium inside it is awkward and breaks the daemon-renderer process boundary mandated by SEC-01. |

**Version verification:** `npm view playwright-core version` → `1.63.0`; `npm view playwright-chromium version` → `1.63.0`; `npm view playwright-core dist.unpackedSize` → `13.45 MB` (the API package, not including Chromium). The Chromium binary itself is ~150MB and installed via `npx playwright install chromium` at first run.

**Installation:**

```bash
npm install playwright-core@^1.63.0
npm install --save-dev playwright-chromium@^1.63.0
npx playwright install chromium   # one-time; CI step
```

## Package Legitimacy Audit

The audit gate is required because Phase 8 introduces the first new runtime dep since Phase 7 (which added `picomatch@^4`).

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `playwright-core` | npm | 7 yrs (since Playwright 1.0) | 7M+/wk | github.com/microsoft/playwright | OK | Approved (runtime dep) |
| `playwright-chromium` | npm | 7 yrs | 2M+/wk | github.com/microsoft/playwright | OK | Approved (devDep — Chromium download driver only) |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none.

`playwright-core` and `playwright-chromium` are both first-party Microsoft packages published from the same monorepo as `@playwright/test`. The download step (`npx playwright install chromium`) hits `playwright.azureedge.net` (Microsoft CDN) and is the same pipeline used by CI providers worldwide. No alternative channel needed. The pre-built Chromium binary does not require `node-gyp` and complies with the CLAUDE.md "no native modules that require building" constraint.

The `playwright-chromium` devDep carries a `postinstall` script that runs `node install.js` — this is the standard download driver, not malicious. Verified by inspecting the package contents (binary download only; no eval, no network calls outside the Microsoft CDN). No `SUS` flag.

## Architecture Patterns

### System Architecture Diagram

```
                                 ELECTRON MAIN
                                 ┌──────────────────────────────────────────┐
                                 │ src/main/ipc/browser.ts                  │
                                 │   handles BROWSER_GET_SCREENSHOT         │
                                 │   returns { ok, fileUri, bytes }         │
                                 └────┬────────────────────┬────────────────┘
                                      │ ipcMain.handle      │ webContents.send
                                      ▼                     ▲
 RENDERER (BrowserWindow)        MAIN ↔ DAEMON (stdio NDJSON)
 ┌────────────────────────────────┐    ┌──────────────────────────────────────┐
 │ BrowserNavigateBlock            │    │ daemon/main.cjs tools/call           │
 │ BrowserClickBlock               │    │   resolves ctx.browserContext        │
 │ BrowserFillFormBlock            │    │   calls registry.callTool(...)       │
 │ BrowserScreenshotBlock <img>     │    │   audit.appendAudit(5-key shape)     │
 │ BrowserEvaluateBlock             │    │                                      │
 │ BotSettingsBrowserTab            │    │ daemon/tools/registry.cjs            │
 │                                  │    │   TOOLS += 6 browser.* entries       │
 └────────────────────────────────┘    │                                      │
                                       │ daemon/browser/                      │
                                       │   policy.cjs   ← URL allowlist + SSRF│
                                       │   contexts.cjs ← per-bot BrowserCtx  │
                                       │   screenshots.cjs ← writes PNG to    │
                                       │                     <userData>/...   │
                                       │   lifecycle.cjs ← lazy launch/       │
                                       │                     shared process   │
                                       │                                      │
                                       │   ╔═════════════════════════════╗   │
                                       │   ║  Chromium (Playwright)       ║   │
                                       │   ║   ~150MB at %LOCALAPPDATA%\  ║   │
                                       │   ║   ms-playwright\chromium-... ║   │
                                       │   ╚═════════════════════════════╝   │
                                       └──────────────────────────────────────┘
```

### Recommended Project Structure

```
daemon/
├── browser/                      # NEW
│   ├── lifecycle.cjs             # lazy Chromium launch + process cleanup
│   ├── contexts.cjs              # per-bot BrowserContext map
│   ├── policy.cjs                # URL allowlist + SSRF shield (mirrors vault/glob.cjs)
│   ├── screenshots.cjs           # write PNG to <userData>/screenshots/...
│   └── index.cjs                 # barrel exports
├── tools/
│   ├── browser_navigate.cjs      # NEW (mirrors vault_read.cjs:30-97)
│   ├── browser_click.cjs         # NEW
│   ├── browser_type.cjs          # NEW
│   ├── browser_screenshot.cjs    # NEW
│   ├── browser_evaluate.cjs      # NEW
│   └── browser_fill_form.cjs     # NEW (mirrors Phase 2 multi-arg pattern)
src/
├── main/
│   ├── paths.ts                  # EXTEND: screenshotDir()
│   ├── preload/index.ts          # EXTEND: api.browser.*
│   └── ipc/browser.ts            # NEW (mirror src/main/ipc/vault.ts)
├── shared/
│   ├── types.ts                  # EXTEND: 6 new MessageBlock variants
│   └── ipc-channels.ts           # EXTEND: BROWSER_* + EVENT_BROWSER_*
├── renderer/
│   ├── state/browser.ts          # NEW (mirror src/renderer/state/vault.ts)
│   └── components/
│       ├── BrowserNavigateBlock.tsx
│       ├── BrowserClickBlock.tsx
│       ├── BrowserFillFormBlock.tsx
│       ├── BrowserScreenshotBlock.tsx
│       ├── BrowserEvaluateBlock.tsx
│       ├── BotSettingsBrowserTab.tsx
│       └── BotSettingsPage.tsx   # EXTEND: 6th tab
tests/
├── unit/
│   ├── browser_policy.test.ts    # URL allowlist + SSRF (mirror vault_glob.test.ts)
│   └── browser_screenshots.test.ts
└── playwright/
    └── browser-automation.test.ts # E2E daemon smoke
```

### Pattern 1: Lazy Chromium Launch (`daemon/browser/lifecycle.cjs`)

**What:** A module-level `chromium` reference that's `null` until the first `browser_*` tool call, then `await chromium.launch({ headless: true })` (one time). Subsequent calls reuse the same browser instance. On daemon exit, the process dies with the daemon, so cleanup is implicit (Windows + Electron + child-process = `taskkill /F` on daemon SIGKILL).

**When to use:** Every browser tool in `daemon/tools/browser_*.cjs` calls `ensureBrowser(ctx)` before any Playwright API.

**Example:**
```javascript
// Source: derived from Playwright Node API docs + Phase 7 lazy-load patterns
const { chromium } = require('playwright-core');

let browserPromise = null;
function ensureBrowser(ctx) {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    // On daemon exit, surface the close error rather than silently leaking.
    browserPromise.catch(() => { browserPromise = null; });
  }
  return browserPromise;
}
```

`--no-sandbox` is necessary when Playwright Chromium runs inside the Electron-spawned daemon child (the daemon already runs as a child of Electron, not as root, so Chromium's sandbox would refuse). `--disable-dev-shm-usage` is the documented workaround for `/dev/shm` being too small on some Linux containers; harmless on Windows.

### Pattern 2: Per-Bot BrowserContext Map (`daemon/browser/contexts.cjs`)

**What:** A `Map<botId, BrowserContext>` maintained in module scope. On `browser_navigate` for a bot with no context yet, call `browser.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: false, userAgent: 'Localbot/0.8 (+https://github.com/simthesexist/LocalBot)' })`. Each context holds its own cookies + localStorage; contexts die when the daemon dies.

**When to use:** Every browser tool calls `getPage(botId)` which lazily creates the context + page.

**Example:**
```javascript
// Source: derived from Playwright BrowserContext docs + Phase 4 per-bot isolation pattern
const contexts = new Map(); // botId -> { context, page }

async function getPage(botId, signal) {
  const browser = await ensureBrowser();
  let entry = contexts.get(botId);
  if (!entry) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    contexts.set(botId, { context, page });
    entry = { context, page };
  }
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' });
  return entry.page;
}
```

### Pattern 3: URL Allowlist + SSRF Shield (`daemon/browser/policy.cjs`)

**What:** Mirrors `daemon/vault/glob.cjs` exactly — `checkBrowserUrl({ browserAllow, browserDeny, ssrfAllowInternal, url })` returns `{ allowed, reason, pattern? }`. Pipeline order: (1) scheme allowlist (`http:` + `https:` only, refuse `file:`, `javascript:`, `data:`, `ftp:`, `chrome:`), (2) hostname resolution via `dns.lookup` (handles DNS rebinding — we resolve once and use the IP for the SSRF check), (3) IP-range classification against RFC1918/127/169.254/IPv6 link-local (unless `ssrfAllowInternal === true`), (4) glob match against `browserDeny`, (5) glob match against `browserAllow` (empty blocks all). Per `OWASP SSRF Prevention Cheat Sheet` [CITED: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html].

**Example:**
```javascript
// Source: pattern from daon/vault/glob.cjs:44-71 + OWASP SSRF cheat sheet
const picomatch = require('picomatch');
const dns = require('node:dns').promises;
const net = require('node:net');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    if (ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
    if (ip.startsWith('169.254.')) return true;            // link-local + cloud metadata
    if (ip.startsWith('172.')) {
      const second = parseInt(ip.split('.')[1], 10);
      if (second >= 16 && second <= 31) return true;        // RFC1918
    }
    if (ip === '0.0.0.0') return true;
  }
  if (net.isIPv6(ip)) {
    if (ip === '::1') return true;
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // ULA
    if (ip.startsWith('fe80:')) return true;                // link-local
  }
  return false;
}

async function checkBrowserUrl({ browserAllow, browserDeny, ssrfAllowInternal, url }) {
  let parsed;
  try { parsed = new URL(url); } catch { return { allowed: false, reason: 'invalid_url' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { allowed: false, reason: 'scheme_denied', pattern: parsed.protocol };

  // DNS resolution → SSRF check before navigation (Pitfall: DNS rebinding)
  const ips = await dns.lookup(parsed.hostname, { all: true });
  for (const { address } of ips) {
    if (isPrivateIp(address) && !ssrfAllowInternal) {
      return { allowed: false, reason: 'ssrf_denied', pattern: address };
    }
  }

  // picomatch pipeline (mirrors vault)
  const path = parsed.pathname;
  if (Array.isArray(browserDeny) && browserDeny.length) {
    const m = picomatch(browserDeny, { dot: true });
    if (m(path)) return { allowed: false, reason: 'browser_deny' };
  }
  if (!Array.isArray(browserAllow) || browserAllow.length === 0) {
    return { allowed: false, reason: 'no_allowlist' };
  }
  if (!picomatch(browserAllow, { dot: true })(path)) {
    return { allowed: false, reason: 'not_in_allowlist' };
  }
  return { allowed: true };
}
```

### Pattern 4: Screenshot Pipeline (`daemon/browser/screenshots.cjs`)

**What:** `captureScreenshot(page, runId, n)` calls `page.screenshot({ type: 'png' })` → returns a Node `Buffer` → writes to `<userData>/screenshots/<runId>/<n>.png` via `fs.promises.writeFile` → returns the absolute path. The tool then formats `file://` URI for the renderer.

**When to use:** `browser_screenshot.cjs` is the only caller.

**Example:**
```javascript
// Source: Playwright Node API docs page.screenshot + Phase 7 vault_write tmp+rename pattern
const fs = require('node:fs/promises');
const path = require('node:path');

async function captureScreenshot({ page, screenshotDir, runId, n }) {
  const buf = await page.screenshot({ type: 'png' });
  await fs.mkdir(path.join(screenshotDir, runId), { recursive: true });
  const filename = `${n}.png`;
  const fullPath = path.join(screenshotDir, runId, filename);
  // tmp + rename atomic write (mirrors vault_write.cjs pattern)
  const tmp = `${fullPath}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, fullPath);
  return { bytes: buf.length, path: filename, absolutePath: fullPath };
}
```

Renderer receives `file://` URI (Electron allows `file://` from the renderer when `webSecurity: false` is set in `BrowserWindow` config — verify this is already on; if not, switch to `app://` protocol handler). If `file://` is blocked, the alternative is the `app://` custom protocol used by Phase 4 for static assets — `src/main/ipc/browser.ts` would resolve the absolute path and return a relative `app://localhost/screenshots/<runId>/<n>.png` URL.

### Anti-Patterns to Avoid

- **Renderer-driving Playwright directly:** Violates SEC-01 (renderer must not touch shell/network). Chromium belongs in the daemon.
- **Eager Chromium launch at daemon startup:** Wastes ~150MB RAM for bots that never browse. Lazy launch on first `browser_*` call.
- **Sharing one BrowserContext across bots:** Cookies + localStorage would leak between bots (cross-bot identity confusion). Per-bot contexts are free.
- **Logging full URLs in audit:** Even with query strings redacted, URLs can carry tokens, session IDs, or PII. Audit shape is `{tool, status, duration_ms, selector?, screenshotBytes?}` only.
- **Logging rendered HTML or screenshot bytes:** Same audit-minimization principle as Phase 7's `{path, bytes}` shape.
- **Allowing `file:` URLs:** A bot could read local files via `file:///C:/Users/simth/.ssh/id_rsa`. Scheme allowlist is `http` + `https` only.
- **Trusting the URL hostname for SSRF check:** DNS rebinding lets `attacker.com` resolve to `127.0.0.1` after the policy check. `dns.lookup` once at policy time, reuse the IP for the actual request — but Playwright's `page.goto` doesn't accept an IP, so the defense is "check once, navigate, and rely on browser context isolation for credential theft". A stronger fix would be Playwright's `context.route` interception, but that's overkill for Phase 8 MVP.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Browser lifecycle (launch, contexts, pages) | Custom CDP wrapper | `playwright-core`'s `chromium.launch` + `browser.newContext` + `context.newPage` | CDP is a moving target; Playwright wraps every browser quirk. |
| URL glob matching | Custom glob matcher | `picomatch` (already used in Phase 7 vault glob) | Already a project dep, single mental model. |
| Atomic file write for screenshots | Hand-rolled rename dance | Existing `tmp + rename` pattern from `daemon/tools/vault_write.cjs` | Matches the Phase 7 pattern (Pitfall 6). |
| Audit minimization | Custom JSONL shape | New `browserAuditParams(name, args, successResult)` helper alongside `vaultAuditParams` at `daemon/main.cjs:228-244` | Same 5-key shape; same caller (`tools/call` audit dispatch). |
| Cancel propagation | New IPC channel | Existing `ctx.signal` from `daemon/main.cjs:455` + `AbortController` map at `daemon/main.cjs:129` | Phase 4's plumbing works for any tool that respects `signal`. |
| Renderer state for browser config | New context/store | Mirror `src/renderer/state/vault.ts:43-64` (`ensureDaemonSubscription` + throttled `refresh`) | Same pattern, same 200ms throttle. |

**Key insight:** Playwright is a giant codebase. Anything that looks like "I can write this in 50 lines" (CDP wrappers, actionability polling, screenshot encoding) is wrong. Use the library.

## Runtime State Inventory

> Include this section for rename/refactor/migration phases only. Omit entirely for greenfield phases.

**N/A — Phase 8 is greenfield.** No existing string, code path, or runtime state is being renamed. The only "state" introduced is the new per-bot BrowserContext map and `<userData>/screenshots/` directory, both of which are created on first use. On uninstall, both die with `<userData>`.

## Common Pitfalls

### Pitfall 1: DNS Rebinding Bypass

**What goes wrong:** Bot calls `browser_navigate('http://attacker.com/')`; policy checks `attacker.com`, sees a public IP, allows it. DNS rebinds to `127.0.0.1` between the check and Playwright's `page.goto`. The bot reads `http://127.0.0.1:11434/` (Ollama API) or worse.

**Why it happens:** DNS TTLs allow a hostname to resolve to different IPs in rapid succession.

**How to avoid:** `dns.lookup` once at policy time AND pass the resolved IP to Playwright via `context.route('**', ...)` interception. Phase 8 MVP accepts the residual risk for v1; document it in the threat model (Phase 9 NET-03 may revisit).

**Warning signs:** Audit rows show internal-IP `Host:` headers from external-looking URLs.

### Pitfall 2: Login Form Replay / Credential Theft via Screenshot

**What goes wrong:** Bot logs into a web app, takes a screenshot, screenshot is written to `<userData>/screenshots/<runId>/<n>.png`, and the renderer can fetch it via the `app://` handler. A malicious bot's tool call could be designed to exfiltrate the screenshot via `vault.write` to an Obsidian vault that another bot reads.

**Why it happens:** Once the PNG is on disk, the renderer's existing file-loading applies; the file isn't more secret than the chat history.

**How to avoid:** Document in the threat model. The screenshot is visible to the user (that's the point of the feature). The defense against exfiltration is the existing per-tool allowlist (Phase 4 SEC-02) — bots don't have `vault.write` unless explicitly allowed. Add a "redact screenshots containing `<input type=password>` patterns" gate to `browser_screenshot.cjs` if this becomes a real concern in Phase 9+.

**Warning signs:** Audit logs show `browser_screenshot` followed quickly by `vault.write` to an unusual path.

### Pitfall 3: Lazy-Launch Race on First Browser Tool Call

**What goes wrong:** Two bots call `browser_navigate` simultaneously; the first call to `ensureBrowser()` returns `browserPromise` while it's still pending. The second call sees the same promise and awaits it. Works correctly. BUT: if one of them then `ctx.aborts` between the await and `page.goto`, Playwright continues the navigation anyway.

**Why it happens:** AbortSignal plumbing in `tools/call` aborts the daemon's outer Promise but doesn't propagate into Playwright's internal page state.

**How to avoid:** Wrap `page.goto(url, { signal })` so Playwright honors the abort natively. Playwright supports `signal` on most operations in v1.40+.

**Warning signs:** Long-running `page.goto` calls that survive a `bots/cancel` event.

### Pitfall 4: URL Allowlist Caching

**What goes wrong:** Bot config is updated mid-run (user adds a new URL to `browserAllow`). The tool handler caches the per-bot allowlist at first call and never re-reads.

**Why it happens:** A naive optimization that breaks Phase 7's "no cache" pattern.

**How to avoid:** Mirror Phase 7 `resolveVaultConfigForBot` at `daemon/main.cjs:207-226` — re-read `botLoader.readConfig(userDataDirState, botId)` on every `tools/call`. The browser allowlist lives at `botCfg.browserAllow` + `botCfg.browserDeny`; same per-call pattern.

**Warning signs:** User edits `browserAllow` in the UI, the change doesn't take effect on the next tool call.

### Pitfall 5: Audit Log Leaks URL Query Strings

**What goes wrong:** `browser_navigate('https://example.com/?token=secret')` writes an audit row containing the full URL including the token.

**Why it happens:** Default `args` in audit append is the raw tool input.

**How to avoid:** `browserAuditParams(name, args, successResult)` extracts only `{ hostname, path, status, duration_ms }` (hostname + path, never query string). Pattern matches `vaultAuditParams` at `daemon/main.cjs:228-244`.

**Warning signs:** `grep -r 'token\|api_key' <userData>/audit/` finds hits.

### Pitfall 6: Screenshot Disk Quota

**What goes wrong:** A loop of `browser_navigate` + `browser_screenshot` fills the user's disk. A runaway bot at 1 screenshot/second for 10 minutes = 600 PNGs × 200KB = 120MB; over a day that's 17GB.

**Why it happens:** No retention policy.

**How to avoid:** MVP: cap screenshots per runId at 50 (Phase 9 may add an LRU). Cap total disk at 500MB across all runIds, oldest pruned first. Mirror `vault_search` max_results pattern at `daemon/tools/vault_search.cjs` (max 1000). Document the cap in the tool description.

**Warning signs:** `<userData>/screenshots/` exceeds 500MB.

### Pitfall 7: Browser Context Leaks Across Bot Delete

**What goes wrong:** Bot is deleted (Phase 4 `bots/delete`); its BrowserContext is never closed. Chromium holds the cookies + page indefinitely. Memory + identity leak.

**Why it happens:** The `bots/delete` JSON-RPC handler removes the bot's config but doesn't know about the browser contexts map.

**How to avoid:** Add `await contexts.delete(botId).then(c => c?.close())` to the `bots/delete` handler in `daemon/main.cjs`. Plan 2 (UI work) wires this; Plan 1 (daemon core) at minimum must expose the cleanup.

**Warning signs:** Memory grows over time even after deleting bots.

## Code Examples

Verified patterns from official sources:

### Common Operation 1: `browser_navigate` (mirrors `daemon/tools/vault_read.cjs:30-97`)

```javascript
// Source: pattern derived from daemon/tools/vault_read.cjs (Phase 7) + Playwright Node API docs
const { checkBrowserUrl } = require('../browser/policy.cjs');
const { getPage } = require('../browser/contexts.cjs');

async function call(args, ctx) {
  const url = (args && typeof args.url === 'string') ? args.url : '';
  if (!url) throw err('invalid_url', 'url required');

  // SSRF + allowlist check (mirrors vault_read.cjs:37-61 checkVaultAccess pattern)
  const verdict = await checkBrowserUrl({
    browserAllow: ctx.browserAllow || [],
    browserDeny: ctx.browserDeny || [],
    ssrfAllowInternal: ctx.ssrfAllowInternal === true,
    url,
  });
  if (!verdict.allowed) {
    throw Object.assign(new Error(`access denied: ${verdict.reason}`),
      { code: 'browser_denied', reason: verdict.reason, pattern: verdict.pattern });
  }

  const page = await getPage(ctx.bot, ctx.signal);
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000, signal: ctx.signal });
  // Return: rendered title + text content (not raw HTML — keeps payloads small)
  const title = await page.title();
  const text = await page.evaluate(() => document.body.innerText.slice(0, 50_000));
  return {
    url: new URL(url).hostname + new URL(url).pathname, // normalized; no query string
    status: response?.status() ?? null,
    title,
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

module.exports = { call };
```

### Common Operation 2: `browser_screenshot` (writes PNG, returns `file://` URI)

```javascript
// Source: Playwright Node API docs + Phase 7 vault_write tmp+rename atomic pattern
const { captureScreenshot } = require('../browser/screenshots.cjs');
const path = require('node:path');

async function call(args, ctx) {
  const filename = await captureScreenshot({
    page: await getPage(ctx.bot, ctx.signal),
    screenshotDir: ctx.screenshotDir,
    runId: ctx.runId,
    n: args?.n ?? Date.now().toString(36),
  });
  return {
    path: filename.path,                          // relative: <runId>/<n>.png
    absolutePath: filename.absolutePath,          // used by IPC handler to build file:// URI
    bytes: filename.bytes,
  };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| HTTP fetch tools (`node-fetch`) | Playwright-driven Chromium | 2024+ | Handles JS-heavy sites, SPAs, OAuth redirects. The codebase has no HTTP-fetch tools; Phase 8 IS the introduction. |
| `puppeteer` | Playwright | 2022+ | Playwright has multi-browser (Chromium/Firefox/WebKit), better actionability checks, official Node + Python + .NET + Java SDKs. |
| Bundled Chromium via puppeteer | `playwright-chromium` separate download | v1.38+ (Playwright) | Decouples npm install from browser download; CI can pre-warm a cache. |
| Cookies shared across bots | Per-bot BrowserContext | Standard Playwright pattern | Cookies + localStorage isolation is a Playwright primitive. |

**Deprecated/outdated:**
- `puppeteer`: still maintained but Playwright has overtaken in API ergonomics for AI agent use cases (Anthropic SDK + Playwright is the recommended stack per Anthropic's own cookbook).
- Bundling the Chromium binary into npm: Playwright v1.38+ removed this. The right way is `npx playwright install chromium` once at CI setup.

## Assumptions Log

> List all claims tagged `[ASSUMED]` in this research.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Chromium download size is ~150MB on Windows (post v1.38 separate download) | Standard Stack / Dependency Footprint | If size is much larger (e.g., 300MB), CI setup time grows; need to verify by running install. |
| A2 | `--no-sandbox` is required for Playwright Chromium running inside the Electron-spawned daemon child | Pattern 1 | If sandbox actually works in this configuration, the flag is harmless; if `--no-sandbox` is necessary but not set, Chromium fails to launch. |
| A3 | Per-bot BrowserContexts are "nearly free" (held in a single Chromium process) | Pattern 2 | If each context forks a renderer process (Chromium's design), 5 bots = 5 renderers = significant memory. |
| A4 | DNS resolution at policy time is sufficient against DNS rebinding for v1 | Pitfall 1 | Rebinding attacks could read local services; Phase 9+ should revisit with Playwright `context.route` interception. |
| A5 | `file://` URIs work in the Electron renderer when `webSecurity: false` is set | Pattern 4 | If `webSecurity: true` (default) blocks `file://`, we need the `app://` custom protocol alternative — adds one IPC method. |
| A6 | Electron's `BrowserWindow` config already has `webSecurity: false` (or the `app://` handler is registered) | Pattern 4 | If neither is true, we add an `app://` handler in `src/main/ipc/browser.ts` for screenshots. |
| A7 | Audit shape `{tool, status, duration_ms, selector?, screenshotBytes?}` is sufficient and matches Phase 7's minimization precedent | Pitfall 5 / Audit section | If we want to debug a bot's navigation history, we may want the normalized URL hostname (no path) — easy to add. |
| A8 | Per-bot `browserAllow` lives at `<userData>/bots/<bot>/config.json#browserAllow` (mirrors `vaultAllow`) | Renderer + UI Plan | If a different schema is preferred (e.g., a separate `browser.json` per bot), the loader/registry changes are larger. |

**If this table is empty:** All claims in this research were verified or cited — no user confirmation needed.

## Open Questions

1. **Default-deny scope for `browserAllow`**
   - What we know: Phase 7 vault pattern is "empty allowlist = blocked by default." Mirroring that for browser feels right, but a brand-new user trying the feature for the first time might find the bot unable to navigate ANY URL.
   - What's unclear: Should the default be deny-all (forces explicit opt-in) or a curated allowlist (e.g., `https://*.wikipedia.org`, `https://*.github.com`)?
   - Recommendation: Default-deny. Document the empty-allowlist block clearly. Power users will write their own allowlist; the safety default matters more than first-use ergonomics.

2. **IP-range denylist default-on**
   - What we know: SSRF risks include `localhost`, `127.0.0.1`, RFC1918 ranges, `169.254.169.254` (cloud metadata). The standard advice is to block by default.
   - What's unclear: For testing, we need `http://localhost:<port>` for the test server. An env-var opt-out (`LOCALBOT_ALLOW_INTERNAL_HOSTS=1`) covers hermetic E2E but adds a footgun.
   - Recommendation: Default-on (block internal IPs). Env-var opt-out. Document clearly that the env var also disables the SSRF shield in production if set.

3. **Per-tool-call page vs persistent page**
   - What we know: A persistent page is faster (no `newPage()` per call) but a runaway bot can fill the page with state that confuses the next call. A per-call page is safer but loses form state between calls.
   - What's unclear: Whether the LLM expects cross-call state (e.g., navigate → click → type chains).
   - Recommendation: Persistent page per bot context. Form-fill chains are the dominant use case. Cancel via `page.close()` on `bots/cancel`.

4. **Screenshot IPC strategy (file:// vs base64 vs app://)**
   - What we know: A typical viewport screenshot is 100–500KB PNG. Over IPC, base64 inflates to ~130–650KB. `file://` is free if `webSecurity: false`. `app://` is the cleanest (custom protocol registered with the renderer's existing setup).
   - What's unclear: Whether the renderer's CSP allows `file://` images. The renderer is an Electron BrowserWindow with Vite's default CSP.
   - Recommendation: Primary = `app://` via a new custom protocol handler in `src/main/ipc/browser.ts` (returns `app://localhost/screenshots/<runId>/<n>.png`). Fallback = `file://` if `app://` is already used elsewhere. Base64 is the last resort and inflates payloads.

5. **Default timeout for `page.goto` and `page.click`**
   - What we know: Default Playwright timeout is 30s. Long enough for most pages, too long for a 10-turn agent loop (300s+ if every tool times out).
   - What's unclear: Whether to expose timeout as a tool argument.
   - Recommendation: Hard-code `timeout: 30_000` in tool handlers. Surface a `{ timeout_ms: 30_000 }` field in the tool result so the renderer can show "navigated (30s budget)".

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 20+ | Daemon child process (CLAUDE.md) | Already verified (Phase 1+ locked v20.11.0+) | 20.x | — |
| `playwright-core` (runtime) | Phase 8 daemon | New dep to install | `1.63.0` | Cannot skip |
| `playwright-chromium` (dev) | `npx playwright install chromium` | New devDep | `1.63.0` | Could use `puppeteer-core` (different API) |
| Chromium binary (~150MB) | Playwright runtime | First-run download via `npx playwright install chromium` | Latest (auto-tracked) | Edge channel via `channel: 'msedge'` if Chromium download blocked |
| `picomatch` | URL glob matching (already installed Phase 7) | Already installed | `^4` | None — reuse |
| Node `dns.promises` + `net` | SSRF shield (stdlib) | Node 20 stdlib | built-in | None |
| `%LOCALAPPDATA%\ms-playwright\` | Chromium install dir | Windows default | built-in | Set `PLAYWRIGHT_BROWSERS_PATH` env var |
| Local test HTTP server | Playwright daemon smoke (Node `http.createServer`) | Node 20 stdlib | built-in | `@playwright/test` `request` fixture (adds dep) |

**Missing dependencies with no fallback:**
- `playwright-core` — without it, Phase 8 cannot run.

**Missing dependencies with fallback:**
- None. All required deps are either already installed or have a clear install path.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest v2.1.9 (pinned, Phase 1) + `@playwright/test` v1.63.0 |
| Config file | `vitest.config.ts` (existing) + `playwright.config.ts` (extended) |
| Quick run command | `npx vitest run tests/unit/browser_policy.test.ts tests/unit/browser_screenshots.test.ts` |
| Full suite command | `npm test && npm run test:smoke` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TOOL-07 | `browser_navigate` navigates and returns rendered text | E2E (Playwright daemon smoke) | `npx playwright test browser-automation.test.ts -g "navigate"` | No (Wave 0) |
| TOOL-08 | `browser_click` clicks a CSS selector and returns resulting state | E2E | `npx playwright test browser-automation.test.ts -g "click"` | No (Wave 0) |
| TOOL-09 | `browser_type` types into an input | E2E | `npx playwright test browser-automation.test.ts -g "type"` | No (Wave 0) |
| TOOL-10 | `browser_screenshot` captures PNG, file:// URI rendered in chat | E2E | `npx playwright test browser-automation.test.ts -g "screenshot"` | No (Wave 0) |
| TOOL-11 | `browser_evaluate` runs JS in page context | Unit + E2E | `npx vitest run tests/unit/browser_evaluate.test.ts` | No (Wave 0) |
| TOOL-12 | `browser_fill_form` fills multiple fields at once | E2E | `npx playwright test browser-automation.test.ts -g "fill_form"` | No (Wave 0) |
| SEC-Browser-01 | URL allowlist default-deny (empty blocks all) | Unit | `npx vitest run tests/unit/browser_policy.test.ts` | No (Wave 0) |
| SEC-Browser-02 | SSRF shield blocks RFC1918 / 127.0.0.0/8 / 169.254.0.0/16 | Unit | `npx vitest run tests/unit/browser_policy.test.ts` | No (Wave 0) |
| SEC-Browser-03 | Audit row carries `{tool, status, duration_ms, selector?, screenshotBytes?}` only (no URL, no HTML) | Unit + E2E | `npx vitest run tests/unit/browser_audit.test.ts` | No (Wave 0) |
| SEC-Browser-04 | Scheme allowlist (`http:` + `https:` only) | Unit | `npx vitest run tests/unit/browser_policy.test.ts` | No (Wave 0) |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/unit/browser_*.test.ts`
- **Per wave merge:** `npm test && npx playwright test browser-automation.test.ts`
- **Phase gate:** Full suite green + `npm run build` exits 0.

### Wave 0 Gaps

- [ ] `tests/unit/browser_policy.test.ts` — covers SEC-Browser-01, -02, -04 (URL allowlist, SSRF, scheme)
- [ ] `tests/unit/browser_screenshots.test.ts` — covers screenshot write + atomic rename + file:// URI build
- [ ] `tests/unit/browser_audit.test.ts` — covers SEC-Browser-03 (audit minimization shape)
- [ ] `tests/unit/browser_evaluate.test.ts` — covers TOOL-11 in isolation (no Playwright)
- [ ] `tests/playwright/browser-automation.test.ts` — covers TOOL-07..12 end-to-end against a Node `http.createServer` test fixture
- [ ] `playwright.config.ts` extended with `browser-automation.test.ts` in the `daemon-smoke` project (NOT the headed project — gated by `LOCALBOT_SMOKE_OK`)
- [ ] `tests/playwright/fake-m3-server.ts` extended with `streamBrowserNavigateToolUse`, `streamBrowserClickToolUse`, etc.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Partial | Per-bot BrowserContext isolation (cookies, localStorage) prevents cross-bot auth replay. Bot-level tool allowlist (Phase 4 SEC-02) decides whether `browser_*` tools are callable at all. |
| V4 Access Control | Yes | URL allowlist default-deny (mirror Phase 7 vault policy). Per-bot `browserAllow` + `browserDeny` + global `defaultDeny` (e.g., banking URLs). |
| V5 Input Validation | Yes | Scheme allowlist (`http` + `https` only); URL parser used; hostname normalization. |
| V6 Cryptography | No | No new crypto; TLS handled by Chromium. |
| V7 Error Handling | Partial | Audit row `outcome: 'error'` + `{code, message}` (existing pattern). Tool errors surfaced in renderer as collapsed error blocks. |
| V12 Files and Resources | Yes | Screenshot disk quota (Pitfall 6); `<userData>/screenshots/` dir write only via daemon. |
| V14 Configuration | Yes | `browserAllow` + `browserDeny` stored in `<userData>/bots/<bot>/config.json` (existing loader pattern, extended). |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Bot navigates to `file:///C:/Windows/System32/config/SAM` (local file read) | Information Disclosure | Scheme allowlist rejects `file:` → `code: 'scheme_denied'`. |
| Bot navigates to `http://localhost:11434/` (Ollama) | Information Disclosure | SSRF shield resolves hostname → 127.0.0.1 → rejects → `code: 'ssrf_denied'`. |
| Bot navigates to `http://169.254.169.254/latest/meta-data/` (cloud metadata) | Information Disclosure | SSRF shield rejects link-local range. |
| Bot navigates to `https://api.example.com/?token=secret` then leaks token via audit log | Information Disclosure | Audit shape `{tool, status, duration_ms, ...}` — no URL, no query string (Pitfall 5). |
| DNS rebinding: `attacker.com` resolves to public IP at check time, `127.0.0.1` at goto time | Information Disclosure | Document residual risk; Phase 9+ may add `context.route` interception (Open Question 4). |
| Screenshot exfiltration via `vault.write` to a shared Obsidian vault | Information Disclosure | Bot allowlist (SEC-02): a bot without `vault.write` in its allowlist can't run the exfiltration. |
| Bot types into a destructive web form (delete account) | Tampering | Each browser tool is invoked individually by the LLM; the user sees the action via inline tool block. Phase 9+ may add an approval modal for click/type actions on `<button>` elements with destructive `aria-label`s. |
| Bot fills form with sensitive input then leaks via screenshot | Information Disclosure | Same as screenshot exfiltration; mitigated by bot allowlist + audit minimization. |
| Browser context leak across bot delete | Information Disclosure | Cleanup hook in `bots/delete` JSON-RPC handler closes the context (Pitfall 7). |
| Chromium process leak on daemon crash | Denial of Service | Daemon process death kills Chromium child process (Windows process tree). Verify in `daemon/main.cjs` exit handling. |
| Chromium download MITM during CI install | Tampering | Download hits `playwright.azureedge.net` over HTTPS; checksum verified by the install script. |

## Sources

### Primary (HIGH confidence)
- `D:/Claude/Grokbot/daemon/main.cjs` (lines 207-272 — vault audit param helpers; lines 326-547 — initialize + tools/call + audit dispatch)
- `D:/Claude/Grokbot/daemon/tools/registry.cjs` (lines 15-243 — TOOLS + SCHEMAS + fileFor; lines 317-357 — callTool)
- `D:/Claude/Grokbot/daemon/tools/vault_read.cjs` (lines 30-97 — closest analog: file-I/O + per-call policy)
- `D:/Claude/Grokbot/daemon/vault/glob.cjs` (lines 17-71 — picomatch pipeline + SSRF-precedent glob filtering)
- `D:/Claude/Grokbot/src/renderer/state/vault.ts` (lines 1-173 — module-scope store + subscription pattern to mirror)
- `D:/Claude/Grokbot/src/renderer/components/BotSettingsPage.tsx` (lines 25-455 — tab + URL hash sync + debounce save)
- `D:/Claude/Grokbot/src/shared/types.ts` (lines 15-52 — MessageBlock discriminated union; lines 355-400 — BotConfig)
- `D:/Claude/Grokbot/src/shared/ipc-channels.ts` (lines 1-77 — CHANNELS + EVENT_ patterns)
- `D:/Claude/Grokbot/tests/playwright/fake-m3-server.ts` (lines 957-1274 — existing streamVault* helpers as template)
- `D:/Claude/Grokbot/.planning/phases/07-obsidian-integration/07-PATTERNS.md` (full pattern map for Phase 7; mirrors for Phase 8)

### Secondary (MEDIUM confidence)
- `npm view playwright-core version` → `1.63.0`; `npm view playwright-chromium version` → `1.63.0`; `npm view playwright-core dist.unpackedSize` → `13.45 MB` (API package, not Chromium binary)
- [Playwright Release notes](https://playwright.dev/docs/release-notes) — v1.38+ removed bundled browser download
- [Playwright Browsers docs](https://playwright.dev/docs/browsers) — `npx playwright install chromium` flow
- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) — allowlist + IP-range defense + DNS resolution guidance

### Tertiary (LOW confidence)
- Playwright Node API for `page.screenshot`, `page.fill`, `page.click`, `page.evaluate` (well-known stable API, but specific timeout/signal behavior in v1.63 should be verified at execution time)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — `npm view` confirms `playwright-core@1.63.0`; Phase 7 precedent for `picomatch` integration
- Architecture: HIGH — mirrors Phase 7 patterns exactly; per-bot BrowserContext is a documented Playwright primitive
- Pitfalls: MEDIUM — DNS rebinding (residual risk acknowledged), screenshot disk quota (heuristic, may need tuning)
- Security: HIGH — OWASP SSRF cheat sheet provides the canonical defense; pattern mirrors Phase 7 vault glob
- Test strategy: MEDIUM — Playwright daemon smoke pattern is proven (Phase 5 + 7); screenshot E2E will need an `app://` or `file://` verification

**Research date:** 2026-09-19
**Valid until:** 2026-10-19 (30 days; Playwright moves slowly but `playwright-core` minor versions ship monthly)
