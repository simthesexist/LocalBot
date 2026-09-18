---
phase: 04-multi-bot-crud-sidebar
plan: 03
type: execute
wave: 3
subsystem: bot-settings-runhistory-tests
tags: [phase-04, bot-runs, bot-settings-page, run-history-table, audit-minimization, multi-bot-cancel, playwright-smoke]
dependency_graph:
  requires: [phase-04-multi-bot-crud-sidebar-04-01, phase-04-multi-bot-crud-sidebar-04-02]
  provides: [BOTS_RUNS, BotSettingsPage, RunHistoryTable, useRunHistory, audit-minimization, bot-crud-smoke, multi-bot-smoke]
  affects: [main, renderer, daemon, tests]
tech-stack:
  added: []
  patterns: [url-hash-view-toggle, submit-on-blur-debounce, scroll-to-bottom-pagination, module-scope-cache-with-stale-revalidate, per-runId-abort-isolation, audit-params-minimization]
key-files:
  created:
    - src/renderer/components/BotSettingsPage.tsx
    - src/renderer/components/RunHistoryTable.tsx
    - src/renderer/state/runs.ts
    - tests/playwright/bot-crud.test.ts
    - tests/playwright/multi-bot.test.ts
  modified:
    - src/main/runs/jsonl.ts
    - src/main/bots/runs.ts
    - src/main/ipc/bots.ts
    - src/main/preload/index.ts
    - src/shared/types.ts
    - src/shared/ipc-channels.ts
    - src/shared/window.d.ts
    - src/renderer/App.tsx
    - src/renderer/components/Chat.tsx
    - src/renderer/components/BotSidebar.tsx
    - src/renderer/styles/app.css
    - daemon/main.cjs
    - daemon/runs/jsonl.cjs
    - tests/playwright/fake-m3-server.ts
    - tests/unit/bot_runs.test.ts
    - tests/unit/bot_crud.test.ts
    - playwright.config.ts
decisions:
  - "BOTS_RUNS handler validates bot via listBotsFromDisk (cheap main-side read) before reading <runsDir>/<bot>.jsonl — returns {ok:false, error:'unknown_bot'} on miss"
  - "listRuns asks for limit+1 rows so hasMore is computed without a second read; main-side slices down to limit"
  - "BotSettingsPage URL hash sync uses window.history.replaceState on tab change + popstate listener for back/forward; refresh preserves the open tab (Pitfall 4)"
  - "Per-tab submit-on-blur debounced 250ms (T-P4-25) before calling bots:update; save indicator shows Saving/Saved/Error then auto-clears after 1.5s"
  - "RunHistoryTable uses plain overflow:auto + <table> — no react-arborist, no react-window per the plan's 'no new packages' prohibition"
  - "useRunHistory hook: module-scope Map<bot, Cache>; subscribes to EVENT_BOT_STATUS for push refresh; 5s polling fallback (skipped when opts.polling===false)"
  - "App-level view toggle driven by URL hash ('chat' | 'settings'); openSettings(botId)/closeSettings() handlers; renders BotSettingsPage when view==='settings'"
  - "BotSidebar settings icon now calls onOpenSettings(botId) — SettingsEditModal is no longer mounted (the component is kept for reuse but BotSidebar.tsx dropped the import)"
  - "Audit minimization (T-P4-22/23/24): bots/create → {id, name}; bots/trigger → {runId, trigger, messageCount} (no bot, no error.message); bots/cancel → {runId}; bots/update stays {changedKeys}"
  - "Playwright bot-crud + multi-bot tests run in daemon-smoke project (headless, no Electron window) so CI can prove the architecture without a display; headed gating via LOCALBOT_SMOKE_OK=1"
  - "streamBotTrigger({bot, port, abortSignal}) is a standalone helper (no shared server) that emits Anthropic SSE chunks + a ' [cancelled]' marker on abort so the SDK abort path runs cleanly"
  - "multi-bot cancel isolation test fires trigger A fire-and-forget, waits 150ms for activeRuns registration, then issues cancel — proves the per-runId controller map is keyed correctly"
metrics:
  duration: ~25 min
  completed_date: 2026-09-18
  tasks: 3
  commits: 3
status: complete
plan_head_before: 552f2fbc6dc16c0491679690e121d9288dd871c9
actuals:
  tokens: 56000
  tasks: 3
  commits: 3
---

# Phase 4 Plan 3: Settings Page + Run History Table + Audit Minimization + Playwright Smokes

## One-liner

Closed the Phase 4 read surface: BOTS_RUNS IPC + paginated run history + BotSettingsPage (4 tabs with URL hash sync) + RunHistoryTable (scroll-to-bottom pagination, color-coded exitReason) + audit minimization across all 5 bots/* ops + Playwright bot-crud + multi-bot smokes that prove cancel isolation in daemon-smoke mode.

## Completed Tasks

| Task | Commit | Subject |
|------|--------|---------|
| 1 | `323178f` | feat(04-03): BOTS_RUNS IPC + paginated listRuns + audit minimization |
| 2 | `1ac1e8a` | feat(04-03): BotSettingsPage + RunHistoryTable + state/runs + App view toggle |
| 3 | `62ee907` | test(04-03): bot-crud + multi-bot Playwright smokes + fake-m3 streamBotTrigger |

## What Changed

### Main / shared side (Task 1)

- **`src/main/runs/jsonl.ts`** + **`daemon/runs/jsonl.cjs`** — `listRuns(bot, limit?, offset?)` accepts an offset parameter; iterates from the tail of the JSONL, skips `offset` rows, collects up to `limit`. Back-compat: callers that pass only `(bot, limit)` still work (offset defaults to 0).
- **`src/main/bots/runs.ts`** — `listRunRecords(bot, {limit?, offset?})` wrapper forwarding to `listRuns`.
- **`src/shared/types.ts`** — appends `BotRunsRequest` and `BotRunsResult {ok, runs, hasMore, error?}`.
- **`src/shared/ipc-channels.ts`** — appends `BOTS_RUNS: 'bots:runs'`.
- **`src/shared/window.d.ts`** — adds `BotRunsRequest`/`BotRunsResult` imports, `LocalbotChannel` union entry for `'bots:runs'`, and `LocalbotApi.bot.runs`.
- **`src/main/preload/index.ts`** — exposes `api.bot.runs(req)` to the renderer.
- **`src/main/ipc/bots.ts`** — registers the `BOTS_RUNS` handler:
  - Validates the bot via `listBotsFromDisk` (returns `{ok:false, error:'unknown_bot'}` on miss).
  - Calls `listRunRecords(req.bot, {limit: req.limit ?? 50, offset: req.offset ?? 0})` with `limit + 1` so `hasMore` is computed without a second read.
  - Returns `{ok:true, runs, hasMore}` (trims to `limit` when `hasMore===true`).
- **`daemon/main.cjs`** — audit minimization patches (Pitfall 10):
  - `bots/create` params → `{id, name}` (was `{name, personaBytes}` — drops persona bytes, workspace path, allowlist contents).
  - `bots/trigger` params → `{runId, trigger, messageCount}` (was `{bot, runId, trigger, messageCount}` — drops bot, drops error.message text).
  - `bots/cancel` params → `{runId}` (was `{bot, runId}` — drops bot).
  - `bots/update` params unchanged (`{changedKeys: Object.keys(patch).sort()}`).
  - `bots/list` + `bots/delete` unchanged (already minimal).

### Renderer side (Task 2)

- **`src/renderer/state/runs.ts` (NEW)** — module-scope `Map<bot, RunHistoryCacheInternal>` with an `epoch` counter for stale-fetch rejection. `useRunHistory(bot, opts)` returns `{runs, loading, hasMore, error, loadMore, refresh}`. Subscribes to `bot:status` events for the same bot and triggers a refresh; 5s polling fallback (skipped when `opts.polling===false`).
- **`src/renderer/components/RunHistoryTable.tsx` (NEW)** — `<table>` inside `overflow:auto` container. Columns: `When` (relative time), `Trigger` (badge), `Duration`, `Outcome` (color-coded badge), `Error` (truncated to 60 chars + click to expand). Scroll-to-bottom pagination: when `scrollHeight - (scrollTop + clientHeight) <= 100`, calls `loadMore()`. Loading placeholder rows + empty state + error state with retry button.
- **`src/renderer/components/BotSettingsPage.tsx` (NEW)** — 4 tabs (`General`, `Permissions`, `Schedule`, `Run History`) with `<button role="tab" aria-selected={...}>` + `<section role="tabpanel">`. URL hash sync via `window.history.replaceState` on tab change + `popstate` listener for back/forward. Per-tab submit-on-blur with 250ms debounce calls `bots:update` with the per-tab patch. Save indicator at top (`Saving…` → `Saved` → auto-clear after 1.5s). `Esc` closes; X button closes.
- **`src/renderer/App.tsx`** — view toggle `view: 'chat' | 'settings'` + `settingsBotId: string | null`. URL hash sync: `#/bot/<id>/settings[/<tab>]` opens the page; `''` or `'#/'` returns to chat. `openSettings(botId)` / `closeSettings()` callbacks.
- **`src/renderer/components/Chat.tsx`** — accepts `onOpenSettings` prop, passes through to `<BotSidebar>`.
- **`src/renderer/components/BotSidebar.tsx`** — accepts `onOpenSettings` prop; the settings icon on each `SidebarBotRow` calls `onOpenSettings(bot.id)`. `SettingsEditModal` is no longer mounted (the component is kept for reuse but the import was removed from this file).
- **`src/renderer/styles/app.css`** — adds `.bot-settings-page`, `.bot-settings-tabs`, `.bot-settings-tab[data-active='true']`, `.bot-settings-status[data-status='*']`, `.run-history-table`, `.run-history-row[data-exitreason='*']`, `.run-history-exitreason-badge[data-exitreason='*']`, `.run-history-trigger-badge`, `.run-history-error`, `.run-history-loadmore`, `.run-history-empty`, `.run-history-error-state`, `.run-history-row-placeholder`.

### Tests (Task 1 + Task 3)

- **`tests/unit/bot_runs.test.ts`** — added a `supports offset parameter` test: writes 5 rows oldest-first, asserts `listRuns(dir, 'off', 2, 1)` returns `[r3, r2]`, `listRuns(dir, 'off', 2, 2)` returns `[r2, r1]`, and `listRuns(dir, 'off', 2, 100)` returns `[]`.
- **`tests/unit/bot_crud.test.ts`** — added 4 audit minimization tests under `bots/* audit minimization (T-P4-22/23)`:
  - `bots/update audit params minimize to {changedKeys} only` (spawns daemon, asserts `changedKeys.sort() === ['allowlist', 'persona']` and that `params.persona`, `params.workspace`, `params.patch` are undefined).
  - `bots/trigger audit params minimize to {runId, trigger, messageCount}` (asserts `params.bot`, `params.content`, `params.error` are undefined).
  - `bots/cancel audit params minimize to {runId}` (asserts `Object.keys(params).sort() === ['runId']`).
  - `bots/create audit params minimize to {id, name}` (asserts `params.id` + `params.name` only).
- **`tests/playwright/fake-m3-server.ts`** — added `streamBotTrigger({bot, port, abortSignal, tokenDelayMs?})` helper:
  - Listens on `127.0.0.1:port`; answers `POST /v1/messages` with Anthropic SSE chunks (`message_start`, `content_block_delta x N`, `content_block_stop`, `message_stop`).
  - On `abortSignal.abort`, emits a `' [cancelled]'` text delta + closes the response so the SDK abort path runs cleanly and the daemon writes `exitReason:'cancelled'`.
  - Logs only `{event, delta}` chunks to stdout (T-P4-30 minimization).
- **`tests/playwright/bot-crud.test.ts` (NEW)** — daemon-smoke vertical:
  - Spawns the real daemon via `process.execPath` against `daemon/main.cjs` with a fake M3 server on a free port.
  - `initialize → bots/create → bots/list (assert id present) → bots/trigger → wait for run JSONL write → bots/update → assert audit minimization → bots/delete → bots/list (assert id removed)`.
- **`tests/playwright/multi-bot.test.ts` (NEW)** — daemon-smoke cancel isolation:
  - Two bots A (allowlist `['read_file']`) and B (allowlist full set) on two separate fake servers.
  - Fires `bots/trigger` for A (fire-and-forget), waits 150ms for `activeRuns` registration, issues `bots/cancel {runId:'run-a'}` (must return `ok:true`), then awaits trigger A which now resolves with `exitReason:'cancelled'`.
  - Triggers B independently and asserts it resolves with `exitReason:'completed'` + `messageCount > 0`.
  - Reads `<userData>/runs/<bot>/bot.jsonl` to verify each bot has exactly one record with the expected `exitReason`.
  - Asserts `bots/cancel` audit params reduce to `{runId}` only.
- **`playwright.config.ts`** — adds a `daemon-smoke` project (headless default; no Electron window). `LOCALBOT_SMOKE_OK=1` flips `headless:false` for desktop runs.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated `daemon/runs/jsonl.cjs` signature to accept offset**
- **Found during:** Task 1 verification (`vitest run bot_runs.test.ts` failed the new offset test).
- **Issue:** The plan added offset support to `src/main/runs/jsonl.ts` but the daemon's `daemon/runs/jsonl.cjs` (the file the unit tests actually exercise via `createRequire`) still had the old 2-arg `listRuns(userDataDir, bot, limit)` signature.
- **Fix:** Updated `daemon/runs/jsonl.cjs` to match the new `(userDataDir, bot, limit, offset)` signature with the same skip-then-collect logic. The unit test now passes (8/8 in `bot_runs.test.ts`).
- **Files modified:** `daemon/runs/jsonl.cjs`.
- **Commit:** `323178f`.

**2. [Rule 1 - Bug] Fixed multi-bot cancel race: trigger returned before cancel could find the runId in activeRuns**
- **Found during:** Task 3 first run (`playwright test --project daemon-smoke --grep "multi-bot"`).
- **Issue:** The test originally awaited `bots/trigger` (which resolves AFTER `runSendMessageCycle` completes — i.e. after the RunRecord append + status patch + `activeRuns.delete(runId)`). By the time the test issued `bots/cancel {runId:'run-a'}` 100ms later, the run was already gone from `activeRuns` and the cancel RPC returned `{error:'no_such_run'}`.
- **Fix:** Restructured the test to fire `bots/trigger` fire-and-forget, wait 150ms for the controller to register, then issue cancel — and only THEN await the trigger result (which now resolves with `exitReason:'cancelled'` because the abort signal fired mid-stream). Also bumped `streamBotTrigger`'s per-token delay to 100ms so the run is still active when cancel lands.
- **Files modified:** `tests/playwright/multi-bot.test.ts`.
- **Commit:** `62ee907`.

### Plan-exact (no deviations)

All other elements were implemented as specified. No architectural changes; no `Rule 4` checkpoints raised. The SettingsEditModal component is intentionally kept in `src/renderer/components/` for reuse but no longer mounted by `BotSidebar.tsx` — exactly per the plan's "SettingsEditModal ... kept for reuse but no longer mounted" instruction.

## Verification

- `npm run build` exits 0 with zero TS errors. New files emitted:
  - `dist/renderer/components/BotSettingsPage.js`
  - `dist/renderer/components/RunHistoryTable.js`
  - `dist/renderer/state/runs.js`
  - `dist/main/runs/jsonl.js` (refreshed)
  - `dist/main/bots/runs.js` (refreshed)
  - `dist/main/ipc/bots.js` (extended)
  - `dist/tests/playwright/bot-crud.js`
  - `dist/tests/playwright/multi-bot.js`
  - `dist/tests/playwright/fake-m3-server.js` (extended)
- `npm test`: **203 passed / 1 skipped / 0 failed** (25 test files).
  - `tests/unit/bot_runs.test.ts` — 8 tests (extended with the offset test).
  - `tests/unit/bot_crud.test.ts` — 17 tests (extended with 4 audit minimization tests; each spawns the daemon subprocess and reads `<userData>/audit/*.jsonl`).
  - All Phase 1+2+3 suites still green.
- `npx playwright test --config playwright.config.ts --project daemon-smoke --grep "bot CRUD"` → **1 passed (1.8s)**.
- `npx playwright test --config playwright.config.ts --project daemon-smoke --grep "multi-bot"` → **1 passed (1.8s)**.
- `npx playwright test --config playwright.config.ts --list` shows both new tests under the `daemon-smoke` project, alongside the existing 11 Phase 1+2+3 tests.
- `grep -RE "BOTS_RUNS\|bot.runs\|listRunRecords"` confirms all 4 main/shared files carry the new symbols.
- `grep -RE "changedKeys\|runId, trigger, messageCount\|runId"` confirms `daemon/main.cjs` audit params are minimized.

## Threat Coverage

| Threat ID | Mitigation landed | Test coverage |
|-----------|-------------------|---------------|
| T-P4-22 (audit persona leak) | `bots/create` params `{id, name}` only; `bots/update` params `{changedKeys}` only | `bot_crud.test.ts` (4 spawn-daemon tests assert params shape) |
| T-P4-23 (audit error text) | `bots/trigger` params `{runId, trigger, messageCount}` (no error.message); `bots/cancel` params `{runId}` only | `bot_crud.test.ts` + `multi-bot.test.ts` |
| T-P4-24 (error column disclosure) | `RunHistoryTable` truncates `error.message` to 60 chars; click-to-expand keeps the full text renderer-only | `RunHistoryTable.tsx` code path |
| T-P4-25 (debounced autosave rate limit) | `BotSettingsPage` submit-on-blur is debounced 250ms; one `bots:update` fires per blur cycle | `BotSettingsPage.tsx` debounce timer |
| T-P4-26 (hash injection) | `parseTabFromHash` whitelists the 4 known tab names; unknown tab → General | `BotSettingsPage.tsx` `TAB_IDS` array |
| T-P4-27 (pagination infinite loop) | `loadMore` short-circuits when `!hasMore`; `hasMore=false` when the page returned < limit rows | `useRunHistory` `hasMore` flag |
| T-P4-28 (test pollution) | Each test uses `fs.mkdtempSync(path.join(os.tmpdir(), ...))` + `finally { fs.rmSync(...) }` | `bot-crud.test.ts` + `multi-bot.test.ts` |
| T-P4-29 (real Anthropic call) | Tests set `M3_API_BASE=<fake-server-url>` + `ANTHROPIC_API_KEY=fake-test-key`; `streamBotTrigger` emits canned chunks only | `bot-crud.test.ts` env block |
| T-P4-30 (prompt logging) | `streamBotTrigger` logs only `{event, delta}` chunks — never the parsed `messages` payload | `fake-m3-server.ts` `console.log` calls |
| T-P4-SC (npm install) | No new npm packages added; RESEARCH.md `## Package Legitimacy Audit` confirmed pre-plan | `package.json` diff = empty |

## Notes for Next Plan

- **Phase 5 (AGENT-09/10 — scheduled runs)** will own the cron parser + scheduler that Phase 4's `cron` + `cronEnabled` fields reserve.
- **Phase 6** owns `bots/roots` (chokidar re-rooting on workspace change) per the Wave 2 SUMMARY's "Notes for Next Plan" section.
- The pre-existing test skip (`safeStorage.real.test.ts`) is environment-dependent and not in scope.
- The `streamBotTrigger` helper could be reused by Phase 5's scheduler tests if they need to drive a manual trigger round-trip.
- `useRunHistory` is now the canonical surface for run-history reads in the renderer; any future Phase 5+ run-history feature (filtering, search, export) should extend this hook rather than introducing a parallel one.
