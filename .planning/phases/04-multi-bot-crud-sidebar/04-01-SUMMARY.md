---
phase: 04-multi-bot-crud-sidebar
plan: 01
type: execute
wave: 1
subsystem: bot-metadata
tags: [phase-04, bot-crud, sidebar, modals, json-rpc, ipc, allowlist, threat-model]
dependency_graph:
  requires: [phase-01-skeleton, phase-02-tools, phase-03-memory-history]
  provides: [bots-list, bots-create, bots-delete, bot-sidebar, per-bot-allowlist]
  affects: [daemon, main, renderer]
tech-stack:
  added: []
  patterns: [module-scope-store, ipc-preload-namespace, app:init-hydration, atomic-tmp-rename]
key-files:
  created:
    - daemon/bots/loader.cjs
    - daemon/bots/policy.cjs
    - src/main/bots/paths.ts
    - src/main/bots/config.ts
    - src/main/ipc/bots.ts
    - src/renderer/state/bots.ts
    - src/renderer/components/AppModal.tsx
    - src/renderer/components/BotSidebar.tsx
    - src/renderer/components/SidebarBotRow.tsx
    - src/renderer/components/NewBotModal.tsx
    - src/renderer/components/DeleteConfirmModal.tsx
    - tests/unit/bot_config.test.ts
    - tests/unit/bot_crud.test.ts
    - tests/unit/bot_policy.test.ts
  modified:
    - daemon/main.cjs
    - daemon/tools/registry.cjs
    - src/shared/ipc-channels.ts
    - src/shared/types.ts
    - src/shared/window.d.ts
    - src/main/daemon/spawn.ts
    - src/main/window.ts
    - src/main/index.ts
    - src/main/preload/index.ts
    - src/main/audit/logger.ts
    - src/renderer/App.tsx
    - src/renderer/components/Chat.tsx
    - src/renderer/styles/app.css
decisions:
  - "Per-bot policy is read on every tools/call (no caching) to avoid stale allowlist after bots/update (Pitfall 1 in RESEARCH.md)"
  - "Bot id is auto-derived from name via deriveSlug in the daemon; renderer does not expose id editing (per AGENT-01 contract)"
  - "Main side does NOT write bot config files directly — all mutations route through daemon bots/{create,delete} JSON-RPC methods (trust boundary)"
  - "Audit minimization on bots.create: only {name, personaBytes} lands in JSONL params, never workspace or persona content (T-P4-10)"
  - "Implicit 'default' bot is synthesized in listAllBots/listBotsFromDisk when no bots dir exists — preserves Phase 3 back-compat"
  - "bots/delete refuses id='default' with code:'protected_bot' (T-P4-05) so Phase 3 data survives"
  - "Renderer BotSidebar is the new 260 px left rail; Phase 3 WorkspaceTree is unmounted in this plan (Wave 3 re-homes it to BotSettingsPage)"
  - "EVENT_BOT_LIST_UPDATED broadcasts on create/delete so the sidebar refreshes without polling (T-P4-08)"
  - "DeleteConfirmModal requires typed.trim() === bot.name.trim() — whitespace-padded matches rejected (T-P4-09)"
  - "AppModal uses additive focus trap — does not block Escape (T-P4-11)"
metrics:
  duration: ~50 min
  completed_date: 2026-09-18
  tasks: 3
  commits: 3
status: complete
plan_head_before: a47a274
actuals:
  tokens: 88000
  tasks: 3
  commits: 3
---

# Phase 4 Plan 1: Tracer slice — bot metadata CRUD + per-bot policy + BotSidebar + modals

## One-liner

Per-bot metadata CRUD end-to-end: daemon JSON-RPC `bots/{list,create,delete}` with atomic config.json writes + per-bot allowlist loader replacing Phase 3's hardcoded DEFAULT_POLICY, main IPC bridge with EVENT_BOT_LIST_UPDATED broadcasts, renderer 260 px BotSidebar + NewBotModal + DeleteConfirmModal + AppModal primitive.

## Completed Tasks

| Task | Commit | Subject |
|------|--------|---------|
| 1 | `3e59d78` | feat(04-01): daemon bots/loader + bots/policy + JSON-RPC bots/list\|create\|delete |
| 2 | `3c2fc18` | feat(04-01): main bot IPC + bot paths/config + spawn.callBot + bot preload namespace |
| 3 | `574ad57` | feat(04-01): renderer bot sidebar + modals + state store + app:init wiring |

## What Changed

### Daemon side (Task 1)

- **`daemon/bots/loader.cjs`** — atomic `config.json` read/write/delete with schema allowlist `ALLOWED_CONFIG_KEYS = {id, name, persona, workspace, allowlist, cron, cronEnabled, createdAt, updatedAt, status, lastRunAt, lastRunExitReason, lastRunError, schemaVersion}`. `writeConfig` does `fs.writeFileSync(tmp); fs.renameSync(tmp, real)`; rejects unknown keys with `code:'invalid_config'`, bad id format with `code:'invalid_id'`, schemaVersion !== 1. `deriveSlug(name)` lowercases, replaces non-`[a-z0-9-]` with `-`, collapses dashes, truncates to 32 chars. `listAllBots` synthesizes the implicit `default` bot when `<userData>/bots/` is missing.
- **`daemon/bots/policy.cjs`** — `getPolicy(botId, ctx)` reads `<userData>/bots/<id>/config.json#allowlist` on every call (NO caching — T-P4-03). Falls back to `DEFAULT_POLICY` for `_system` and for the implicit `default` bot. Throws `{code:'unknown_bot'}` for any other bot without a config.json.
- **`daemon/main.cjs`** — 3 new JSON-RPC methods: `bots/list`, `bots/create`, `bots/delete`. Each writes one audit line via the existing `audit.appendAudit(...)` with the canonical Phase 2/3 shape. `bots/create` seeds `<botDir>/memory.md` + `<botDir>/facts.json` stubs. `bots/delete` refuses `id='default'` with `code:'protected_bot'` and best-effort removes `<userData>/sessions/<id>/`. Audit minimization on `bots.create`: only `{name, personaBytes}` lands in JSONL params (T-P4-10).
- **`daemon/tools/registry.cjs`** — `getPolicy` now delegates to `bots/policy.cjs#getPolicy(botId, ctx)`; `callTool` threads `ctx` through so the policy loader can read `ctx.userDataDir`.

### Main side (Task 2)

- **`src/main/bots/paths.ts`** — `configPath(bot)`, `runsDir(bot)`, `runsFilePath(bot, runId)`, `ensureRunsDir(bot)` for Wave 2's run ledger.
- **`src/main/bots/config.ts`** — `listBotsFromDisk()` (best-effort hydration for first paint), `loadConfigFromDisk(bot)`, `saveConfigToDisk(cfg)`, `deleteBotFromDisk(bot)`. Synthesizes the implicit `default` bot when no bots dir exists.
- **`src/main/ipc/bots.ts`** — registers `CHANNELS.BOTS_LIST`, `BOTS_CREATE`, `BOTS_DELETE` handlers. Calls daemon via `callBot(method, args)`. Broadcasts `EVENT_BOT_LIST_UPDATED` on every successful mutation. Defensive defaults: never throws to renderer; returns `{ok:false, error}` on failure.
- **`src/main/daemon/spawn.ts`** — `callBot(method, args)` mirrors `callMemory`/`callTree` envelope (audit shape + pending map + NDJSON framing).
- **`src/main/window.ts`** — `sendAppInit` ships `bots: BotConfig[]` with first paint so the sidebar hydrates synchronously without an extra IPC roundtrip.
- **`src/main/preload/index.ts`** — exposes `window.localbot.bot.{list, create, delete}`; adds 2 new event channels (`EVENT_BOT_LIST_UPDATED`, `EVENT_BOT_STATUS`) to the `EVENT_CHANNELS` set; adds generic `invoke()` proxy.
- **`src/shared/{types,ipc-channels,window.d}.ts`** — `BotStatus` enum, `BotConfig` interface, 5 request/result/event types, 5 new channel constants, `LocalbotChannel` union + `LocalbotEventPayload` union + `LocalbotApi.bot` namespace.

### Renderer side (Task 3)

- **`src/renderer/state/bots.ts`** — module-scope store `{bots, activeBotId, loading, error}` + `Subscribers` Set. `useBots()` returns snapshot + `refresh()`; `useActiveBotId()` returns snapshot + `setActiveBotId()`; `seedBots(initial)` synchronously hydrates from `app:init.bots`. `EVENT_BOT_LIST_UPDATED` subscription wired exactly once via module-scope `mountedCount` (T-P4-08).
- **`src/renderer/components/AppModal.tsx`** — generic modal primitive with Escape close, backdrop click close, additive focus trap (cycle Tab inside, do not block Escape — T-P4-11). Title + close button + body. `zIndex` + `cardClassName` props for per-modal styling.
- **`src/renderer/components/BotSidebar.tsx`** — 260 px left rail; header with `+` button (opens NewBotModal); renders one `SidebarBotRow` per bot; row's delete icon opens DeleteConfirmModal.
- **`src/renderer/components/SidebarBotRow.tsx`** — status dot (`data-status` attribute) + name + last-run text ("never" / "Xs/m/h/d ago") + settings/delete buttons. Settings is a no-op reserved for Wave 3.
- **`src/renderer/components/NewBotModal.tsx`** — AGENT-01 form: name (required, max 64), persona (textarea, max 4096), workspace, allowlist checkboxes (default = Phase 3 DEFAULT_POLICY), cron string, cronEnabled. Submits via `window.localbot.bot.create`; on success calls `onCreated` + `onClose`; on error shows inline message.
- **`src/renderer/components/DeleteConfirmModal.tsx`** — AGENT-02 typed-name confirmation: submit disabled until `typed.trim() === bot.name.trim()` (T-P4-09). Destructive red button at zIndex=1100 (stacks above NewBotModal).
- **`src/renderer/components/Chat.tsx`** — replaces `<WorkspaceTree>` with `<BotSidebar initialBots={initialBots} />`. WorkspaceTree is unmounted in this plan (Wave 3 re-homes to BotSettingsPage).
- **`src/renderer/App.tsx`** — stores `payload.bots` in `initialBots` state slice; reserves `view: 'chat' | 'settings'` for Wave 3's settings page.
- **`src/renderer/styles/app.css`** — `--lb-status-{idle,running,errored,scheduled}` tokens; `@keyframes lb-pulse` for the running-status dot; `.bot-sidebar`, `.bot-row`, `.bot-row-status[data-status=...]`, `.modal-backdrop`, `.modal-card`, `.destructive` styles.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing security] added `botsDir()` first-write containment to safePath**
- **Found during:** Task 1 (tests/unit/bot_config.test.ts)
- **Issue:** Initial `safePath(botDir, 'config.json')` call failed when `botDir` didn't exist because `realpathSync` on a non-existent path throws ENOENT.
- **Fix:** Added `fs.mkdirSync(botDir, { recursive: true })` before the realpath check in `writeConfig`.
- **Files modified:** `daemon/bots/loader.cjs`
- **Commit:** `3e59d78`

**2. [Rule 2 - Back-compat] `policy.cjs` falls back to DEFAULT_POLICY for 'default' without userDataDir**
- **Found during:** Task 1 (Phase 3 allowlist tests failed after registry.cjs was extended)
- **Issue:** `getPolicy` was too strict — required `userDataDir` even for the implicit `default` bot, which broke Phase 1+2+3 test fixtures that hardcoded the default policy.
- **Fix:** When `botId === 'default'` and no `userDataDir`, fall back to `DEFAULT_POLICY` (preserves Phase 3 test back-compat). Other bot ids still throw `{code:'daemon_not_initialized'}`.
- **Files modified:** `daemon/bots/policy.cjs`
- **Commit:** `3e59d78`

**3. [Rule 2 - Render hygiene] BotSidebar seeds store synchronously via `seedBots()`**
- **Found during:** Task 3 (renderer build verification)
- **Issue:** The plan said App.tsx passes `bots` to Chat which passes to BotSidebar, but `BotSidebar` uses `useBots()` which is a module-scope store. A synchronous seed path was needed for the first paint.
- **Fix:** Added `seedBots(initialBots)` export to `state/bots.ts`; `BotSidebar` calls it in its mount effect (idempotent — only seeds when the store is empty so a late `refresh()` result wins).
- **Files modified:** `src/renderer/state/bots.ts`, `src/renderer/components/BotSidebar.tsx`
- **Commit:** `574ad57`

### Plan-exact (no deviations)

All other elements were implemented as specified. No architectural changes; no `Rule 4` checkpoints raised.

## Verification

- `npm run build` exits 0 with zero TS errors; all new files compiled to `dist/main/` + `dist/renderer/`.
- `npm test`: 169 passed / 1 skipped / 1 pre-existing failure (window.test.ts — verified unrelated to this plan via `git stash`).
- All 3 new bot test suites pass:
  - `tests/unit/bot_config.test.ts` — 19 tests (loader atomicity, schema, slug derivation, default synthesis)
  - `tests/unit/bot_crud.test.ts` — 7 tests (create + list + delete lifecycle, bot_exists duplicate, default protected)
  - `tests/unit/bot_policy.test.ts` — 9 tests (per-bot allowlist, DEFAULT_POLICY fallback, no-cache Pitfall 1)
- `dist/main/bots/{config,paths}.js`, `dist/main/ipc/bots.js`, `dist/main/daemon/spawn.js`, `dist/renderer/state/bots.js`, `dist/renderer/components/{BotSidebar,SidebarBotRow,NewBotModal,DeleteConfirmModal,AppModal}.js` all emitted.
- `grep -RE "EVENT_BOT_LIST_UPDATED|EVENT_BOT_STATUS" src/main/preload/index.ts` shows both events registered.
- `grep -RE "api.bot" src/main/preload/index.ts` confirms the bot namespace is exposed.

## Threat Coverage

| Threat ID | Mitigation landed | Test coverage |
|-----------|-------------------|---------------|
| T-P4-01 (path traversal) | id regex `/^[a-z0-9][a-z0-9-]{0,31}$/` + safePath containment | `bot_config.test.ts` (invalid id rejection) |
| T-P4-02 (allowlist bypass) | `policy.cjs` throws `{code:'unknown_bot'}` for bots without config.json (except `default`) | `bot_policy.test.ts` |
| T-P4-03 (stale allowlist cache) | `getPolicy` re-reads config.json on every call (no module-scope cache) | `bot_policy.test.ts` (Pitfall 1) |
| T-P4-04 (audit gaps) | Every bots/* op writes one audit line via `audit.appendAudit(...)` | Daemon code-path covered |
| T-P4-05 (delete default bot) | `bots/delete` refuses `id='default'` with `{code:'protected_bot'}` | `bot_crud.test.ts` |
| T-P4-06 (concurrent write race) | Atomic `tmp + rename` in `writeConfig` | `bot_config.test.ts` (rename failure leaves original intact) |
| T-P4-07 (unknown config keys) | `readConfig` throws `{code:'invalid_config'}` for keys outside `ALLOWED_CONFIG_KEYS` | `bot_config.test.ts` |
| T-P4-08 (re-fetch flood) | Renderer subscribes to `EVENT_BOT_LIST_UPDATED` once via module-scope `mountedCount` | Renderer code-path |
| T-P4-09 (whitespace-padded match) | `DeleteConfirmModal` uses `typed.trim() === bot.name.trim()` | Renderer code-path |
| T-P4-10 (audit info disclosure) | `bots.create` audit params carry only `{name, personaBytes}` — no persona/workspace content | Daemon code-path |
| T-P4-11 (modal Escape race) | `AppModal` Escape handler is independent of the focus trap | Renderer code-path |

## Notes for Next Plan

- **Wave 2 (04-02) will add**: `bots/update`, `bots/trigger`, `bots/cancel` JSON-RPC methods; `RunRecord` append/lookup; `EVENT_BOT_STATUS` emission on run state transitions; the settings page (`BotSettingsPage`) re-homes `WorkspaceTree`.
- **No npm packages were installed** — the security control in `T-P4-SC` ("no new attack surface") was honored; all Phase 4 work used already-installed deps.
- The 1 pre-existing test failure (`tests/unit/window.test.ts`) is unrelated to this plan — verified via `git stash` to reproduce on commit `a47a274` (pre-Phase-4 HEAD). Left as-is per scope boundary.
