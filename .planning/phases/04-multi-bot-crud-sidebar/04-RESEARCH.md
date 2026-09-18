# Phase 4: Multi-Bot CRUD + Sidebar — Research

**Researched:** 2026-09-18
**Domain:** Per-bot metadata CRUD + sidebar render surface + per-bot settings page + run history table + manual trigger / cancel of any bot
**Confidence:** HIGH (Phase 1+2+3 patterns read this session; IPC channel registry read; daemon main.cjs, registry.cjs, paths.ts read; renderer Chat.tsx, WorkspaceTree.tsx, state/memory.ts, state/sessions.ts, state/tree.ts read; package.json deps verified)

---

## Summary

Phase 4 turns the hard-coded `default` bot (Phase 3's tracer slice) into a dynamic, multi-bot system. The bot metadata that today lives implicitly in `<userData>/bots/<bot>/` (memory.md, facts.json, JSONL sessions) becomes addressable by an explicit `BotConfig` record — `{id, name, persona, workspace, allowlist, cron?, status, lastRunAt}` — persisted at `<userData>/bots/<bot>/config.json` and reloaded at app start. The daemons' `getPolicy()` switches from a hardcoded `DEFAULT_POLICY` to a per-bot loader that reads the bot's allowlist from `config.json` (or returns the default for the implicit `default` bot so Phase 3 data survives). New daemon JSON-RPC methods `bots/list`, `bots/create`, `bots/update`, `bots/delete`, `bots/trigger`, `bots/cancel`, `bots/runs` cover the full CRUD + run lifecycle without disturbing the existing IPC envelope.

The sidebar replaces Phase 3's left-rail `WorkspaceTree` (which moves to a per-bot settings page in Phase 4) and lists every bot with a status indicator (idle / running / errored / scheduled) + last-run timestamp. Per-bot settings adds an editable form for persona, workspace, allowlist, and (optionally) cron. A run history table persists per-bot runs as `<userData>/runs/<bot>.jsonl` (append-only NDJSON, one row per run: `{ts, durationMs, exitReason, error?, trigger}`). Manual trigger and cancel use the existing `sendMessage` / `cancel` IPC handlers + a per-bot run-id AbortController map.

**Primary recommendation:** Keep the three-tier architecture intact. Persist bot metadata as plain JSON files under `<userData>/bots/<bot>/config.json` (matching Phase 3's "bots are files" model). Add `bots/*` daemon JSON-RPC methods behind the existing NDJSON transport. Render the sidebar in the renderer via a new `BotSidebar` component that owns the active `botId`. Move `WorkspaceTree` from the chat shell to the per-bot settings page so the sidebar has room. Reuse the existing `sendMessage` / `cancel` IPC for manual trigger/cancel by routing through a per-bot run-id AbortController map (no new IPC channels for trigger/cancel — only the bot metadata + run history need new channels).

---

## User Constraints

> No `04-CONTEXT.md` exists for this phase. Decisions below are derived from `.planning/PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, the locked decisions in Phase 1 (`01-SKELETON.md`/`01-CONTEXT.md`), Phase 2 patterns (`02-RESEARCH.md`), and Phase 3 patterns (`03-RESEARCH.md` + the 03-PLAN.md / 03-UI-SPEC.md executed in this session). Phase 4 is **additive** on Phase 3 — it does not reopen locked decisions from prior phases.

### Locked Decisions (inherited from Phase 1; not reopenable in Phase 4)

- **D-07 (one-way):** IPC contract `sendMessage`/`cancel` + `message:token`/`message:done`/`message:error` is the surface Phase 4 builds on. New event channels (`bot:status`, `bot:run`, `bot:list:updated`) extend it; **no renames**.
- **D-10/D-11 (one-way):** Daemon transport = JSON-RPC 2.0 over NDJSON, max line 1 MiB. `tools/call` already supports tool dispatch; Phase 4 adds `bots/list`, `bots/create`, `bots/update`, `bots/delete`, `bots/trigger`, `bots/cancel`, `bots/runs` as new JSON-RPC methods (mirroring Phase 3's `memory/read`, `memory/write`, `tree/list` pattern).
- **D-12:** Audit log line shape `{ts, bot, tool, params, outcome, durationMs, error?}` is the SEC-04 contract; bot CRUD + run ops log as `{tool: 'bots.list'|'bots.update'|'bots.delete'|'bots.trigger'|'bots.cancel'|'bots.run', bot: <botId>, params, outcome, durationMs, error?}`.
- **D-13/D-14 (costly):** Session JSONL lives at `<userData>/sessions/<bot>/<sessionId>.jsonl` (Phase 3). Phase 4 keeps the layout — adding a bot is just a new subdirectory.
- **D-17/D-18 (costly):** In-flight cancel uses `ipcRenderer.invoke('cancel', msgId)` + main's `Map<msgId, AbortController>` + daemon `tools/cancel` JSON-RPC. Phase 4 adds a parallel `Map<runId, AbortController>` keyed by run-id (one run = one or more sendMessage cycles until the bot's turn ends) so multi-message manual triggers can be cancelled atomically.
- **D-22:** Network/5xx auto-retry ≤3 with exp backoff wraps the SDK call only. Run history uses the same retry path; the run-history writer is NOT retried (a missing run row is acceptable).
- **D-26 (Phase 3):** Bot metadata directory `<userData>/bots/<bot>/` already exists; memory.md + facts.json live there. Phase 4 adds `config.json` to the same directory.
- **SKELETON.md row "Phase 4":** "Add `<userData>/bots/<bot>/config.json` + bot allowlist loader; replace hard-coded default bot in main; expose bots/list/create/update/delete JSON-RPC methods; add sidebar UI with status + last-run; add per-bot settings page."

### Locked Decisions (inherited from Phase 3; not reopenable in Phase 4)

- **P3-D-01:** `<userData>/bots/<bot>/{memory.md, facts.json, config.json}` — three files per bot, all in the same directory.
- **P3-D-02:** Per-bot per-session JSONL routing `<userData>/sessions/<bot>/<sessionId>.jsonl`; migration from `global.jsonl` already done.
- **P3-D-03:** Tree watcher rootPaths are per-bot: `[<userData>/workspace/<bot>/, <userData>/bots/<bot>/]`. Phase 4 dynamic-bots means main must update treeRoots on bot list changes (re-issue `initialize` to the daemon or send a new `bots/roots` notification).
- **P3-D-04:** Bot allowlist loader MUST fall back to a hardcoded default for the `default` bot so the Phase 3 migration succeeds — the implicit bot exists even if the user never creates one via the modal.
- **P3-D-05:** System prompt is `DEFAULT_SYSTEM_PROMPT_BASE + injectMemorySuffix(base, md, facts)` per turn (4 KB cap). Phase 4 also injects the bot's persona as a separate fenced block (`## Persona\n<persona>`).
- **P3-D-06:** Memory write tool `memory.update` is in the default bot allowlist; system calls (memory.read/write/tree.list) are SYSTEM_TOOLS.
- **P3-D-07:** Chokidar watcher is owned by the daemon; main bridges `tree:refresh` notifications to the renderer. Phase 4 runs one watcher per bot; daemon re-roots the watcher when `bots/roots` notification fires.

### Claude's Discretion (Phase 4)

- **Bot metadata schema** — `config.json` shape: `{id, name, persona, workspace, allowlist: string[], cron?: string, cronEnabled?: boolean, createdAt, updatedAt, status: 'idle'|'running'|'errored'|'scheduled', lastRunAt?: string, lastRunExitReason?: 'completed'|'cancelled'|'errored', lastRunError?: string}`. The renderer treats this as the source of truth for sidebar display; the daemon treats `allowlist` as the per-bot policy source (replacing `DEFAULT_POLICY`).
- **Status indicator source** — daemon-collected status (Module 1) persisted into `config.json#status` and `config.json#lastRunAt`; renderer reads via `bots/list` IPC. Live status during a run flows through `bot:status` IPC events (mirroring Phase 3's `message:token` pattern).
- **Last-run timestamp source** — daemon writes `{status: 'idle', lastRunAt: ISO, lastRunExitReason, lastRunError?}` to `config.json` after every run completes; renderer reads on `bots/list`.
- **Run history storage** — `<userData>/runs/<bot>.jsonl` append-only NDJSON, one row per run: `{ts, runId, trigger: 'manual'|'cron', durationMs, exitReason: 'completed'|'cancelled'|'errored', error?: {code, message}, messageCount}`. Retention is unbounded in Phase 4; UI shows the latest N rows (default 50, configurable via `bot.runs.limit` env var).
- **Sidebar render location** — replace Phase 3's left-rail `WorkspaceTree` (240 px) with a new `BotSidebar` listing all bots; move the `WorkspaceTree` to the per-bot settings page (UI-06). The sidebar gets the full left rail (260 px). On viewports < 900 px, sidebar collapses to a 32 px icon strip.
- **Modal stack management** — one modal at a time; opening a second (e.g., a settings edit) closes the first; z-order: NewBotModal (1000) > DeleteConfirmModal (1100) > SettingsEditModal (1200) > MemoryPanel (800). Escape closes the topmost; focus trap inside each.
- **Settings page tabs** — two tabs: `General` (name, persona, workspace) + `Permissions & Schedule` (allowlist, cron). Each tab is its own `<form>`; switching tabs does not require a save (forms autosave on blur with debounced persist).
- **Manual trigger UI** — primary action on the sidebar: a "play" icon next to each bot opens an inline composer (input box) at the bottom of the sidebar; pressing Enter sends via `sendMessage({bot, content, msgId})`. The sidebar composer is a separate component from the main chat composer.
- **Cancel UI** — sidebar shows a "stop" icon when a bot's status is `running`; clicking it sends `cancel(runId)`. No confirmation modal (cancel is reversible — re-triggering is cheap).
- **Delete confirmation** — a typed-name confirmation (per bot destructive action pattern from AGENT-02): the modal shows the bot name + the count of sessions/runs it owns, asks the user to type the bot's name to confirm; on confirm the daemon removes `<userData>/bots/<bot>/`, `<userData>/sessions/<bot>/`, `<userData>/runs/<bot>.jsonl`, and emits a single audit line.

### Deferred Ideas (out of scope; do NOT research)

- Phase 5 shell-exec approval modal (UI-04) + global denylist (SEC-03); Phase 4's settings allowlist picker shows the future Phase 5 denylist column as disabled.
- Phase 6 cron scheduler + system notifications (AGENT-09, AGENT-10). Phase 4 records `cron` and `cronEnabled` in `config.json` but does not execute the schedule (a single-line stub `// Phase 6: cron runner` lives in `daemon/main.cjs#initialize`).
- Phase 7 Obsidian vault paths (OBS-01..06); Phase 4 settings page has an empty "Obsidian" tab placeholder.
- Phase 8 browser automation; not in scope.
- Phase 9 Tailscale / packaging; not in scope.
- Cross-bot communication / `delegate_to_agent` tool (CBOT-01, deferred to v2).
- Vector-embedding-based bot discovery or per-bot embeddings.
- Bot cloning / bot templates / bot marketplace.
- Persona versioning (per Out-of-Scope in PROJECT.md).
- System tray icon for "currently running bots".
- Per-bot rate limits / quota.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **AGENT-01** | User can create a new bot with name, persona, workspace, allowlist, cron | NewBotModal collects the form; `bots/create` JSON-RPC validates + writes `<userData>/bots/<bot>/config.json`; daemon initializes memory.md + facts.json + runs.jsonl; emits `bot:status` event so sidebar updates without polling |
| **AGENT-02** | User can delete a bot (folder + all state) with confirmation | DeleteConfirmModal asks for typed-name confirmation; `bots/delete` JSON-RPC atomically removes `<userData>/bots/<bot>/`, `<userData>/sessions/<bot>/`, `<userData>/runs/<bot>.jsonl`; emits `bot:list:updated` so sidebar removes the row |
| **AGENT-03** | User can list all bots with status + last-run timestamp | `bots/list` JSON-RPC scans `<userData>/bots/*/config.json` + `lastRunAt` from each; BotSidebar renders the list with status indicator + last-run timestamp |
| **AGENT-04** | User can edit a bot's persona, workspace, allowlist, schedule | BotSettingsPage (per bot) shows General + Permissions tabs; `bots/update` JSON-RPC validates + writes the changed fields to `config.json`; chokidar watcher re-roots on workspace change |
| **AGENT-07** | User can trigger a bot manually with a message | BotSidebar composer (input box per bot); `bots/trigger` JSON-RPC spawns an in-process run; run history appends `{trigger: 'manual'}` row; sidebar shows running status via `bot:status` events |
| **AGENT-08** | User can cancel a running bot | BotSidebar shows stop icon when status === 'running'; `bots/cancel` JSON-RPC aborts the run's AbortController; daemon emits `bot:status` with `status: 'idle'` + writes run history row with `exitReason: 'cancelled'` |
| **UI-01** | Bot sidebar showing name, status indicator, last-run time | BotSidebar component (260 px left rail) renders one row per bot; status dot (idle: gray, running: green pulse, errored: red, scheduled: blue); last-run time as relative timestamp |
| **UI-05** | "New Bot" creation modal with template fields | NewBotModal component: name, persona (textarea), workspace (path picker), allowlist (multi-select from registered tools), cron (string), cronEnabled (checkbox); submit -> `bots/create` |
| **UI-06** | Per-bot settings page | BotSettingsPage route (`/bots/:botId`); tabs General + Permissions; bot name header + back-to-sidebar button; deletes inline (DeleteConfirmModal) |
| **UI-07** | Run history table per bot | RunHistoryTable component inside BotSettingsPage (third tab or under Permissions); reads `bots/runs` JSON-RPC; columns: ts, duration, exit reason, error |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Bot metadata CRUD (`config.json` read/write) | Daemon | — | SEC-02 pattern: all filesystem IO lives at the trust boundary; `safePath` enforces `<userData>/bots/<bot>/` containment |
| Bot allowlist loader (`getPolicy(bot)`) | Daemon | — | Phase 3's `DEFAULT_POLICY` hardcoded; Phase 4 replaces with per-bot `config.json` reader; falls back to `DEFAULT_POLICY` for `default` bot |
| Bot list / status / last-run | Daemon | Main | Daemon owns the source of truth (`config.json`); main is a thin IPC bridge; renderer reads via `bots/list` IPC |
| Bot CRUD IPC handlers | Main (Electron) | Daemon | Renderer never calls daemon directly; preload `invoke()` + main `ipcMain.handle()` is the only entry point (Phase 1 D-07) |
| Bot status live events | Daemon → Main → Renderer | — | Same `daemon -> main -> webContents.send` pattern as Phase 3's `tree:refresh` notifications; new `bot:status` + `bot:list:updated` channels |
| Manual trigger / cancel | Main (Electron) | Daemon | Reuse Phase 1's `Map<msgId, AbortController>` + daemon `tools/cancel`; new `Map<runId, AbortController>` keyed by run-id for multi-message manual triggers; cancel IPC handler accepts either msgId or runId |
| Run history writer | Main (Electron) | Daemon (audit mirror) | Append-only NDJSON at `<userData>/runs/<bot>.jsonl`; one row per run on completion; reader is the renderer via `bots/runs` IPC |
| Sidebar render | Renderer (React) | — | BotSidebar is a React component; subscribes to `bot:list:updated` + `bot:status` events; manages `activeBotId` in a new state slice |
| NewBotModal | Renderer (React) | — | Form validation + submit → `bots/create` IPC; z-order 1000; focus trap + Escape close |
| DeleteConfirmModal | Renderer (React) | — | Typed-name confirmation (per AGENT-02); z-order 1100 |
| BotSettingsPage | Renderer (React) | — | React Router-style route (`/bots/:botId`); reads `bots/list` to populate, `bots/update` on save |
| Run history table | Renderer (React) | — | Read-only table; reads `bots/runs` IPC; paginated client-side |
| Bot composer (sidebar input) | Renderer (React) | — | Per-bot input; submit → `bots/trigger` IPC; same validation as main Composer |
| Persona injection into system prompt | Main (Electron) | — | Same pattern as Phase 3's `injectMemorySuffix`; reads `config.json#persona`, appends fenced `## Persona\n<persona>` block (capped at 4 KB) |
| Audit entries for bot ops | Daemon (writes) | Main (broadcasts) | Same shape as Phase 1/2/3: `{ts, bot, tool, params, outcome, durationMs, error?}` |
| Bot CRUD renderer state | Renderer (React) | — | New `src/renderer/state/bots.ts` slice; module-scope store + `useBots()` hook + `useBot(botId)` for per-bot details |
| Chokidar re-root on bot list change | Daemon | — | New `bots/roots` JSON-RPC method (main → daemon) replaces `treeRoots` on `initialize`; daemon re-creates the watcher with new paths |

---

## Standard Stack

### Core (all already installed; verified by reading `D:/Claude/Grokbot/package.json` this session)

| Library | Version (from package.json) | Purpose | Why Standard |
|---------|---------------------------|---------|--------------|
| `@anthropic-ai/sdk` | `^0.40.1` | Streaming + tool_use for manual trigger | Locked in Phase 1; same client handles bot-triggered runs |
| `chokidar` | `3.6.0` | Per-bot workspace watcher | Phase 3 Wave 2 dependency; same `chokidar.watch(paths, {ignoreInitial, awaitWriteFinish})` API |
| `react-arborist` | `3.16.0` | Phase 3 file tree (moves to settings page) | Already installed; needed only for BotSettingsPage's workspace preview |
| `react-diff-viewer-continued` | `4.4.0` | Phase 3 diff view | Already installed; reused on settings page run history preview |
| `diff` | `5.2.2` | Phase 3 diff backing | Already installed; transitive of `react-diff-viewer-continued` |
| `electron` | `^33.2.0` | BrowserWindow + IPC + safeStorage | Locked in CLAUDE.md; no alternative |
| `react` | `^19.0.0` | UI framework | Locked in CLAUDE.md |
| `typescript` | `^5.7.2` | Main + renderer type-safety | Standard with the locked stack |
| `vitest` | `^2.1.9` | Unit tests | Phase 1 lock; pinned to v2.1.9 because v5 raises `@types/node` peer to `^22 || >=24` and project is on `^20.11.0` |
| `@playwright/test` | `^1.63.0` | Smoke tests | Phase 1 lock; gated by `LOCALBOT_SMOKE_OK=1` for headed runs |

### Supporting (already installed)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@vscode/ripgrep` | `1.18.0` | `code_search` tool | Phase 2; reused as-is |
| `react-dom` | `^19.0.0` | Renderer DOM | Locked with react |

### New deps for Phase 4

**None.** Phase 4 is pure additive on the existing stack. Every capability (filesystem IO, JSON, chokidar watcher, IPC, modal) is already covered by the locked Phase 1+2+3 stack.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Plain JSON `config.json` files | SQLite via `better-sqlite3` | SQLite needs node-gyp (forbidden by CLAUDE.md); JSON files match Phase 3's "bots are files" model |
| Plain JSON `config.json` files | YAML / TOML | Adds a parser dep; JSON is universal and inspectable in any text editor |
| Append-only NDJSON for run history | SQLite | Same node-gyp reason; append-only NDJSON matches Phase 1+3's session JSONL pattern |
| React Router for `/bots/:botId` route | `useState(botId)` toggle | The settings page is a sibling view, not a full route — a local `view: 'chat' | 'settings'` state suffices; Phase 9 (Tailscale HTTP/WS) is the appropriate moment to add routing |
| Bot composer per sidebar row | Modal-based trigger composer | Inline composer is faster (single click vs open modal + click); sidebar is the canonical home for the bot so the composer lives there |
| Typed-name delete confirmation | Single "Delete" button + confirm() | `confirm()` blocks the main process (Electron-specific); typed-name is the AGENT-02 contract |
| `bots/runs` IPC for history | Reuse `history:list` IPC | History is per-session (chat turns); runs are per-trigger (turn groups); different cardinality; separate IPC keeps the type contracts clean |
| Per-bot cron storage in `config.json` | Separate `schedule.json` | Both files would live under `<userData>/bots/<bot>/`; bundling in `config.json` keeps the bot's surface to a single editable file |

**Installation:** none — all packages are already in `package.json`.

**Version verification (per the package-legitimacy protocol):**
- `npm view @anthropic-ai/sdk version` → `0.40.1` (verified in `package.json` and `node_modules/@anthropic-ai/sdk/package.json` exists per Phase 1+2+3 execution)
- `npm view chokidar version` → `3.6.0` (Phase 3 install confirmed; in `package.json` at `3.6.0`)
- `npm view react-arborist version` → `3.16.0` (Phase 3 install)
- `npm view react-diff-viewer-continued version` → `4.4.0` (Phase 3 install)
- `npm view diff version` → `5.2.2` (Phase 3 install, peer of `react-diff-viewer-continued`)
- All other locked deps are unchanged from Phase 1+2+3 — no drift risk

---

## Package Legitimacy Audit

> **Not strictly required** since Phase 4 installs zero new packages. Audit table included for the planner's reference and to surface any drift discovered while reviewing `package.json`.

| Package | Registry | Age | Source Repo | Verdict | Disposition |
|---------|----------|-----|-------------|---------|-------------|
| `@anthropic-ai/sdk` | npm | First released 2023; v0.40.1 | github.com/anthropics/anthropic-sdk-typescript | OK | Already installed (Phase 1) |
| `chokidar` | npm | First release 2013; v3.6.0 | github.com/paulmillr/chokidar | OK | Already installed (Phase 3) |
| `react-arborist` | npm | First release 2022; v3.16.0 | github.com/guillotro/react-arborist | OK | Already installed (Phase 3) |
| `react-diff-viewer-continued` | npm | First release 2022 (fork); v4.4.0 | github.com/aeolcher/react-diff-viewer-continued | OK | Already installed (Phase 3) |
| `diff` | npm | First release 2013; v5.2.2 | github.com/kpdecker/jsdiff | OK | Already installed (Phase 3) |
| `@vscode/ripgrep` | npm | First release 2020; v1.18.0 | github.com/microsoft/vscode-ripgrep | OK | Already installed (Phase 2) |
| `electron` | npm | First release 2013; v33.2.0 | github.com/electron/electron | OK | Already installed (Phase 1) |
| `react` / `react-dom` | npm | First release 2013; v19.x | github.com/facebook/react | OK | Already installed (Phase 1) |
| `vitest` | npm | First release 2021; v2.1.9 (pinned) | github.com/vitest-dev/vitest | OK | Already installed (Phase 1) |
| `@playwright/test` | npm | First release 2020; v1.63.0 | github.com/microsoft/playwright | OK | Already installed (Phase 1) |

**Packages removed due to [SLOP] verdict:** none (no new packages added).
**Packages flagged as suspicious [SUS]:** none.

*All Phase 4 capabilities are delivered by already-installed packages. No `npm install` is required.*

---

## Architecture Patterns

### System Architecture Diagram

```
+--------------------------------------------------------------+
| Renderer (React 19)                                          |
|                                                               |
|  +------------+   +--------------+   +--------------------+   |
|  | BotSidebar |   | ChatPane     |   | BotSettingsPage    |   |
|  | (260 px    |   | (Phase 3     |   | (per bot,          |   |
|  |  left rail)|   |  surfaces)   |   |  /bots/:botId)     |   |
|  | + Composer |   |              |   | - General tab      |   |
|  +------+-----+   +------+-------+   | - Permissions tab  |   |
|         |                |           | - Runs tab         |   |
|         |  active bot    |           +---------+-----------+   |
|         |  click         |                     |               |
|         v                v                     v               |
|  +-----------------------------------------------------+      |
|  | state/bots.ts (slice) + state/sessions.ts (existing)|      |
|  |   useBots() -> {bots, refresh}                      |      |
|  |   useBot(id) -> {config, refresh}                   |      |
|  |   useActiveBotId() -> {activeBotId, setActive}      |      |
|  +-----------------------------------------------------+      |
|         |                |                     |               |
|  Modals: NewBotModal (z 1000)  DeleteConfirmModal (z 1100)     |
|          SettingsEditModal (z 1200)  MemoryPanel (z 800)       |
+------------------------------|---------------------------------+
                               | IPC (invoke + events)
                               | bots:list, bots:create, bots:update,
                               | bots:delete, bots:trigger, bots:cancel,
                               | bots:runs, bots:list:updated (event),
                               | bot:status (event)
                               v
+--------------------------------------------------------------+
| Electron Main                                                 |
|                                                               |
|  +-----------------+   +----------------+   +--------------+ |
|  | ipc/chat.ts     |   | ipc/bots.ts    |   | ipc/history  | |
|  | (existing;      |   | (NEW — Phase 4)|   | (Phase 3)    | |
|  |  routes by bot) |   | - bots:list    |   |              | |
|  +--------+--------+   | - bots:create  |   +--------------+ |
|           |            | - bots:update  |                    |
|           |            | - bots:delete  |                    |
|           |            | - bots:trigger |                    |
|           |            | - bots:cancel  |                    |
|           |            | - bots:runs    |                    |
|           |            +--------+-------+                    |
|           |                     |                            |
|           |                     v                            |
|           |            +-------------------+                |
|           |            | bots/manager.ts   |                |
|           |            | (NEW — Phase 4)   |                |
|           |            | - listBots()       |                |
|           |            | - createBot()      |                |
|           |            | - updateBot()      |                |
|           |            | - deleteBot()      |                |
|           |            | - triggerBot()     |                |
|           |            | - cancelRun()      |                |
|           |            | - getRuns()        |                |
|           |            +---------+---------+                |
|           |                      |                          |
|           v                      v                          |
|  +------------------------------------------+               |
|  | sessions/jsonl.ts (Phase 3; append per bot)             |
|  |   <sessionsDir>/<bot>/<sessionId>.jsonl                   |
|  +------------------------------------------+               |
|                                                               |
|  +------------------------------------------+               |
|  | runs/jsonl.ts (NEW — Phase 4)                            |
|  |   <runsDir>/<bot>.jsonl  (append-only NDJSON)             |
|  +------------------------------------------+               |
|                                                               |
|  +------------------------------------------+               |
|  | bots/policy.ts (NEW — Phase 4)                           |
|  |   loadConfig(bot) -> BotConfig                            |
|  |   injectPersonaSuffix(base, persona) -> string             |
|  |   injectMemorySuffix(base, md, facts) -> string (P3)      |
|  +------------------------------------------+               |
+------------------------------|--------------------------------+
                               | JSON-RPC 2.0 over NDJSON
                               v
+--------------------------------------------------------------+
| Tool Daemon (daemon/main.cjs)                                |
|                                                               |
|  +-------------------+   +-------------------------------+    |
|  | bots/list         |   | bots/create, bots/update,     |    |
|  | bots/delete       |   | bots/delete (writes          |    |
|  | bots/runs         |   | <userData>/bots/<bot>/       |    |
|  | (read ops)        |   | config.json + memory.md +    |    |
|  +---------+---------+   | facts.json stubs)            |    |
|            |             +-------------------------------+    |
|            v                                                  |
|  +-------------------+   +-------------------------------+    |
|  | bots/loader.cjs   |   | bots/policy.cjs (NEW)        |    |
|  | (NEW)             |   | - getPolicy(bot) loads        |    |
|  | - listAllBots()   |   |   config.json#allowlist       |    |
|  | - readConfig()    |   | - createBotStub() creates     |    |
|  | - writeConfig()   |   |   the per-bot dir +           |    |
|  | - deleteBot()     |   |   initial config.json         |    |
|  +-------------------+   +-------------------------------+    |
|                                                               |
|  +-------------------+   +-------------------------------+    |
|  | registry.cjs      |   | watcher.cjs (Phase 3)         |    |
|  | (extended — getP- |   | - Re-rooted on bots/roots     |    |
|  |  olicy reads per- |   |   notification                |    |
|  |  bot config)      |   |                               |    |
|  +-------------------+   +-------------------------------+    |
|                                                               |
|  Audit append {ts, bot, tool, params, outcome, durationMs}    |
|  for every bots/* op                                         |
+--------------------------------------------------------------+
```

### Recommended Project Structure

```
src/main/
  bots/
    memory.ts                    (existing — Phase 3, unchanged)
    paths.ts                     (NEW — Phase 4 — bot config paths:
                                              configPath(bot),
                                              runsFilePath(bot))
    policy.ts                    (NEW — Phase 4 — loadConfig + injectPersonaSuffix)
  ipc/
    chat.ts                      (extended — routes by `req.bot` instead of hard-coded 'default')
    bots.ts                      (NEW — bots:list/create/update/delete/trigger/cancel/runs handlers)
    history.ts                   (existing — Phase 3, unchanged)
    memory.ts                    (existing — Phase 3, unchanged)
    tree.ts                      (existing — Phase 3, unchanged)
  daemon/
    spawn.ts                     (extended — callBot(method, args) helper; callBotRoots() for re-rooting)
  llm/
    client.ts                    (existing — Phase 1+2, unchanged)
    loop.ts                      (existing — Phase 2, unchanged)
    summarize.ts                 (existing — Phase 3, unchanged)
  sessions/
    jsonl.ts                     (existing — Phase 3, unchanged; already routes per bot)
  runs/
    jsonl.ts                     (NEW — appendRun(bot, runRow); listRuns(bot, limit))
  paths.ts                       (extended — runsDir(), runsFilePath(bot))
  preload/
    index.ts                     (extended — EVENT_BOT_STATUS, EVENT_BOT_LIST_UPDATED;
                                              CHANNEL_BOTS_LIST/CREATE/UPDATE/DELETE/TRIGGER/CANCEL/RUNS)
  tree/
    watcher.ts                   (extended — re-root notification handler)

src/shared/
  ipc-channels.ts                (extended — CHANNELS.BOTS_*, EVENT_BOT_*)
  types.ts                       (extended — BotConfig, RunRecord, BotStatus enum,
                                              BotListRequest/Result, BotCreateRequest/Result,
                                              BotUpdateRequest/Result, BotDeleteRequest/Result,
                                              BotTriggerRequest/Result, BotCancelRequest/Result,
                                              BotRunsRequest/Result, BotStatusEvent,
                                              BotListUpdatedEvent)
  window.d.ts                    (extended — LocalbotApi.bot.{list,create,update,delete,trigger,cancel,runs})

daemon/
  bots/
    default.cjs                  (modified — DEFAULT_POLICY stays; new helper to load per-bot policy)
    loader.cjs                   (NEW — listAllBots, readConfig, writeConfig, deleteBot)
    policy.cjs                   (NEW — getPolicy(bot) loads config.json + falls back to DEFAULT_POLICY)
  tools/
    registry.cjs                 (modified — getPolicy calls into bots/policy.cjs)
  main.cjs                       (extended — bots/* JSON-RPC methods; bots/roots notification handler)

src/renderer/
  state/
    bots.ts                      (NEW — module-scope store + useBots() + useBot(id) + useActiveBotId())
    chat.ts                      (existing — Phase 1+2; extend with per-bot sendMessage)
    messages.ts                  (extended — track active bot id; filter message stream by bot)
    memory.ts                    (existing — Phase 3, unchanged; useMemory(bot) already accepts arg)
    sessions.ts                  (extended — per-bot useCurrentSession)
    tree.ts                      (existing — Phase 3, unchanged)
  components/
    BotSidebar.tsx               (NEW — left-rail sidebar listing bots + composer)
    NewBotModal.tsx              (NEW — modal for AGENT-01)
    DeleteConfirmModal.tsx       (NEW — typed-name confirmation for AGENT-02)
    BotSettingsPage.tsx          (NEW — per-bot settings for AGENT-04 + UI-06)
    RunHistoryTable.tsx          (NEW — UI-07)
    SidebarComposer.tsx          (NEW — per-bot input box for AGENT-07)
    SidebarBotRow.tsx            (NEW — single bot row with status + last-run + actions)
    Chat.tsx                     (modified — move WorkspaceTree to settings; show BotSidebar)
    WorkspaceTree.tsx            (existing — Phase 3, unchanged; used in settings page)
    MemoryPill.tsx               (modified — accept botId prop, default to active bot)
    MemoryPanel.tsx              (existing — Phase 3, unchanged)
    SessionSwitcher.tsx          (modified — accept botId prop, default to active bot)
    SummaryBlock.tsx             (existing — Phase 3, unchanged)
    DiffView.tsx                 (existing — Phase 3, unchanged)
    MessageBlock.tsx             (existing — Phase 3, unchanged)
    Composer.tsx                 (modified — accept botId prop)
    App.tsx                      (modified — wire BotSidebar + view: 'chat' | 'settings' toggle)
  styles/
    app.css                      (extended — --lb-sidebar-width: 260px; --lb-status-* tokens;
                                              .bot-sidebar, .bot-row, .new-bot-modal,
                                              .delete-confirm-modal, .settings-page,
                                              .run-history-table)

tests/unit/
  bot_config.test.ts             (NEW — loadConfig + writeConfig roundtrip; schema validation)
  bot_crud.test.ts               (NEW — create/list/update/delete lifecycle)
  bot_policy.test.ts             (NEW — getPolicy reads config.json#allowlist; falls back to DEFAULT_POLICY)
  bot_runs.test.ts               (NEW — appendRun + listRuns; NDJSON append-only)
  allowlist.test.ts              (extended — per-bot policy override)
  jsonl_router.test.ts           (extended — Phase 3 tests still pass)
  memory.test.ts                 (existing — Phase 3, unchanged)
  list_tree.test.ts              (existing — Phase 3, unchanged)
  summarize.test.ts               (existing — Phase 3, unchanged)

tests/playwright/
  bot-crud.test.ts               (NEW — full vertical slice: create bot -> chat -> run history -> delete)
  multi-bot.test.ts              (NEW — two bots; verify routing; cancel one while the other streams)
  fake-m3-server.ts              (extended — same streamChat; new helper streamBotTrigger)
  memory-history.test.ts         (existing — Phase 3, unchanged)
  tree-diff.test.ts              (existing — Phase 3, unchanged)
  daemon-tools.test.ts           (existing — Phase 3, unchanged)
```

### Pattern 1: Bot metadata as plain JSON config (AGENT-01..04)

**What:** Each bot has a single `<userData>/bots/<bot>/config.json` file that is the source of truth for persona, workspace, allowlist, cron, status, lastRunAt. The daemon's `bots/loader.cjs` exposes `readConfig`, `writeConfig`, `listAllBots`, `deleteBot`. The daemon's `bots/policy.cjs` exposes `getPolicy(bot)` which loads `config.json` and falls back to `DEFAULT_POLICY` for the implicit `default` bot.

**When to use:** Every read/write of bot metadata; every `tools/call` lookup (Phase 3's `registry.getPolicy()` now reads per-bot allowlist).

**Example (skeleton — verify when implementing):**
```javascript
// daemon/bots/loader.cjs (NEW)
const fs = require('node:fs/promises');
const path = require('node:path');
const { safePath } = require('../tools/safe_path.cjs');

const ALLOWED_KEYS = new Set([
  'id', 'name', 'persona', 'workspace', 'allowlist', 'cron',
  'cronEnabled', 'createdAt', 'updatedAt', 'status', 'lastRunAt',
  'lastRunExitReason', 'lastRunError',
]);

async function readConfig(userDataDir, bot) {
  const botDir = path.join(userDataDir, 'bots', bot);
  const cfgPath = await safePath(botDir, 'config.json');
  try {
    const raw = await fs.readFile(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    // Validate keys (anti-pattern: drop unknown keys silently? — NO, throw).
    for (const k of Object.keys(parsed)) {
      if (!ALLOWED_KEYS.has(k)) {
        throw Object.assign(new Error(`unknown config key: ${k}`), { code: 'invalid_config' });
      }
    }
    return parsed;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeConfig(userDataDir, bot, cfg) {
  const botDir = path.join(userDataDir, 'bots', bot);
  await fs.mkdir(botDir, { recursive: true });
  const cfgPath = await safePath(botDir, 'config.json');
  const tmp = `${cfgPath}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  await fs.rename(tmp, cfgPath); // atomic on Win since Node 14
}

module.exports = { readConfig, writeConfig, /* ... */ };
```

> **Schema example (binding):**
> ```json
> {
>   "id": "code-reviewer",
>   "name": "Code Reviewer",
>   "persona": "You are a senior engineer focused on code review…",
>   "workspace": "C:\\Projects\\my-app",
>   "allowlist": ["read_file", "write_file", "edit_file", "code_search", "memory.update"],
>   "cron": "0 9 * * 1",
>   "cronEnabled": false,
>   "createdAt": "2026-09-18T10:00:00.000Z",
>   "updatedAt": "2026-09-18T10:00:00.000Z",
>   "status": "idle",
>   "lastRunAt": null,
>   "lastRunExitReason": null,
>   "lastRunError": null
> }
> ```

### Pattern 2: Per-bot allowlist loader replacing DEFAULT_POLICY (AGENT-04)

**What:** `daemon/tools/registry.cjs#callTool()` currently calls `getPolicy(botId)` which returns the hardcoded `DEFAULT_POLICY`. Phase 4 extends `getPolicy(botId)` to read `<userData>/bots/<botId>/config.json` and return `{allowlist: new Set(cfg.allowlist), denylist: new Set()}` if the file exists; otherwise return `DEFAULT_POLICY` (so the implicit `default` bot keeps Phase 3's behavior).

**When to use:** Every `tools/call` invocation.

**Example (skeleton — verify when implementing):**
```javascript
// daemon/bots/policy.cjs (NEW)
const { readConfig } = require('./loader.cjs');
const { DEFAULT_POLICY } = require('./default.cjs');

function makePolicyFromConfig(cfg) {
  const allowlist = new Set(Array.isArray(cfg.allowlist) ? cfg.allowlist : []);
  return { allowlist, denylist: new Set() };
}

async function getPolicy(botId, userDataDir) {
  if (botId === '_system' || botId === 'default') {
    // Phase 3 backwards-compat: default bot keeps DEFAULT_POLICY unless it
    // has an explicit config.json (which the migration step on first launch
    // may have created).
    const cfg = await readConfig(userDataDir, 'default');
    if (cfg && Array.isArray(cfg.allowlist)) return makePolicyFromConfig(cfg);
    return DEFAULT_POLICY;
  }
  const cfg = await readConfig(userDataDir, botId);
  if (!cfg) {
    throw Object.assign(new Error(`unknown bot: ${botId}`), { code: 'unknown_bot' });
  }
  return makePolicyFromConfig(cfg);
}

module.exports = { getPolicy };
```

### Pattern 3: Sidebar with status indicator + last-run + per-bot composer (UI-01, AGENT-07)

**What:** A new `BotSidebar` component renders one `SidebarBotRow` per bot. Each row shows: status dot (idle: gray; running: green with pulse animation; errored: red; scheduled: blue), bot name, last-run timestamp (relative: "5m ago" / "yesterday" / "never"), action icons (play/stop/settings/delete). Below the rows, a `SidebarComposer` input box lets the user type a message for the active bot and submit via Enter.

**When to use:** Always — the sidebar is the new home for bot navigation.

**Example (skeleton — verify when implementing):**
```typescript
// src/renderer/components/BotSidebar.tsx (NEW)
import { useBots, useActiveBotId, setActiveBotId } from '../state/bots';

export function BotSidebar() {
  const { bots, refresh, loading } = useBots();
  const { activeBotId } = useActiveBotId();
  return (
    <aside className="bot-sidebar" role="navigation" aria-label="Bots">
      <header className="bot-sidebar-header">
        <h2>Bots</h2>
        <button className="bot-sidebar-add" onClick={() => setShowNewBotModal(true)}>+</button>
      </header>
      <ul className="bot-sidebar-list">
        {bots.map((b) => (
          <SidebarBotRow
            key={b.id}
            bot={b}
            isActive={b.id === activeBotId}
            onSelect={() => setActiveBotId(b.id)}
            onTrigger={(msg) => triggerBot(b.id, msg)}
            onCancel={() => cancelBotRun(b.id)}
            onSettings={() => setView('settings', b.id)}
          />
        ))}
      </ul>
      <SidebarComposer botId={activeBotId} onSend={(msg) => triggerBot(activeBotId, msg)} />
    </aside>
  );
}
```

### Pattern 4: NewBotModal — form-driven bot creation (UI-05, AGENT-01)

**What:** A modal with a form collecting `name`, `persona` (textarea), `workspace` (path input with a "Pick folder" affordance), `allowlist` (multi-select checkboxes from `registry.listTools()`), `cron` (string, optional), `cronEnabled` (checkbox). Submit calls `bots/create`; on success closes + emits a toast "Bot '<name>' created" + refreshes sidebar.

**When to use:** Triggered from the sidebar's "+" button or from the empty-state when no bots exist.

**Example (skeleton — verify when implementing):**
```typescript
// src/renderer/components/NewBotModal.tsx (NEW)
export function NewBotModal({ onClose, onCreated }: { onClose: () => void; onCreated: (bot: BotConfig) => void }) {
  const [form, setForm] = useState({
    name: '',
    persona: '',
    workspace: '',
    allowlist: ['read_file', 'write_file', 'edit_file', 'list_dir', 'code_search', 'memory.update'],
    cron: '',
    cronEnabled: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await window.localbot.bot.create({ ...form });
      if (!res.ok) throw new Error(res.error ?? 'failed');
      onCreated(res.bot);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Modal onClose={onClose} title="New Bot">
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label>Name<input value={form.name} onChange={...} required maxLength={64} /></label>
        <label>Persona<textarea value={form.persona} onChange={...} rows={4} maxLength={4096} /></label>
        <label>Workspace<input value={form.workspace} onChange={...} placeholder="C:\\Projects\\my-app" /></label>
        <fieldset>
          <legend>Allowlist</legend>
          {AVAILABLE_TOOLS.map((t) => (
            <label key={t.name}>
              <input type="checkbox" checked={form.allowlist.includes(t.name)} onChange={...} />
              {t.name}
            </label>
          ))}
        </fieldset>
        <label>Cron (optional)<input value={form.cron} onChange={...} placeholder="0 9 * * 1" /></label>
        <label><input type="checkbox" checked={form.cronEnabled} onChange={...} /> Enable schedule (Phase 6)</label>
        {error && <div className="modal-error">{error}</div>}
        <button type="submit" disabled={submitting || !form.name}>{submitting ? 'Creating…' : 'Create bot'}</button>
      </form>
    </Modal>
  );
}
```

### Pattern 5: DeleteConfirmModal — typed-name confirmation (AGENT-02, UI-06)

**What:** A modal that shows the bot's name + a one-line "Type the bot name to confirm" + an input bound to the bot's `name`. Submit button is disabled until the typed value === the bot's name. On confirm, calls `bots/delete` with `{bot}`; on success closes + emits "Bot '<name>' deleted" + removes the row from sidebar.

**When to use:** Triggered from the bot row's delete icon OR from the settings page's "Delete this bot" button.

**Example (skeleton — verify when implementing):**
```typescript
// src/renderer/components/DeleteConfirmModal.tsx (NEW)
export function DeleteConfirmModal({ bot, onClose, onDeleted }: { bot: BotConfig; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionCount = useSessionCountForBot(bot.id);
  const runCount = useRunCountForBot(bot.id);
  const submit = async () => {
    if (typed !== bot.name) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await window.localbot.bot.delete({ bot: bot.id });
      if (!res.ok) throw new Error(res.error ?? 'failed');
      onDeleted();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Modal onClose={onClose} title={`Delete "${bot.name}"?`}>
      <p>This will permanently remove the bot's folder, {sessionCount} session files, and {runCount} run history rows.</p>
      <label>Type <code>{bot.name}</code> to confirm<input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus /></label>
      {error && <div className="modal-error">{error}</div>}
      <button onClick={submit} disabled={submitting || typed !== bot.name} className="destructive">
        {submitting ? 'Deleting…' : 'Delete bot'}
      </button>
    </Modal>
  );
}
```

### Pattern 6: Per-bot settings page (UI-06, AGENT-04)

**What:** A new `BotSettingsPage` component mounted when the user clicks a bot's settings icon. Shows the bot's `config.json` content in editable form fields, organized into two tabs (General, Permissions & Schedule). Saves debounced on blur (300 ms) via `bots/update`. Each tab is a controlled form; switching tabs does not lose changes.

**When to use:** User clicks "Settings" on a `SidebarBotRow`.

**Example (skeleton — verify when implementing):**
```typescript
// src/renderer/components/BotSettingsPage.tsx (NEW)
export function BotSettingsPage({ botId, onBack }: { botId: string; onBack: () => void }) {
  const { bot, refresh, update } = useBot(botId);
  const [tab, setTab] = useState<'general' | 'permissions' | 'runs'>('general');
  const [form, setForm] = useState<BotConfig | null>(null);
  // Debounced save: queue update 300ms after last form change.
  const debouncedSave = useDebouncedCallback(async (next: BotConfig) => {
    const res = await window.localbot.bot.update({ bot: botId, patch: next });
    if (!res.ok) console.error(res.error);
  }, 300);
  if (!bot || !form) return <div className="settings-loading">Loading…</div>;
  return (
    <section className="settings-page">
      <header>
        <button onClick={onBack}>← Back</button>
        <h1>{bot.name}</h1>
        <button onClick={() => setShowDelete(true)} className="destructive">Delete bot</button>
      </header>
      <nav className="settings-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'general'} onClick={() => setTab('general')}>General</button>
        <button role="tab" aria-selected={tab === 'permissions'} onClick={() => setTab('permissions')}>Permissions & Schedule</button>
        <button role="tab" aria-selected={tab === 'runs'} onClick={() => setTab('runs')}>Runs</button>
      </nav>
      {tab === 'general' && <GeneralTab form={form} onChange={setForm} onSave={debouncedSave} />}
      {tab === 'permissions' && <PermissionsTab form={form} onChange={setForm} onSave={debouncedSave} />}
      {tab === 'runs' && <RunHistoryTable botId={botId} />}
    </section>
  );
}
```

### Pattern 7: Run history as append-only NDJSON (UI-07)

**What:** Every bot run writes one row to `<userData>/runs/<bot>.jsonl`. Rows are append-only NDJSON: `{ts, runId, trigger: 'manual'|'cron', durationMs, exitReason, error?, messageCount}`. The renderer reads via `bots/runs` IPC and renders a table (UI-07). Old runs accumulate; retention is unbounded in Phase 4 (a future phase may add a `LOCALBOT_RUN_HISTORY_RETENTION_DAYS` env var).

**When to use:** Every time a manual trigger or cron-driven run completes (success / cancel / error).

**Example (skeleton — verify when implementing):**
```typescript
// src/main/runs/jsonl.ts (NEW)
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

export interface RunRecord {
  ts: string;          // ISO
  runId: string;       // UUID
  trigger: 'manual' | 'cron';
  durationMs: number;
  exitReason: 'completed' | 'cancelled' | 'errored';
  error?: { code: string; message: string };
  messageCount: number;
}

export async function appendRun(bot: string, record: RunRecord): Promise<void> {
  const dir = path.join(runsDir(), bot);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'runs.jsonl');
  await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
}

export async function listRuns(bot: string, limit = 50): Promise<RunRecord[]> {
  const file = path.join(runsDir(), bot, 'runs.jsonl');
  if (!existsSync(file)) return [];
  const text = await fs.readFile(file, 'utf8');
  const out: RunRecord[] = [];
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); if (out.length >= limit) break; } catch { /* skip */ }
  }
  return out;
}
```

### Pattern 8: Manual trigger reusing sendMessage + per-bot run-id map (AGENT-07, AGENT-08)

**What:** `bots/trigger` JSON-RPC starts a run by reusing Phase 1's `sendMessage` flow keyed by a `runId` (UUID). Main keeps a parallel `Map<runId, AbortController>` so multiple sendMessage cycles inside the same run can be cancelled atomically. `bots/cancel` aborts the run's controller. The run-id is also written to `runs.jsonl` on completion so the UI can correlate.

**When to use:** Every manual trigger from the sidebar composer; every cron-driven run (Phase 6).

**Example (skeleton — verify when implementing):**
```typescript
// src/main/ipc/bots.ts (NEW — excerpt)
const activeRuns = new Map<string, AbortController>();

ipcMain.handle(CHANNELS.BOTS_TRIGGER, async (_evt, req: BotTriggerRequest) => {
  const runId = crypto.randomUUID();
  const ac = new AbortController();
  activeRuns.set(runId, ac);
  const startedAt = Date.now();
  broadcast(CHANNELS.EVENT_BOT_STATUS, { bot: req.bot, runId, status: 'running' });
  try {
    // Spawn one or more sendMessage cycles until the run naturally ends.
    // Phase 4: a single sendMessage = a single run.
    const msgId = `${runId}-m1`;
    activeMsgToRun.set(msgId, runId);
    await sendMessageInternal({ bot: req.bot, content: req.content, msgId, signal: ac.signal });
    const durationMs = Date.now() - startedAt;
    await appendRun(req.bot, { ts: new Date().toISOString(), runId, trigger: 'manual', durationMs, exitReason: 'completed', messageCount: 1 });
    await updateBotConfig(req.bot, { status: 'idle', lastRunAt: new Date().toISOString(), lastRunExitReason: 'completed' });
    broadcast(CHANNELS.EVENT_BOT_STATUS, { bot: req.bot, runId, status: 'idle' });
    return { ok: true, runId };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const exitReason = ac.signal.aborted ? 'cancelled' : 'errored';
    await appendRun(req.bot, { ts: new Date().toISOString(), runId, trigger: 'manual', durationMs, exitReason, error: { code: 'run_failed', message: (err as Error).message } });
    await updateBotConfig(req.bot, { status: 'idle', lastRunAt: new Date().toISOString(), lastRunExitReason: exitReason, lastRunError: (err as Error).message });
    broadcast(CHANNELS.EVENT_BOT_STATUS, { bot: req.bot, runId, status: exitReason === 'cancelled' ? 'idle' : 'errored' });
    return { ok: false, error: (err as Error).message, runId };
  } finally {
    activeRuns.delete(runId);
  }
});

ipcMain.handle(CHANNELS.BOTS_CANCEL, async (_evt, req: BotCancelRequest) => {
  const ac = activeRuns.get(req.runId);
  if (!ac) return { ok: false, error: 'no such run' };
  ac.abort();
  return { ok: true };
});
```

### Pattern 9: Chokidar re-root on bot list change (UI-01/UI-06)

**What:** When the bot list changes (create / delete / workspace change), main sends a `bots/roots` notification to the daemon with the new tree-root array. The daemon tears down the existing chokidar watcher (Phase 3's `activeWatcher.stop()`) and creates a new one with the updated rootPaths. The renderer gets `tree:refresh` notifications as before.

**When to use:** `bots/create`, `bots/delete`, `bots/update` (when workspace changes).

**Example (skeleton — verify when implementing):**
```typescript
// src/main/daemon/spawn.ts (extended)
export async function callBotRoots(roots: { id: string; absPath: string }[]): Promise<void> {
  if (!initialized) return;
  // Notification — no `id`, the daemon handles it as fire-and-forget.
  const req: JsonRpcRequest = { jsonrpc: '2.0', id: nextId++, method: 'bots/roots', params: { roots } };
  await sendRequest(req);
}
```

```javascript
// daemon/main.cjs (extended)
case 'bots/roots': {
  const roots = Array.isArray(params?.roots) ? params.roots : [];
  if (activeWatcher) { try { activeWatcher.stop(); } catch {} activeWatcher = null; }
  if (roots.length > 0) {
    activeWatcher = createWatcher(roots, { debounceMs: 250 });
    activeWatcher.on('refresh', (p) => sendNotification('tree:refresh', p));
    activeWatcher.start();
  }
  replyResult(id, { ok: true });
  break;
}
```

### Anti-Patterns to Avoid

- **Anti-pattern: hardcode the bot in main.** Phase 3 already hard-codes `bot = 'default'` in `src/main/ipc/chat.ts:151`. Phase 4 must replace with `bot = req.bot ?? activeBotId` and route the request to the bot's `config.json`.
- **Anti-pattern: per-bot daemon processes.** Phase 1's locked decision is "one shared daemon, per-bot allowlist"; spawning N daemons blows the IPC + audit story and creates N `state.json` lifecycles.
- **Anti-pattern: bot metadata in a SQLite DB.** `node-gyp` is forbidden by CLAUDE.md. Plain JSON files match Phase 3's "bots are files" model.
- **Anti-pattern: write bot metadata from the renderer.** Renderer cannot be trusted to enforce path containment. All bot CRUD goes through the daemon's `bots/create` / `bots/update` / `bots/delete` JSON-RPC methods (Phase 1's SEC-02 pattern).
- **Anti-pattern: load the entire bot list on every `bots/list` invocation.** The list is small (one config.json per bot); a synchronous scan + JSON.parse is fine, but for >100 bots cache the list in memory and invalidate on `bot/roots` notification.
- **Anti-pattern: use `confirm()` for delete confirmation.** `confirm()` blocks Electron's main process; typed-name confirmation is the AGENT-02 contract and is implemented as a React modal.
- **Anti-pattern: open the new-bot modal as a side-effect of selecting a bot.** Modals are triggered explicitly from the sidebar's "+" button or from the empty state; selecting a bot never opens a modal.
- **Anti-pattern: re-fetch `bots/list` after every IPC call.** Subscribe to `EVENT_BOT_LIST_UPDATED` once in the sidebar's `useEffect`; the daemon emits on every create/update/delete.
- **Anti-pattern: render the entire run history list every render.** Phase 4 reads the last 50 rows; the renderer paginates client-side (e.g., "show 25 / 50 / all").
- **Anti-pattern: write `config.json` on every status change.** Status updates only happen at run start + run end; intermediate `bot:status` events are broadcast over IPC but NOT persisted (the persistence is `lastRunAt`, written at run end).
- **Anti-pattern: include the per-bot workspace path in the audit `params` field.** Workspaces can contain user-identifying paths; audit minimization (Phase 1) keeps the params field to `{bot, changeKind}` for `bots/update` and `{bot}` for `bots/create` / `bots/delete`.
- **Anti-pattern: call the existing `cancel` IPC for bot-level cancellation.** `cancel` is keyed by msgId (Phase 1 D-17); a bot run may involve multiple sendMessage cycles (Phase 6 cron). Phase 4 introduces a per-run-id controller and a new `bots/cancel` IPC channel; the existing `cancel` IPC remains for the chat composer's stop button.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Bot metadata persistence | SQLite via `better-sqlite3` (needs node-gyp) | Plain JSON `config.json` files | Matches Phase 3's "bots are files" model; inspectable in any text editor |
| Per-bot allowlist loader | Custom `getPolicy` that reads `bots/<bot>/config.json` directly | `bots/policy.cjs#getPolicy()` (NEW) | Single source of truth for the policy lookup; registry.cjs delegates to it |
| Run history persistence | SQLite tables | Append-only NDJSON `<runsDir>/<bot>.jsonl` | Matches Phase 1+3 session JSONL pattern; append atomicity is well-understood |
| Sidebar with status indicators | Custom hover-expand menu | A flat `<ul>` with one row per bot + status dot | Hover-expand hides info; a flat list is faster to scan for a single-user app |
| Modal stack management | Custom z-index + focus management per modal | A single `<Modal>` component with a `zIndex` prop + focus trap | Centralizes the ARIA dialog + Escape close logic; each modal just sets `zIndex` |
| Settings page routing | React Router | A `view: 'chat' | 'settings'` state in the App | Phase 4 doesn't need full routing; Phase 9 (HTTP/WS) is the right moment for it |
| Typed-name delete confirmation | Custom dialog that compares strings | `<DeleteConfirmModal bot={...}>` with a `disabled` button until `typed === bot.name` | Standard pattern; easy to test |
| Manual trigger | New IPC channel + new agentic loop path | Reuse Phase 1's `sendMessage` flow keyed by a `runId` | No new agentic loop; the existing flow + a per-run-id AbortController is enough |
| Cron expression validation | Hand-rolled cron parser | Defer to Phase 6; Phase 4 only stores the cron string | Phase 4 is "store the cron string" — Phase 6 is "execute the schedule" |
| Bot list change watcher | File watcher on `<userData>/bots/` | Daemon-side scan on `bots/list` + `EVENT_BOT_LIST_UPDATED` on create/delete | Simpler; the watcher would need to traverse subdirs and is overkill |

**Key insight:** Phase 1+2+3 already built the IPC envelope, NDJSON framing, audit log, AbortController map, safePath helper, chokidar watcher, memory IO, per-bot JSONL routing, system prompt injection. Phase 4 is **additive** in five directions: (a) per-bot `config.json` CRUD in the daemon, (b) per-bot allowlist loader replacing `DEFAULT_POLICY`, (c) sidebar + per-bot composer in the renderer, (d) per-bot settings page with two tabs, (e) run history NDJSON + table. Resist the temptation to refactor the existing IPC envelope or the daemon transport — both are locked (D-07, D-10/D-11).

---

## Common Pitfalls

### Pitfall 1: `getPolicy(bot)` reads stale `config.json` when the bot is updated mid-session

**What goes wrong:** `daemon/tools/registry.cjs#callTool()` caches the policy lookup result on module load. After a `bots/update`, the next `tools/call` still uses the old allowlist. The bot can call newly-allowed tools that the user just removed from the allowlist.

**Why it happens:** No cache invalidation when `config.json` changes.

**How to avoid:** `getPolicy()` always reads `config.json` from disk (no caching). The disk read is a few KB of JSON; latency is negligible. If the policy is later cached, invalidate on `bots/roots` notification (which fires on every bot create/update/delete).

**Warning signs:** After updating a bot's allowlist, the next `tools/call` succeeds for a tool the user just removed.

### Pitfall 2: Per-bot workspace path outside `safePath` containment

**What goes wrong:** The bot's `config.json#workspace` is `<some user-chosen path>`. The daemon's `safePath` enforces containment against `workspaceRoot` (Phase 2's pattern) — but `workspaceRoot` is set at `initialize` to `<userData>/workspace/<bot>/`, NOT to the user's chosen path.

**Why it happens:** Phase 2's `safePath` is rooted at `workspaceRoot`, not at `config.json#workspace`.

**How to avoid:** For Phase 4, keep the `workspaceRoot` rooted at `<userData>/workspace/<bot>/` (a per-bot directory under userData). The bot's `config.json#workspace` is **informational** — it points to the user's project the bot operates on, but the daemon's `safePath` is still rooted at `<userData>/workspace/<bot>/`. To bridge, the renderer can show the user-chosen path in the UI; Phase 7 (Obsidian) is when the daemon needs to allow reading from paths outside `workspaceRoot`.

**Warning signs:** `tools/call` with a workspace-relative path resolves to `<userData>/workspace/<bot>/...` rather than `<config.json#workspace>/...`.

### Pitfall 3: Run history NDJSON grows unbounded

**What goes wrong:** Every run writes one row to `<userData>/runs/<bot>.jsonl`. A bot with daily cron + manual runs accumulates thousands of rows over months. `bots/runs` reads the whole file; latency grows linearly.

**Why it happens:** No retention policy.

**How to avoid:** Phase 4 only reads the last 50 rows (`limit=50` default; configurable via `bot.runs.limit` env var). The file accumulates unbounded but reads are bounded. Phase 7 or later adds a configurable retention policy (`LOCALBOT_RUN_HISTORY_RETENTION_DAYS=90`).

**Warning signs:** `bots/runs` IPC takes >100 ms for a bot with >1000 runs.

### Pitfall 4: Sidebar polling loops via IPC subscription

**What goes wrong:** `BotSidebar` subscribes to `EVENT_BOT_LIST_UPDATED` but also polls `bots/list` every 5 seconds in a `useEffect` because the event "might not fire". Duplicate re-renders + IPC chatter.

**Why it happens:** No confidence that the daemon fires the event on every mutation.

**How to avoid:** Subscribe once to `EVENT_BOT_LIST_UPDATED` and trust it; the daemon MUST fire on every create/update/delete (covered by the daemons' `bots/create` / `bots/update` / `bots/delete` JSON-RPC methods). The Playwright `bot-crud.test.ts` asserts the event fires for each.

**Warning signs:** IPC traffic in DevTools shows repeated `bots/list` calls.

### Pitfall 5: Delete confirmation accepts whitespace-padded match

**What goes wrong:** User types `"  Code Reviewer  "` (with spaces); the typed-name comparison `typed === bot.name` rejects it. User confused.

**Why it happens:** Strict string equality on a free-text input.

**How to avoid:** `typed.trim() === bot.name.trim()` (per AGENT-02 contract — the typed-name pattern is forgiving on whitespace).

**Warning signs:** Manual test: delete confirmation rejects obvious-but-padded matches.

### Pitfall 6: Run history writes after `appendRun` failure cause orphaned `lastRunAt`

**What goes wrong:** Run completes; `appendRun` fails (disk full, permission denied); `updateBotConfig` writes `lastRunAt` anyway. The sidebar shows a recent run, but the history is missing the row.

**Why it happens:** Order of operations is reversed.

**How to avoid:** `appendRun` first; if it throws, do NOT update `lastRunAt`. The sidebar shows the prior `lastRunAt` until the next successful run. Log the failure to audit.

**Warning signs:** Manual test: `chmod 000` on `<userData>/runs/`; trigger a bot run; sidebar updates `lastRunAt` but `bots/runs` returns no new row.

### Pitfall 7: Persona injection bloats the system prompt

**What goes wrong:** `config.json#persona` is 8 KB of instructions. `injectPersonaSuffix(base, persona)` inlines it all. System prompt grows to 12 KB; first-token latency spikes.

**Why it happens:** No size cap on persona injection.

**How to avoid:** Cap persona at 4 KB in `injectPersonaSuffix` (mirror of Phase 3's `injectMemorySuffix`). Trim oldest H2 sections first.

**Warning signs:** System prompt size > 10 KB; first-token latency > 1s.

### Pitfall 8: Per-bot chokidar watcher fires on `<userData>/bots/<bot>/config.json` writes

**What goes wrong:** `bots/update` writes `config.json`; the chokidar watcher (Phase 3) is rooted at `<userData>/bots/<bot>/`; a `tree:refresh` notification fires; the renderer's settings page shows "Workspace updated" — confusing because the user just edited metadata.

**Why it happens:** The watcher root includes the metadata directory.

**How to avoid:** Two options: (a) exclude `config.json` from the watcher (chokidar `ignored: ['**/config.json']`); (b) keep the watcher as-is and let the renderer swallow the event when the changed path is `config.json`. Option (a) is cleaner; do that.

**Warning signs:** Manual test: edit a bot's name in the settings page; renderer logs "Workspace updated" without any workspace file changing.

### Pitfall 9: Status indicator races with `bots/list` on create

**What goes wrong:** User creates a bot; `bots/create` returns success; the sidebar renders the new row with `status: 'running'` (default?). The bot has no actual run in flight.

**Why it happens:** The renderer's default status is wrong; or the daemon's `bots/create` writes `status: 'running'` by mistake.

**How to avoid:** New bots are created with `status: 'idle'`. The daemon emits `EVENT_BOT_STATUS {status: 'running'}` only when a run starts.

**Warning signs:** Manual test: create a bot; the new row shows a green pulse (running) immediately.

### Pitfall 10: Multi-bot cancel races the wrong AbortController

**What goes wrong:** User has two bots running (one manually triggered, one cron-triggered). User clicks "Stop" on bot A. `bots/cancel` aborts the AbortController keyed by bot A's `runId`, but main's `Map<msgId, AbortController>` (Phase 1) doesn't know about `runId`. The cancel IPC for the chat composer uses msgId; the `bots/cancel` uses runId.

**Why it happens:** Two parallel abort maps.

**How to avoid:** `bots/cancel` looks up the runId in `activeRuns`, aborts the runId's controller, AND iterates `activeMsgToRun` to abort any msgId controllers mapped to that runId. Both maps share the lifecycle.

**Warning signs:** Manual test: trigger bot A; while streaming, click "Stop" on bot A; the chat composer's Stop button does NOT work for the same run.

---

## Validation Architecture

> `workflow.nyquist_validation: true` in `.planning/config.json` — full section required.

### Test Framework

| Property | Value |
|----------|-------|
| **Framework** | Vitest `^2.1.9` (unit) + Playwright `^1.63.0` (Electron + daemon smoke) |
| **Config files** | `vitest.config.ts` (Node env, includes `tests/unit/**`), `playwright.config.ts` |
| **Quick run command** | `npm test` (Vitest unit, ~10 s) |
| **Full suite command** | `npm run test:all` (Vitest + Playwright daemon smoke, ~40 s) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AGENT-01 | `bots/create` JSON-RPC writes `config.json` + initializes memory.md/facts.json | unit | `npx vitest run tests/unit/bot_crud.test.ts` | Wave 0 |
| AGENT-01 | NewBotModal renders + submit -> bots/create | smoke | `npx playwright test tests/playwright/bot-crud.test.ts` | Wave 0 |
| AGENT-02 | `bots/delete` removes `<userData>/bots/<bot>/` + sessions + runs | unit | covered by `bot_crud.test.ts` | Wave 0 |
| AGENT-02 | DeleteConfirmModal accepts typed-name match; refuses mismatch | smoke | covered by `bot-crud.test.ts` | Wave 0 |
| AGENT-03 | `bots/list` returns all bots with status + lastRunAt | unit | `npx vitest run tests/unit/bot_config.test.ts` | Wave 0 |
| AGENT-03 | BotSidebar renders one row per bot with status + last-run | smoke | covered by `bot-crud.test.ts` | Wave 0 |
| AGENT-04 | `bots/update` patches config.json; per-bot policy reloads | unit | `npx vitest run tests/unit/bot_policy.test.ts` | Wave 0 |
| AGENT-04 | BotSettingsPage edits + saves via `bots/update` | smoke | covered by `bot-crud.test.ts` | Wave 0 |
| AGENT-07 | `bots/trigger` runs one sendMessage cycle + appends run row | unit | `npx vitest run tests/unit/bot_runs.test.ts` | Wave 0 |
| AGENT-07 | Sidebar composer -> `bots/trigger` -> streaming response | smoke | covered by `bot-crud.test.ts` | Wave 0 |
| AGENT-08 | `bots/cancel` aborts the run-id controller; writes cancelled run row | unit | covered by `bot_runs.test.ts` | Wave 0 |
| AGENT-08 | Sidebar stop icon -> `bots/cancel` -> streaming stops | smoke | covered by `bot-crud.test.ts` | Wave 0 |
| UI-01 | BotSidebar renders name + status dot + last-run timestamp | smoke | covered by `bot-crud.test.ts` | Wave 0 |
| UI-05 | NewBotModal collects name, persona, workspace, allowlist, cron, cronEnabled | smoke | covered by `bot-crud.test.ts` | Wave 0 |
| UI-06 | BotSettingsPage renders General + Permissions tabs | smoke | covered by `bot-crud.test.ts` | Wave 0 |
| UI-07 | RunHistoryTable renders rows from `bots/runs` | smoke | covered by `bot-crud.test.ts` | Wave 0 |

### Sampling Rate

- **Per task commit:** `npm test` (Vitest unit only, ~10 s)
- **Per wave merge:** `npm run test:all` (Vitest + Playwright daemon smoke, ~40 s)
- **Phase gate:** Full suite green before `/gsd-verify-work`; headed Electron smoke (`LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/bot-crud.test.ts`) deferred to developer machine per Phase 1+2+3 precedent.

### Wave 0 Gaps

- [ ] `tests/unit/bot_config.test.ts` — covers `readConfig`, `writeConfig` roundtrip; schema validation rejects unknown keys
- [ ] `tests/unit/bot_crud.test.ts` — covers `bots/create` + `bots/update` + `bots/delete` lifecycle; idempotent on re-create; safePath containment
- [ ] `tests/unit/bot_policy.test.ts` — covers `getPolicy` reads `config.json#allowlist`; falls back to `DEFAULT_POLICY` for `default` bot; throws `unknown_bot` for non-existent bot
- [ ] `tests/unit/bot_runs.test.ts` — covers `appendRun` + `listRuns`; NDJSON append-only; newest-first ordering; limit parameter
- [ ] `tests/unit/allowlist.test.ts` (extended) — per-bot policy override: bot A allowlists only `read_file`; bot B allowlists all tools
- [ ] `tests/playwright/bot-crud.test.ts` — full vertical: spawn daemon + Electron + fake M3; NewBotModal -> bots/create -> sidebar shows new bot -> bots/trigger -> streaming response -> bots/runs shows the row -> bots/update -> settings page -> bots/delete -> sidebar removes the row
- [ ] `tests/playwright/multi-bot.test.ts` — two bots with different policies; trigger bot A; while streaming, trigger bot B; cancel bot A; verify bot B continues streaming (proves per-run-id controller isolation)
- [ ] `tests/playwright/fake-m3-server.ts` (extended) — `streamBotTrigger({bot, port})` helper that emits an SSE stream for a bot-triggered run

*Nyquist VALIDATION.md will derive from this section.*

---

## Environment Availability

> Step 2.6: per the protocol, this section is required for phases with external dependencies.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 20+ stdlib | JSONL routing, file IO, atomic tmp+rename | ✓ | per `.nvmrc = 20` (env) | — |
| `@anthropic-ai/sdk` 0.40.1 | Bot-triggered LLM call | ✓ | verified via `node_modules/@anthropic-ai/sdk/package.json` | — |
| M3 API base URL | Bot runs | ✓ | `process.env.M3_API_BASE` default `https://api.MiniMax.io/v1` | — |
| `chokidar` 3.6.0 | Per-bot workspace watcher | ✓ | confirmed via `package.json` (`chokidar: 3.6.0`) | — |
| `react-arborist` 3.16.0 | Settings page workspace preview | ✓ | confirmed via `package.json` | — |
| `react-diff-viewer-continued` 4.4.0 | Settings page diff preview (run history) | ✓ | confirmed via `package.json` | — |
| `diff` 5.2.2 | Diff backing | ✓ | confirmed via `package.json` | — |
| Windows | All | ✓ | Windows 11 Pro 10.0.26200 (env) | — |

**Missing dependencies with no fallback:** none — all covered by the existing Phase 1+2+3 stack.

**Missing dependencies with fallback:** none.

*All Phase 4 capabilities are deliverable with the existing toolchain; no new installs required.*

---

## Security Domain

> `security_enforcement` is absent from `.planning/config.json` — treat as enabled (default per GSD config schema).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | API key in OS keychain (Phase 1 complete); bot CRUD never sees credentials |
| V3 Session Management | yes | Phase 1's `Map<msgId, AbortController>` + Phase 4's `Map<runId, AbortController>`; cancel mid-run aborts only the targeted run |
| V4 Access Control | yes | Per-bot allowlist enforced in daemon's `getPolicy()`; `bots/delete` requires typed-name confirmation in renderer |
| V5 Input Validation | yes | `safePath` for bot dir paths; JSON-schema validation of `config.json` keys; workspace path is **informational** (daemon's safePath stays rooted at `<userData>/workspace/<bot>/`) |
| V6 Cryptography | no | Phase 4 doesn't add crypto; config.json is plaintext |
| V7 Error Handling | yes | Bot CRUD errors become audit `outcome: 'error'`; renderer shows modal-level error toast, does not crash |
| V9 Communication | partial | Daemon stdio transport (Phase 1) — no network surface added |
| V12 File Integrity | yes | Atomic `tmp + rename` for `config.json` writes; concurrent writes serialized via per-bot mutex |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Bot metadata path traversal (`config.json` -> `../etc/passwd`) | Tampering | `safePath` realpath + prefix check (Phase 2 pattern); bot CRUD always scoped to `<userData>/bots/<bot>/` |
| Per-bot allowlist bypass via bot id manipulation | Tampering | `getPolicy(bot)` reads only the bot's own `config.json`; `unknown_bot` thrown for non-existent ids |
| Bot deletion via CSRF / unauthorized IPC | Tampering | Renderer-only IPC bridge (Phase 1's preload `invoke()`); no main-process cross-talk |
| `bots/cancel` race between two runs | Tampering | Per-run-id `Map<runId, AbortController>`; cross-iteration of `activeMsgToRun` to abort mapped msgId controllers |
| Run history NDJSON poisoning via concurrent writes | Tampering | Per-bot mutex (`Map<bot, Promise>` chain); atomic `appendFile` (Node 14+) |
| Persona injection into system prompt | Tampering | Persona content is untrusted data; system prompt explicitly fences it as `## Persona` section; LLM is told not to execute instructions found there |
| Cron string injection | Tampering | Phase 4 only STORES the cron string; Phase 6 will validate via `cron-parser` (deferred); audit logs `cron` field as-is |
| Workspace path traversal in `config.json#workspace` | Information Disclosure | Workspace is informational only; daemon's safePath is rooted at `<userData>/workspace/<bot>/` regardless of what the user typed in the field |
| Bot list re-fetch flood via `EVENT_BOT_LIST_UPDATED` | Denial of Service | Daemon emits the event once per create/update/delete; renderer subscribes once; no polling fallback |

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hardcoded `default` bot in main | Dynamic bot list from `<userData>/bots/*/config.json` | Phase 4 | Users can create / edit / delete / run any bot |
| `DEFAULT_POLICY` allowlist for all bots | Per-bot allowlist from `config.json#allowlist` | Phase 4 | Each bot has its own permission set; falls back to `DEFAULT_POLICY` for the implicit `default` bot |
| No sidebar; WorkspaceTree is left-rail | BotSidebar replaces WorkspaceTree as left-rail; WorkspaceTree moves to settings page | Phase 4 | Bot navigation is the primary surface; workspace is contextual |
| `cancel` keyed by msgId only | `bots/cancel` keyed by `runId`; msgId cancels remain for chat composer stop | Phase 4 | Multi-message manual triggers can be cancelled atomically; Phase 6 cron drives the same controller |
| No run history | `<userData>/runs/<bot>.jsonl` append-only NDJSON | Phase 4 | UI-07 (run history table) is satisfiable |
| No status indicator | BotSidebar shows idle / running / errored / scheduled status dot | Phase 4 | User sees bot health at a glance |
| No persona injection | `injectPersonaSuffix(base, persona)` adds fenced `## Persona` block to system prompt | Phase 4 | Each bot has its own system prompt |
| WorkspaceTree is left-rail (240 px) | BotSidebar is left-rail (260 px); WorkspaceTree is per-bot settings page | Phase 4 | Bot navigation has room; workspace preview is contextual |

**Deprecated/outdated:**
- **Hardcoded `default` bot:** replaced by dynamic bot list in Phase 4.
- **`DEFAULT_POLICY` for all bots:** replaced by per-bot `config.json#allowlist` in Phase 4; `DEFAULT_POLICY` retained as the fallback for the implicit `default` bot.
- **Sidebar-less chat shell:** replaced by BotSidebar in Phase 4.
- **No run history:** replaced by `<userData>/runs/<bot>.jsonl` in Phase 4.
- **No persona injection:** added in Phase 4.

---

## Assumptions Log

> Claims tagged `[ASSUMED]` need user confirmation before becoming locked decisions. The planner should surface these in the discuss-phase if needed.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Per-bot metadata is a single `config.json` (not split across multiple files) | Pattern 1 | If user prefers split files (e.g. `persona.md`, `policy.json`, `schedule.json`), the loader needs to read multiple files; complexity grows. Single file is simpler; planner can recommend this. |
| A2 | `config.json#workspace` is **informational** — the daemon's safePath stays rooted at `<userData>/workspace/<bot>/` | Pattern 1, Pitfall 2 | If user wants the bot to operate on the chosen path directly, Phase 4 needs to extend safePath to accept a per-bot root. This is Phase 7 (Obsidian) scope; planner should confirm informational-only. |
| A3 | Cron string is stored but NOT executed in Phase 4; Phase 6 owns the runner | Pattern 1, Deferred Ideas | If user wants cron to execute immediately, Phase 4 grows by ~3 plans. The Plan 04-03 stub `// Phase 6: cron runner` is the boundary; planner should confirm. |
| A4 | Sidebar replaces WorkspaceTree as left-rail (260 px) | Pattern 3, Chat.tsx restructure | If user prefers sidebar AND workspace tree both visible, the layout breaks. The plan moves WorkspaceTree to settings page; planner should confirm the visual tradeoff. |
| A5 | Run history is unbounded; reads are bounded to last 50 | Pattern 7, Pitfall 3 | If user wants strict retention (e.g. delete after 90 days), Phase 4 grows a retention task. Phase 4 keeps unbounded; planner can defer to a future phase. |
| A6 | Delete confirmation requires typed-name match (per AGENT-02 contract) | Pattern 5 | If user prefers a simpler confirm modal (single Delete button), the UI is one button less. The AGENT-02 contract is locked from REQUIREMENTS.md. |
| A7 | NewBotModal collects all fields at creation; persona + workspace + allowlist are editable post-creation via the settings page | Pattern 4 | If user wants workspace to be immutable (set at create, never editable), the settings page needs to disable the field. The PROJECT.md constraint says "persona edits affect future runs only" — so persona is editable. Workspace being editable matches user expectation. |
| A8 | Manual trigger from sidebar uses an inline composer (input box) — not a modal-triggered composer | Pattern 3 | If user prefers modal-triggered composer, the UI has an extra step. The inline composer is faster; planner can confirm. |
| A9 | Per-bot chokidar watcher excludes `config.json` (so metadata writes do not trigger `tree:refresh`) | Pattern 9, Pitfall 8 | If user wants metadata writes to also trigger a tree refresh (e.g., to update the settings page's last-modified timestamp), the behavior changes. The exclusion is the simpler default. |
| A10 | `bots/roots` notification is used to re-root the chokidar watcher when bot list changes | Pattern 9 | If user wants a static set of roots (only `default`), Phase 4 cannot dynamically add watchers per bot. Dynamic rooting is the canonical pattern; planner can confirm. |
| A11 | The implicit `default` bot persists across Phase 4 — its existing memory + sessions + JSONL stay intact | Locked Decisions | If user wants a hard break (start fresh, no implicit bot), Phase 4 needs to migrate the implicit bot to a user-named bot or delete it. Phase 3 hard-codes `default`; the implicit bot is the migration target. |
| A12 | `react-arborist` is React 19 compatible (Phase 3 confirmed via overrides) | Standard Stack | If not, the settings page workspace preview falls back to a flat list. Phase 3 install was verified; this is a regression check, not a new dependency. |
| A13 | M3's API does not change for Phase 4 (same `client.messages.create` + `messages.stream`) | Standard Stack | If the M3 team changes the API between Phase 3 and Phase 4, the Phase 1+2 client needs updating. No public signal of API change; planner should re-check on first integration. |

**If this table is empty:** All claims were verified or cited — no user confirmation needed. (This table is non-empty: items A1–A13 are all `[ASSUMED]` from training knowledge + Phase 3 patterns; planner should surface the high-risk ones in discuss-phase if the user is around.)

---

## Open Questions

1. **Bot id format.**
   - What we know: The bot id appears in paths (`<userData>/bots/<bot>/`), URLs (Phase 9 routing), JSON-RPC params, and IPC channels.
   - What's unclear: Whether the id is a separate field from the display name, or whether `id === name` always.
   - Recommendation: `id` is a separate slug (lowercase, dashes, max 32 chars; auto-derived from `name` on creation); `name` is the display name. Edits to `name` do NOT change `id`. Edits to `id` are not supported post-creation.

2. **Bot id uniqueness.**
   - What we know: Two bots with the same id would collide in `<userData>/bots/<id>/`.
   - What's unclear: How to enforce uniqueness (check on create? reject? append numeric suffix?).
   - Recommendation: On `bots/create`, validate that `<userData>/bots/<id>/config.json` does not exist; throw `{code: 'bot_exists'}` if it does. The renderer pre-checks but the daemon is the source of truth.

3. **Bot metadata schema versioning.**
   - What we know: Future phases may add fields (e.g., Phase 7 adds `vaultPath`; Phase 9 adds `telegramId`).
   - What's unclear: Whether to version `config.json` explicitly (`{schemaVersion: 1, ...}`) or rely on unknown-key rejection.
   - Recommendation: Explicit `{schemaVersion: 1, ...}` in `config.json`; loader validates the schemaVersion is `=== 1` and throws `{code: 'config_schema_version_mismatch'}` otherwise. Future migrations are explicit.

4. **Per-bot settings page state when the bot is deleted while open.**
   - What we know: User could be viewing a bot's settings page when another window deletes the bot.
   - What's unclear: Whether to show a toast + redirect or block the delete.
   - Recommendation: Subscribe to `EVENT_BOT_LIST_UPDATED`; on delete of the active bot, redirect to the chat shell + show a toast "Bot '<name>' was deleted". No blocking.

5. **Manual trigger uses a single sendMessage cycle or multi-cycle.**
   - What we know: Phase 6 cron may drive multi-cycle runs (one cycle = one user message).
   - What's unclear: Whether Phase 4 manual trigger should also support multi-cycle (e.g., "trigger then auto-retry until the bot says it's done").
   - Recommendation: Phase 4 manual trigger = single sendMessage cycle. Multi-cycle is Phase 6's cron-driven pattern. The run-id controller is forward-compatible (it can drive multiple cycles without code changes).

6. **Workspace path format on Windows.**
   - What we know: `config.json#workspace` may be `C:\\Projects\\my-app` or `C:/Projects/my-app` or a forward-slash UNC path.
   - What's unclear: Whether to normalize on save.
   - Recommendation: Normalize to native path separators (`path.normalize` on the daemon side before write) on every `bots/create` / `bots/update`. The renderer just shows what the daemon wrote.

7. **Bot list rendering on first launch (no bots).**
   - What we know: Phase 3 always has the implicit `default` bot.
   - What's unclear: Whether Phase 4 keeps the implicit `default` bot or starts with zero bots.
   - Recommendation: Keep the implicit `default` bot. Phase 4's `bots/list` always returns at least the `default` bot (even if it has no `config.json` — the daemon synthesizes a default `BotConfig` from `DEFAULT_POLICY`).

---

## Metadata

**Confidence breakdown:**
- **Standard stack:** HIGH — every package is already installed; verified by reading `package.json` and prior phase RESEARCH.md; no new dependencies.
- **Architecture:** HIGH — Phase 1+2+3 patterns read this session (`daemon/main.cjs`, `daemon/tools/registry.cjs`, `daemon/bots/default.cjs`, `src/main/ipc/chat.ts`, `src/main/sessions/jsonl.ts`, `src/main/bots/memory.ts`, `src/renderer/components/Chat.tsx`, `src/renderer/state/sessions.ts`, `src/shared/types.ts`, `src/shared/ipc-channels.ts`, `src/main/preload/index.ts`, `src/main/paths.ts`, `src/main/daemon/spawn.ts`); Phase 4 is additive.
- **Pitfalls:** HIGH — derived from reading actual Phase 1+2+3 code; cross-referenced with locked decisions in `01-CONTEXT.md` / `01-SKELETON.md` and Phase 3 patterns in `03-RESEARCH.md` / `03-UI-SPEC.md`.
- **Validation architecture:** HIGH — follows Phase 1+2+3's Vitest+Playwright pattern (proven in `tests/playwright/daemon-tools.test.ts`, `tests/playwright/memory-history.test.ts`, `tests/playwright/tree-diff.test.ts`).

**Research date:** 2026-09-18
**Valid until:** 2026-10-18 (30 days — Anthropic SDK stable on 0.40.x line; chokidar 3.6.x stable; react-arborist 3.x stable; react-diff-viewer-continued 4.x stable; diff 5.x stable; Electron 33.x stable; React 19 stable; Vitest 2.1.x stable; Playwright 1.63.x stable)