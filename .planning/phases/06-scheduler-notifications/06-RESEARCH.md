---
phase: 06-scheduler-notifications
type: research
researched: 2026-09-19
domain: Per-bot cron scheduling + Windows system notification on scheduled-bot error
confidence: HIGH (Phase 1+2+3+4+5 patterns read this session; daemon/main.cjs + bots/loader.cjs + ipc/bots.ts + ipc/chat.ts + state/bots.ts + BotSettingsPage.tsx + preload/index.ts + ipc-channels.ts + types.ts + paths.ts all read; croner library docs from training + npm registry knowledge; Electron Notification API from training + Electron docs)
---

# Phase 6: Scheduler + Notifications — Research

## User Constraints

> **No `06-CONTEXT.md` exists.** This phase has no user-discussion overrides. Decisions below are derived from `.planning/PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, the locked decisions in Phase 1+2+3+4+5 (read this session), and the patterns established in `05-RESEARCH.md` / `04-RESEARCH.md`. Phase 6 is **additive** on Phase 4+5 — it does not reopen locked decisions from prior phases.

### Locked Decisions (inherited from Phase 1; not reopenable in Phase 6)

- **D-07 (one-way):** IPC contract `sendMessage`/`cancel` + `message:token`/`message:done`/`message:error` is the surface Phase 6 builds on. New event channels (`scheduler:tick`, `scheduler:fired`, `notification:fired`) extend it; **no renames**.
- **D-10/D-11 (one-way):** Daemon transport = JSON-RPC 2.0 over NDJSON, max line 1 MiB. Phase 6 adds `scheduler/list`, `scheduler/upsert`, `scheduler/remove` as new daemon JSON-RPC methods that drive the cron engine; reuses the existing `bots/trigger` JSON-RPC method to actually run the scheduled bot (no new transport, no new envelope).
- **D-12:** Audit log line shape `{ts, bot, tool, params, outcome, durationMs, error?}` is the SEC-04 contract; cron lifecycle ops log as `{tool: 'scheduler.upsert' | 'scheduler.remove' | 'scheduler.tick' | 'scheduler.fire', bot: <botId>, params, outcome, durationMs, error?}`. The `RunRecord` for a scheduled run extends `trigger: 'manual' | 'cron'` (Phase 4 added `trigger: 'manual'`; Phase 6 adds `'cron'`).
- **D-13/D-14:** Session JSONL stays at `<userData>/sessions/<bot>/<sessionId>.jsonl`. Scheduled runs create a NEW session per fire (mirroring manual trigger semantics from Phase 4) — sessions are auto-named by ISO timestamp, so concurrent runs on the same bot never collide on disk.
- **D-17/D-18:** In-flight cancel uses `ipcRenderer.invoke('cancel', runId)` + main's `Map<runId, AbortController>` + daemon `bots/cancel` JSON-RPC. Phase 6 reuses this — a scheduled run is just a `bots/trigger` with `trigger: 'cron'` and a normal `runId`. The user can cancel a scheduled run from the sidebar the same way they cancel a manual one.
- **D-22:** Network/5xx auto-retry ≤3 with exp backoff wraps the SDK call only. Scheduled runs reuse this path.
- **D-26:** Bot metadata directory `<userData>/bots/<bot>/{memory.md, facts.json, config.json}` unchanged. Phase 6 adds a separate scheduler index at `<userData>/scheduler.json` (cross-bot; not per-bot) so a daemon crash doesn't lose schedule state.
- **SKELETON.md row "Phase 6":** "Bots run unattended on cron schedules; user gets system notification when a scheduled bot errors. Persistence: cron + enabled per bot. Library: croner (TS-friendly, no deps, async-safe). Notification: Electron `Notification` API in main process, routed to Windows Action Center."

### Locked Decisions (inherited from Phase 4; not reopenable in Phase 6)

- **P4-D-01:** Per-bot `config.json` schema includes `cron?: string` and `cronEnabled?: boolean` (already in `ALLOWED_CONFIG_KEYS`; written by `bots/create` + `bots/update` since Phase 4). Phase 6 ADDS two new optional fields: `notifyOnError?: boolean` (default true) and `scheduledPrompt?: string` (the prompt the cron engine injects on each fire; default "Run your scheduled check-in"). Both go through `bots/update` and the existing atomic `tmp + rename` write path.
- **P4-D-04:** `getPolicy(bot)` reads `<userData>/bots/<bot>/config.json#allowlist` on every `tools/call`. Phase 6 reuses this — the cron tick creates a `bots/trigger` cycle, which calls the same `runSendMessageCycle` + tool dispatch path. No new policy plumbing.
- **P4-D-08:** Audit minimization (T-P4-22): bot mutation ops log `{changedKeys}` not values. Phase 6 extends: scheduled fires log `{runId, trigger: 'cron', messageCount}` only (same minimization as manual fires); cron lifecycle ops log `{cron, enabled}` (the expression + the boolean — NOT the schedule tick history, NOT the fired timestamp stream).
- **P4 status indicator:** `BotStatus = 'idle' | 'running' | 'errored' | 'scheduled'`. The Phase 4 sidebar already supports `scheduled` (no runs in the codebase yet emit it). Phase 6 emits `scheduled` when a cron tick is imminent (next-fire within 60s) so the sidebar shows "scheduled" pulsing without a run actually starting.

### Locked Decisions (inherited from Phase 5; not reopenable in Phase 6)

- **P5 shell approval flow:** Scheduled bot runs DO NOT bypass the shell approval modal — a scheduled bot that issues `exec_command` will pop the same modal the user sees during manual runs. This is the intended threat model: cron = unattended timing, not unattended authority. A future phase may add a per-bot "auto-approve routine shell" allowlist, but v1 ships with the existing modal flow.

### Claude's Discretion (Phase 6)

- **Cron evaluation owner — daemon vs main vs renderer:** Phase 6 places cron evaluation in the **daemon process** for three reasons: (1) daemon is the trust boundary (SEC-01), so a misbehaving renderer cannot fabricate a "scheduled" fire; (2) daemon already owns `bots/trigger` JSON-RPC + `runSendMessageCycle`, so reuse is free; (3) the scheduler can persist state to `<userData>/scheduler.json` on every tick and survive crashes. Renderer and main subscribe to `bot:status` events but do NOT drive the timer.
- **Cron library — `croner` vs `node-cron` vs raw `setTimeout`:** `croner` (npm `croner@^9.0.0`, ~14 KB, zero deps, MIT). Compared to `node-cron` (1.x; ~3 active maintainers; heavy `luxon` dependency tree) and raw `setTimeout` (works for the next fire but requires manual re-scheduling + drift correction; error-prone across DST + sleep/wake), `croner` is the modern de-facto choice. It supports `next()`, iteration, async handlers, `protect: true` (prevents overlapping fires), timezone-aware math, and a fluent API. Node 20+ ESM is supported.
- **Where the prompt lives:** the daemon injects `config.json#scheduledPrompt` (or the default) as the user message for each scheduled fire. Same `runSendMessageCycle` path — the LLM sees a real chat turn; the bot's persona + memory + tools fire normally. The session JSONL records the prompt verbatim (it's the bot's own audit trail; the `trigger: 'cron'` RunRecord field tells the user why the session exists).
- **Persistence shape — `<userData>/scheduler.json`:** `{ schedules: Array<{ bot: string; cron: string; enabled: boolean; notifyOnError: boolean; nextFireAt: string | null; lastFireAt: string | null; createdAt: string; updatedAt: string }> }`. Atomic tmp + rename writes (mirrors Phase 4's `config.json` pattern). The daemon reads this file at `initialize` and rehydrates every active schedule.
- **Notification library — Electron `Notification` vs `node-notifier`:** Use Electron's built-in `Notification` class (`new Notification({title, body, icon})`, `.show()`). It routes through Windows Action Center automatically; supports `click` → focus window + navigate to bot; supports `silent`; requires only `app.setAppUserModelId('com.localbot.app')` for proper toast grouping. Avoid `node-notifier` (extra dep, deprecated on macOS, weaker Windows toast support).
- **Notification ownership:** main process owns the `Notification` instance and the click handler. Renderer emits an IPC event (`NOTIFICATION_FIRE` invoke) when the daemon reports a scheduled-bot error; main constructs the toast and shows it. The renderer never imports `electron` — keeps the locked preload boundary (D-07).
- **Notification click behavior:** clicking a toast for "Bot 'code-reviewer' errored" focuses the Localbot window (create-if-missing) and emits `EVENT_NAVIGATE_TO_BOT {botId}` so the chat pane switches to that bot. Renderer reads the event via the existing `EVENT_BOT_LIST_UPDATED` style subscription.
- **Trigger conflict policy:** only ONE scheduled run per bot at a time. The cron engine checks the daemon's `activeRuns: Map<runId, AbortController>` (from Phase 4); if a bot already has an active run (manual or scheduled), the tick is skipped and logged as `outcome: 'skipped', reason: 'run_in_progress'`. The next tick will retry. No queueing.
- **Schedule-disabled-while-running:** if the user toggles `cronEnabled = false` mid-run, the current run completes normally (Phase 4's `bots/trigger` doesn't check `cronEnabled` at runtime). The cron engine removes the schedule at the next persist pass; no kill of the in-flight run.
- **App-start replay:** the scheduler is NOT a system service. CLAUDE.md is explicit: "Built for a single user on a single Windows PC that stays on 24/7" — the user accepts that missed-while-offline runs are dropped. The daemon persists `nextFireAt` on every tick so the user can see when the next fire is scheduled; on `initialize`, croner re-computes the next fire from the cron expression (not from the persisted `nextFireAt`), so a 3-day offline period does NOT result in 3 days of catch-up fires.
- **Audit minimization for scheduled fires:** scheduled fires write the same `{runId, trigger: 'cron', messageCount}` audit line as manual fires (Phase 4's `bots.run` audit line). There is NO additional per-tick audit line; croner fires are deduped by `lastFireAt` and the run lifecycle audit handles the rest. Suppressing audit spam here prevents a busy scheduled bot from filling the daily JSONL.
- **Validation Architecture:** full Vitest unit suite + Playwright daemon smoke + Playwright headed-Electron smoke (per Phase 1+2+3+4+5 precedent). Headed tests gate on `LOCALBOT_SMOKE_OK=1` on a real Windows desktop.

### Deferred Ideas (OUT OF SCOPE; do NOT research)

- "Missed fire catch-up" on app restart (CLAUDE.md: PC stays on 24/7).
- Cron expression validation UI (e.g., friendly "every weekday at 9 AM" picker). v1 ships a free-form text input with regex validation against croner.
- Per-bot timezone setting (Phase 6 uses the system local timezone; a future phase may add `cronTimezone?: string`).
- Per-bot "run duration cap" / kill-switch for runaway scheduled runs (Phase 6 inherits `runSendMessageCycle`'s natural error path; the Anthropic SDK stream has no built-in timeout so a truly stuck LLM still hangs the bot — out of scope for Phase 6).
- Notification channels other than Windows Action Center (email, Slack, webhook). Out of scope.
- Notification snooze / do-not-disturb hours. Out of scope.
- `delegate_to_agent` cron-driven fanout (CBOT-01, deferred to v2).
- Scheduled runs that DO bypass the shell approval modal (see "Locked Decisions from Phase 5" above; deferred to a future phase).
- Cron preview ("next 5 fire times") in the settings UI. Phase 6 shows just the next single fire in the schedule tab (computed on render from the persisted expression).
- Background "scheduler daemon" process separate from the tool daemon. Phase 6 reuses the existing daemon.
- Multi-user / per-user scheduled-run attribution. Single-user product.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **AGENT-09** | Bots can be scheduled on a cron expression; user can enable/disable per-bot | Daemon `daemon/scheduler/index.cjs` (NEW) loads `croner` + reads `<userData>/scheduler.json` on `initialize`; per-bot `config.json#cron` + `cronEnabled` already exists (Phase 4 lock); new JSON-RPC methods `scheduler/upsert` + `scheduler/remove` driven by `bots/update`; sidebar shows `status: 'scheduled'` when a fire is imminent (next-fire within 60s) |
| **AGENT-10** | System notification fires when a scheduled bot errors (configurable per bot) | Daemon emits `notification:scheduled-error` notification when a cron-triggered run exits with `exitReason: 'errored'` AND the bot has `notifyOnError === true`; main's `src/main/ipc/notifications.ts` (NEW) listens + constructs `new Notification({title, body})` + `.show()`; click handler focuses window + emits `EVENT_NAVIGATE_TO_BOT {botId}` to switch the chat pane |

---

## Summary

Phase 6 turns Phase 4's dormant `cron` / `cronEnabled` fields into a working unattended scheduler and adds a Windows system notification when a scheduled bot fails. The work splits cleanly across the three existing tiers:

**Daemon side.** A new `daemon/scheduler/index.cjs` (loaded on `initialize`) reads `<userData>/scheduler.json` and starts a `croner` task per enabled schedule. Each task's handler calls the existing `bots/trigger` JSON-RPC path internally (no JSON-RPC round-trip — direct module import) with `{trigger: 'cron', scheduledPrompt: config.scheduledPrompt || DEFAULT_SCHEDULED_PROMPT}`. The `croner` `protect: true` flag prevents overlapping fires; the daemon's existing `activeRuns` map is the cross-check for manual-vs-scheduled conflicts. New JSON-RPC methods `scheduler/upsert` and `scheduler/remove` are idempotent setters that mutate the in-memory `croner` map AND the on-disk `<userData>/scheduler.json` (atomic write). A new notification listener (`notification:scheduled-error` is a daemon → main event, not a JSON-RPC method) watches the `runSendMessageCycle` return value: if `trigger === 'cron'` AND `exitReason === 'errored'` AND the bot's `notifyOnError !== false`, the daemon emits the notification event. The scheduler also emits `bot:status {status: 'scheduled'}` whenever a fire is within 60s of now (so the sidebar pulses).

**Main side.** `src/main/ipc/notifications.ts` (NEW) is a thin bridge: on the `notification:scheduled-error` event from the daemon it constructs an Electron `Notification` with `{title: 'Bot errored: <bot.name>', body: <lastRunError.message>.slice(0, 120)}` and `.show()`s it. A click handler is registered once at app startup; it focuses the Localbot window (or creates it via the Phase 1 `createMainWindow` helper) and emits a new `EVENT_NAVIGATE_TO_BOT` IPC event with `{botId}`. Renderer subscribes via the existing preload `on()` surface and switches the chat pane's active bot. Main also sets `app.setAppUserModelId('com.localbot.app')` at startup so Windows toasts group properly under "Localbot".

**Renderer side.** `src/renderer/components/BotSettingsPage.tsx` already has a Schedule tab (Phase 4) with `cron` (text input) + `cronEnabled` (checkbox). Phase 6 adds the `notifyOnError` checkbox + a `scheduledPrompt` textarea (collapsed by default) + a "Next fire: <ISO>" indicator computed by the renderer from the cron expression (so the user can preview without round-tripping the daemon). `src/renderer/state/bots.ts` extends to subscribe to `EVENT_NAVIGATE_TO_BOT` and switch the active bot. `src/renderer/components/BotSidebar.tsx` already handles `status: 'scheduled'` (it was defined in Phase 4's `BotStatus` union; no rendering code yet); Phase 6 adds the visual dot. The existing `RunHistoryTable` already shows `trigger: 'manual'` rows; Phase 6 adds the `'cron'` trigger label.

**Primary recommendation:** Run cron in the daemon. Use `croner` (modern, small, async-safe, `protect: true`). Use Electron's built-in `Notification` API in main (not `node-notifier`). Persist scheduler state at `<userData>/scheduler.json` (cross-bot, atomic). Treat missed-while-offline runs as dropped (CLAUDE.md 24/7 assumption). Reuse Phase 4's `bots/trigger` for the actual run — no new run path. One fire per bot at a time (use `activeRuns` for cross-check + `protect: true` on `croner`).

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Cron timer evaluation | Daemon | — | SEC-01 trust boundary; daemon owns `bots/trigger`; renderer cannot fabricate fires; main is just an IPC bridge |
| `croner` task lifecycle (start/stop) | Daemon | — | Module-scope `Map<bot, Cron>` keyed by bot id; one task per bot; cleared on bot delete |
| Schedule persistence (`<userData>/scheduler.json`) | Daemon | — | SEC-04: scheduler state is daemon-only state; renderer edits via `bots/update` which routes through the existing `config.json` schema |
| Scheduled bot run dispatch | Daemon | — | Reuses `runSendMessageCycle` from `daemon/main.cjs`; new `trigger: 'cron'` field on the `RunRecord` |
| Trigger conflict prevention (one run per bot) | Daemon | — | Phase 4's `activeRuns: Map<runId, AbortController>` + croner `protect: true`; cron tick checks `activeRuns` for any run on the bot before firing |
| `bot:status {status: 'scheduled'}` emission | Daemon | — | Daemon emits whenever next-fire is within 60s of now; renderer reacts |
| `notification:scheduled-error` event | Daemon | — | Daemon watches `runSendMessageCycle` return for `trigger === 'cron' && exitReason === 'errored' && notifyOnError` and emits the event |
| Windows toast construction + show | Main (Electron) | — | `app.setAppUserModelId` + `new Notification({title, body})` + `.show()` lives in main; Electron API is process-bound; renderer is sandboxed |
| Notification click → focus window + navigate | Main (Electron) | Renderer (state update) | Main owns `BrowserWindow` reference; click handler is registered once at app startup; main emits `EVENT_NAVIGATE_TO_BOT {botId}`; renderer switches active bot |
| Schedule form (cron + enabled + notifyOnError + scheduledPrompt + next-fire preview) | Renderer (React) | — | Reuses Phase 4's BotSettingsPage Schedule tab; renders the new fields |
| `EVENT_NAVIGATE_TO_BOT` subscription | Renderer (React) | — | `src/renderer/state/bots.ts` adds the listener; switches active bot via existing `setActiveBotId` |
| `status: 'scheduled'` sidebar dot | Renderer (React) | — | BotSidebar already accepts the status union; Phase 6 adds the visual rendering |
| Run history `trigger: 'cron'` label | Renderer (React) | — | RunHistoryTable already has `trigger: 'manual'`; Phase 6 extends the switch with `'cron'` |
| Audit minimization (scheduled fires) | Daemon | — | Same `{runId, trigger, messageCount}` shape as manual fires; NO per-tick audit line; `lastFireAt` updates are silent |
| Cancellation of in-flight scheduled run | Daemon + Main | Renderer (cancel UI) | Reuses Phase 4's `bots/cancel` + the `Map<runId, AbortController>`; renderer shows the stop icon when `status === 'running'` regardless of trigger |
| App-start scheduler rehydrate | Daemon | — | On `initialize`, daemon reads `<userData>/scheduler.json`, validates each entry against `config.json#cron` + `#cronEnabled`, starts a `croner` for each enabled bot. No catch-up; croner computes next-fire from the cron expression |

---

## Standard Stack

> Phase 6 adds ONE new dependency (`croner`); all other capabilities are delivered by the locked Phase 1+2+3+4+5 stack plus Node 20+ stdlib (`node:fs`, `node:crypto`).

### Core (all already installed; verified by reading `D:/Claude/Grokbot/package.json` this session)

| Library | Version (from package.json) | Purpose | Why Standard |
|---------|---------------------------|---------|--------------|
| `@anthropic-ai/sdk` | `^0.40.1` | Streaming + tool_use for scheduled runs (reuses `runSendMessageCycle`) | Locked in Phase 1; no new use in Phase 6 |
| `react` | `^19.0.0` | Settings page + sidebar UI | Locked in CLAUDE.md |
| `electron` | `^33.2.0` | `Notification` API + `app.setAppUserModelId` + `BrowserWindow` focus | Locked in CLAUDE.md; Windows toast routing is built in |
| `vitest` | `^2.1.9` | Unit tests | Phase 1 lock; pinned to v2.1.9 |
| `@playwright/test` | `^1.63.0` | Smoke tests | Phase 1 lock; `LOCALBOT_SMOKE_OK=1` for headed runs |

### New dep for Phase 6

**`croner` — version `^9.0.0`** (npm registry, MIT, ~14 KB, zero deps, modern TS-friendly cron parser).

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `croner` | `^9.0.0` | Cron expression parsing + scheduled invocation + DST-safe math + `protect: true` | Modern de-facto choice for cron in Node 20+; smaller and safer than `node-cron`; native async support; first-class TypeScript types |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `croner` | `node-cron` (1.x) | `node-cron` is older, heavier (pulls `luxon` for timezone math), and the 8.x line was deprecated; `croner` is the modern recommended replacement for `node-cron` |
| `croner` | raw `setTimeout` re-scheduling | Manual re-scheduling + drift correction is error-prone across DST, sleep/wake, and app-crash; `croner` handles timezone + drift + protect natively |
| `croner` | `cron-parser` + a separate scheduler loop | `cron-parser` is a parser (you still need to drive `setTimeout`); adds complexity; `croner` combines parsing + scheduling |
| Electron `Notification` | `node-notifier` | `node-notifier` is a wrapper around native tools (SnoreToast on Windows, terminal-notifier on macOS); deprecated on macOS, weaker Windows toast grouping, extra dep; Electron's built-in API is more reliable on Windows |
| Electron `Notification` in main | Renderer `new Notification()` | Renderer is sandboxed; click handler needs `BrowserWindow` reference; `app.setAppUserModelId` must be set once at startup; keeping notification logic in main matches the existing IPC pattern |
| `<userData>/scheduler.json` (cross-bot) | Per-bot `<userData>/bots/<bot>/schedule.json` | Per-bot spreads scheduler state across 50+ files; a daemon crash + replay reads 50 files instead of 1; cross-bot is one atomic write per scheduler mutation |
| Trigger conflict via `activeRuns` check | Queue + drain | Queuing scheduled fires that miss their tick creates a firehose on app restart; skipping-with-log is simpler and matches the "missed fires are dropped" rule |

**Installation:**

```bash
npm install croner@^9.0.0
```

**Version verification:** Run `npm view croner version` after install to confirm. The locked `@types/node: ^20.11.0` peer is satisfied; croner is pure ESM + CJS dual (works under Electron's bundled Node).

---

## Package Legitimacy Audit

> Required whenever this phase installs external packages. Run the Package Legitimacy Gate protocol before completing this section.

| Package | Registry | Age | Source Repo | Verdict | Disposition |
|---------|----------|-----|-------------|---------|-------------|
| `croner` | npm | First release 2021-09-18; v9.x stable since 2024-Q4 | github.com/hexagon/croner | OK (per training + npm registry knowledge) | Approved |

**Packages removed due to [SLOP] verdict:** none.

**Packages flagged as suspicious [SUS]:** none.

*`croner` is a well-known, widely-deployed cron library maintained by hexagon (Patrik Styman). It is the recommended successor to the deprecated `node-cron` package. Node 20+ compatible. The codebase plan below imports it as ESM via dynamic `import('croner')` (or CJS via `require('croner')` — both are supported in v9).*

---

## Architecture Patterns

### System Architecture Diagram

```
+--------------------------------------------------------------+
| Renderer (React 19)                                          |
|                                                               |
|  +-----------------+   +-------------------+   +------------+ |
|  | BotSidebar      |   | BotSettingsPage   |   | RunHistory | |
|  | - status dot    |   | Schedule tab      |   | Table      | |
|  |   scheduled     |   |  cron + enabled + |   | trigger:   | |
|  |   (NEW render)  |   |  notifyOnError +  |   |  'cron'    | |
|  |                 |   |  scheduledPrompt  |   | (NEW)      | |
|  |                 |   |  + Next fire: X   |   |            | |
|  +--------+--------+   +---------+---------+   +------------+ |
|           |                      |                             |
|           v                      v                             |
|  +-----------------------------------------------+             |
|  | state/bots.ts (extended)                      |             |
|  |   subscribe EVENT_NAVIGATE_TO_BOT -> setActive|             |
|  |   BotId(id)                                   |             |
|  +-----------------------------------------------+             |
+------------------------------|--------------------------------+
                               | IPC (invoke + events)
                               | bots:update (existing; cron + notifyOnError + scheduledPrompt),
                               | bot:status (existing; status: 'scheduled' added),
                               | notification:fired (NEW; notification:scheduled-error rename),
                               | event:navigate-to-bot (NEW),
                               | bots:list (existing)
                               v
+--------------------------------------------------------------+
| Electron Main                                                 |
|                                                               |
|  +-----------------+   +----------------+   +---------------+ |
|  | ipc/bots.ts     |   | ipc/notifica-  |   | app.setApp-   | |
|  | (existing;      |   | tions.ts (NEW) |   | UserModelId   | |
|  |  routes         |   | - on 'notifi-  |   | ('com.local-  | |
|  |  bots/update)   |   |   cation:sched-|   | bot.app')     | |
|  |                 |   |   uled-error'  |   +---------------+ |
|  +--------+--------+   |   show         |                      |
|           |            |   Notification |                      |
|           |            |   click: focus |                      |
|           |            |   window + emit|                      |
|           |            |   navigate-to- |                      |
|           |            |   bot          |                      |
|           v            +-------+--------+                      |
|  +--------------------------+                          |
|  | daemon/spawn.ts          |                          |
|  |   existing onNotification|                          |
|  +--------------------------+                          |
+------------------------------|--------------------------------+
                               | JSON-RPC 2.0 over NDJSON
                               | bots/update (existing),
                               | bots/list (existing),
                               | bots/trigger (existing; trigger: 'cron'),
                               | scheduler/upsert + scheduler/remove (NEW — internal)
                               v
+--------------------------------------------------------------+
| Tool Daemon (daemon/main.cjs)                                |
|                                                               |
|  +-----------------------------+                              |
|  | scheduler/index.cjs (NEW)   |   loaded on initialize       |
|  |   - loadScheduler(userData) |                              |
|  |     reads scheduler.json    |                              |
|  |     starts croner per bot   |                              |
|  |   - upsertSchedule(userData,|                              |
|  |     bot, cron, enabled, not-|                              |
|  |     ifyOnError)             |                              |
|  |     -> croner.update +      |                              |
|  |        atomic JSON write    |                              |
|  |   - removeSchedule(bot)     |                              |
|  |     -> croner.stop + JSON   |                              |
|  |   - on cron tick:           |                              |
|  |       if activeRuns.has     |                              |
|  |         (bot): skip + audit |                              |
|  |       else:                 |                              |
|  |         runId = uuid        |                              |
|  |         runSendMessageCycle |                              |
|  |           (bot, prompt, run-|                              |
|  |            Id, signal)      |                              |
|  |         if exitReason ==    |                              |
|  |           'errored' && bot. |                              |
|  |           notifyOnError:    |                              |
|  |           sendNotification( |                              |
|  |             'notification:  |                              |
|  |              scheduled-     |                              |
|  |              error', ...)   |                              |
|  +-----------------------------+                              |
|                                                               |
|  +-----------------------------+                              |
|  | bots/loader.cjs (extended)  |                              |
|  |   ALLOWED_CONFIG_KEYS now   |                              |
|  |     includes:               |                              |
|  |     notifyOnError,          |                              |
|  |     scheduledPrompt         |                              |
|  |   validateConfig enforces   |                              |
|  |     cron regex (5-field     |                              |
|  |     with optional 6th sec)  |                              |
|  +-----------------------------+                              |
|                                                               |
|  RunRecord extends:                                            |
|    { trigger: 'manual' | 'cron' }                             |
|    audit minimization:                                         |
|    { runId, trigger, messageCount }                           |
|    (same shape for both triggers)                             |
+--------------------------------------------------------------+
```

### Recommended Project Structure

```
daemon/
  scheduler/
    index.cjs                                 (NEW — loadScheduler, upsertSchedule, removeSchedule, cron tick handler)
    croner-adapter.cjs                        (NEW — thin wrapper that uses dynamic import('croner'); maps CronExpressionError -> invalid_cron)
  bots/
    loader.cjs                                (extended — ALLOWED_CONFIG_KEYS adds notifyOnError + scheduledPrompt; validateConfig enforces cron regex)
  main.cjs                                    (extended — initialize: loadScheduler(userDataDirState); bots/update path upserts schedule; bots/delete: removeSchedule(bot); runSendMessageCycle emits notification:scheduled-error on cron+errored+notify)

src/main/
  ipc/
    notifications.ts                          (NEW — onNotification('notification:scheduled-error') -> new Notification(...).show(); click handler)
  window.ts                                   (extended — app.setAppUserModelId at startup; click handler focuses window + emits EVENT_NAVIGATE_TO_BOT)
  preload/                                    (extended)
    index.ts                                  (extended — EVENT_NOTIFICATION_FIRED + EVENT_NAVIGATE_TO_BOT in EVENT_CHANNELS)

src/shared/
  ipc-channels.ts                             (extended — EVENT_NOTIFICATION_FIRED, EVENT_NAVIGATE_TO_BOT)
  types.ts                                    (extended — RunRecord.trigger adds 'cron'; BotConfig adds notifyOnError? + scheduledPrompt?)
  window.d.ts                                 (extended — EVENT_NAVIGATE_TO_BOT payload)

src/renderer/
  state/
    bots.ts                                   (extended — subscribe EVENT_NAVIGATE_TO_BOT -> setActiveBotId)
  components/
    BotSidebar.tsx                            (extended — add scheduled status dot rendering)
    BotSettingsPage.tsx                       (extended — add notifyOnError checkbox + scheduledPrompt textarea + Next fire: <ISO> indicator)
    RunHistoryTable.tsx                       (extended — trigger: 'cron' label)

tests/unit/
  scheduler_index.test.ts                     (NEW — loadScheduler rehydrates from scheduler.json; upsertSchedule updates croner + persists; removeSchedule stops croner + removes from disk; tick handler skips on activeRuns; tick handler fires runSendMessageCycle and emits notification on errored)
  bot_config.test.ts                          (extended — notifyOnError + scheduledPrompt validation; cron regex validation)
  scheduler_croner.test.ts                    (NEW — cron expression parsing + next() math; DST transitions; protect semantics)

tests/playwright/
  scheduler.test.ts                           (NEW — Playwright daemon smoke; boots daemon with cron='*/1 * * * *' (every minute); fires bots/trigger with trigger='cron'; verifies notification event; verifies audit line)
```

### Pattern 1: Daemon-owned cron evaluation with `croner` (AGENT-09)

**What:** `daemon/scheduler/index.cjs` wraps `croner` (loaded via dynamic `import('croner')` since the daemon is CommonJS). One `Cron` instance per bot, stored in a module-scope `Map<bot, Cron>`. Each tick handler checks the daemon's `activeRuns` map for any run on the bot; if one exists, the tick is logged as `outcome: 'skipped', reason: 'run_in_progress'` and dropped. Otherwise, it generates a `runId`, builds a `runSendMessageCycle` promise, and awaits it. On errored exit AND `bot.notifyOnError !== false`, emits `notification:scheduled-error`.

**When to use:** Every daemon with a `cron` field + `cronEnabled: true` in its `<userData>/bots/<bot>/config.json` (read at `initialize` time + on `bots/update`).

**Example (skeleton — verify when implementing):**

```javascript
// daemon/scheduler/index.cjs (NEW — excerpt)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let croner = null; // loaded asynchronously at module load
async function ensureCroner() {
  if (!croner) {
    croner = await import('croner');
  }
  return croner;
}

// In-memory schedule registry; key = bot id.
const schedules = new Map();
// Map<bot, lastFireAt ISO> for UI display.
const lastFire = new Map();

// scheduler.json path: <userData>/scheduler.json.
function schedulerPath(userDataDir) {
  return path.join(userDataDir, 'scheduler.json');
}

async function loadScheduler(userDataDir, ctx) {
  // ctx = { userDataDir, activeRuns, appendRun, sendNotification, appendAudit, runSendMessageCycle }
  const file = schedulerPath(userDataDir);
  let raw = '{}';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { /* missing file = empty */ }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return; /* corrupt file = no-op; next upsert overwrites */ }
  if (!parsed || !Array.isArray(parsed.schedules)) return;
  for (const entry of parsed.schedules) {
    if (!entry || typeof entry.bot !== 'string' || typeof entry.cron !== 'string') continue;
    if (entry.enabled === false) continue;
    await upsertSchedule(userDataDir, entry.bot, entry.cron, {
      enabled: true,
      notifyOnError: entry.notifyOnError !== false,
    }, ctx);
  }
}

async function upsertSchedule(userDataDir, bot, cronExpr, opts, ctx) {
  const { Cron } = await ensureCroner();
  const { enabled = true, notifyOnError = true } = opts;
  // Stop any existing schedule for this bot.
  const existing = schedules.get(bot);
  if (existing) { try { existing.stop(); } catch { /* ignore */ } }
  if (!enabled) { schedules.delete(bot); await persistSchedules(userDataDir); return; }
  let task;
  try {
    task = new Cron(cronExpr, { protect: true, name: `bot:${bot}` }, async () => {
      await onCronTick(userDataDir, bot, ctx);
    });
  } catch (err) {
    throw Object.assign(new Error(`invalid cron expression: ${cronExpr}`), { code: 'invalid_cron' });
  }
  schedules.set(bot, task);
  await persistSchedules(userDataDir);
}

function removeSchedule(userDataDir, bot) {
  const existing = schedules.get(bot);
  if (existing) { try { existing.stop(); } catch { /* ignore */ } }
  schedules.delete(bot);
  lastFire.delete(bot);
  // Persist best-effort; if the file write fails, the in-memory state is still authoritative.
  void persistSchedules(userDataDir).catch(() => { /* ignore */ });
}

async function persistSchedules(userDataDir) {
  const entries = [];
  for (const [bot, task] of schedules) {
    const next = (typeof task.nextRun === 'function') ? task.nextRun() : null;
    entries.push({
      bot,
      cron: String(task.name || '').replace(/^bot:/, ''), // best-effort
      enabled: true,
      notifyOnError: task.notifyOnError !== false,
      nextFireAt: next ? new Date(next).toISOString() : null,
      lastFireAt: lastFire.get(bot) || null,
      updatedAt: new Date().toISOString(),
    });
  }
  // Also persist disabled entries (so bots/update with cronEnabled=false survives restart).
  // The "enabled" row is rebuilt from config.json on next loadScheduler.
  const file = schedulerPath(userDataDir);
  const tmp = `${file}.${Date.now()}.tmp`;
  const payload = JSON.stringify({ schedules: entries, updatedAt: new Date().toISOString() }, null, 2);
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, file);
}

async function onCronTick(userDataDir, bot, ctx) {
  const startedAt = Date.now();
  // Cross-check: skip if a manual or scheduled run is already in flight.
  for (const runId of ctx.activeRuns.keys()) {
    // ctx.activeRuns is Map<runId, AbortController>; we need a Map<runId, bot>
    // because main/daemon both track it. See "Cross-check pattern" below.
    const botOfRun = ctx.activeRunBots ? ctx.activeRunBots.get(runId) : null;
    if (botOfRun === bot) {
      ctx.appendAudit({
        tool: 'scheduler.tick',
        bot,
        params: { outcome: 'skipped', reason: 'run_in_progress' },
        outcome: 'error',
        durationMs: Date.now() - startedAt,
      });
      return;
    }
  }
  const runId = crypto.randomUUID();
  const prompt = ctx.getBotScheduledPrompt
    ? ctx.getBotScheduledPrompt(bot)
    : '[Scheduled run] Perform your regular check-in.';
  try {
    const cycle = await ctx.runSendMessageCycle(userDataDir, bot, prompt, runId, new AbortController().signal);
    lastFire.set(bot, new Date().toISOString());
    await persistSchedules(userDataDir);
    if (cycle.exitReason === 'errored' && ctx.getBotNotifyOnError(bot) !== false) {
      ctx.sendNotification('notification:scheduled-error', {
        bot,
        runId,
        errorMessage: cycle.errorPayload ? cycle.errorPayload.message : 'unknown error',
        ts: new Date().toISOString(),
      });
    }
  } catch (err) {
    ctx.appendAudit({
      tool: 'scheduler.fire',
      bot,
      params: { runId, trigger: 'cron' },
      outcome: 'error',
      durationMs: Date.now() - startedAt,
      error: { code: err.code || 'scheduled_fire_failed', message: err.message },
    });
  }
}

function getNextFireAt(bot) {
  const task = schedules.get(bot);
  if (!task || typeof task.nextRun !== 'function') return null;
  const next = task.nextRun();
  return next ? new Date(next).toISOString() : null;
}

module.exports = { loadScheduler, upsertSchedule, removeSchedule, getNextFireAt };
```

### Pattern 2: Bot config schema extension (AGENT-09, AGENT-10)

**What:** `daemon/bots/loader.cjs#ALLOWED_CONFIG_KEYS` adds `notifyOnError` and `scheduledPrompt`. `validateConfig` enforces the cron regex (`/^(\S+\s+){4,5}\S+$/`) when present. `bots/update` validates the patch (T-P4-13: reject `id`/`createdAt`; new: reject `cron` that doesn't match the regex). Renderer-side `BotSettingsPage.tsx` adds the new fields to the Schedule tab.

**Example (skeleton — verify when implementing):**

```javascript
// daemon/bots/loader.cjs (extended — additions)
const ALLOWED_CONFIG_KEYS = new Set([
  // ... existing keys ...
  'notifyOnError',
  'scheduledPrompt',
]);

const CRON_REGEX = /^(\S+\s+){4,5}\S+$/; // 5-field (m h dom mon dow) or 6-field (s m h dom mon dow)
const DEFAULT_SCHEDULED_PROMPT = '[Scheduled run] Perform your regular check-in.';

// Inside validateConfig:
if ('cron' in cfg && cfg.cron !== undefined && cfg.cron !== '') {
  if (typeof cfg.cron !== 'string' || !CRON_REGEX.test(cfg.cron)) {
    throw err('invalid_cron', `cron must be 5- or 6-field expression: ${cfg.cron}`);
  }
}
if ('notifyOnError' in cfg && cfg.notifyOnError !== undefined && typeof cfg.notifyOnError !== 'boolean') {
  throw err('invalid_config', 'notifyOnError must be boolean');
}
if ('scheduledPrompt' in cfg && cfg.scheduledPrompt !== undefined && typeof cfg.scheduledPrompt !== 'string') {
  throw err('invalid_config', 'scheduledPrompt must be string');
}

// Inside writeConfigPatch: reject cron when it fails regex
if (Object.prototype.hasOwnProperty.call(patch, 'cron') &&
    typeof patch.cron === 'string' && patch.cron.length > 0 &&
    !CRON_REGEX.test(patch.cron)) {
  throw err('invalid_cron', `cron must be 5- or 6-field expression: ${patch.cron}`);
}
```

```typescript
// src/shared/types.ts (extended)
export interface BotConfig {
  // ... existing fields ...
  cron?: string;
  cronEnabled?: boolean;
  notifyOnError?: boolean;     // NEW — default true
  scheduledPrompt?: string;    // NEW — default '[Scheduled run] ...'
  // ... rest ...
}

export interface RunRecord {
  // ... existing fields ...
  trigger: 'manual' | 'cron';  // EXTENDED — adds 'cron'
  // ... rest ...
}
```

### Pattern 3: Notification construction in main + click focus + navigate (AGENT-10)

**What:** `src/main/ipc/notifications.ts` listens for `notification:scheduled-error` events from the daemon (via the existing `daemon/spawn.ts#onNotification` bridge). It constructs an Electron `Notification` with `{title: 'Bot errored: <bot.name>', body: <errorMessage>.slice(0, 120), silent: false}`. The click handler focuses the Localbot window (creates one via Phase 1's `createMainWindow` helper if missing) and emits `EVENT_NAVIGATE_TO_BOT {botId}`. `app.setAppUserModelId('com.localbot.app')` is called once in `src/main/index.ts` startup so Windows toasts group under "Localbot" in Action Center.

**When to use:** Every `notification:scheduled-error` event.

**Example (skeleton — verify when implementing):**

```typescript
// src/main/ipc/notifications.ts (NEW)
import { Notification, app, BrowserWindow } from 'electron';
import { CHANNELS } from '../../shared/ipc-channels';
import { resolveBotName } from '../bots/config';

type ScheduledErrorPayload = {
  bot: string;
  runId: string;
  errorMessage: string;
  ts: string;
};

let clickHandlerRegistered = false;
function ensureClickHandlerRegistered(): void {
  if (clickHandlerRegistered) return;
  clickHandlerRegistered = true;
  // No-op: Notification click handlers are per-instance; we set them on each
  // new Notification below. This function is a guard so future "register a
  // global click handler" needs can wire in cleanly.
}

export function handleScheduledError(payload: ScheduledErrorPayload): void {
  ensureClickHandlerRegistered();
  if (!Notification.isSupported()) {
    // Electron can't show toasts on this OS (headless Linux without libnotify).
    // Log to console; the renderer-side status indicator is still authoritative.
    // eslint-disable-next-line no-console
    console.warn(`[notifications] scheduled bot errored: ${payload.bot} — ${payload.errorMessage}`);
    return;
  }
  const botName = resolveBotName(payload.bot) || payload.bot;
  const notification = new Notification({
    title: `Bot errored: ${botName}`,
    body: payload.errorMessage.slice(0, 120),
    silent: false,
  });
  notification.on('click', () => {
    let win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) {
      // Phase 1's createMainWindow is the canonical helper; Phase 6 imports it
      // rather than re-implementing the BrowserWindow creation logic.
      win = require('../window').createMainWindow();
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(CHANNELS.EVENT_NAVIGATE_TO_BOT, { botId: payload.bot });
  });
  notification.show();
}
```

```typescript
// src/main/window.ts (extended — add to createMainWindow startup)
import { app } from 'electron';

export function createMainWindow(): BrowserWindow {
  app.setAppUserModelId('com.localbot.app'); // Windows Action Center grouping
  // ... existing BrowserWindow construction ...
}
```

### Pattern 4: Renderer subscribes to navigate-to-bot (AGENT-10)

**What:** `src/renderer/state/bots.ts` subscribes to `EVENT_NAVIGATE_TO_BOT` once (alongside the existing `EVENT_BOT_LIST_UPDATED` + `EVENT_BOT_STATUS` subscriptions). On `{botId}`, calls `state.setActiveBotId(botId)` so the chat pane switches to that bot. `BotSidebar.tsx` also re-fetches the bot config so the highlighted row matches.

**Example (skeleton — verify when implementing):**

```typescript
// src/renderer/state/bots.ts (extended — add to ensureDaemonSubscription)
const offNavigate = window.localbot.on('event:navigate-to-bot', (payload) => {
  const p = payload as { botId?: string };
  if (!p || typeof p.botId !== 'string') return;
  state.setActiveBotId(p.botId);
  // Best-effort: refresh the bot list in case the bot was deleted.
  void refresh();
});
// ... and add offNavigate to the beforeunload cleanup ...
```

```typescript
// src/renderer/components/BotSidebar.tsx (extended — add 'scheduled' dot rendering)
// Existing code renders idle/running/errored dots. Add:
//   data-status="scheduled" → pulsing blue dot (same shape as 'running' but blue).
```

### Anti-Patterns to Avoid

- **Anti-pattern: cron evaluation in the renderer.** Renderer is sandboxed; a malicious page (or a renderer bug) could fabricate fires. SEC-01 says the daemon is the trust boundary. Renderer subscribes to `bot:status {status: 'scheduled'}` and renders the dot but does NOT drive the timer.
- **Anti-pattern: cron evaluation in main.** Main is an IPC bridge; placing the timer there duplicates state with the daemon (every restart would re-load from disk in two places) and adds a third tier that must agree with the daemon. Keeping the timer in the daemon means a single source of truth.
- **Anti-pattern: bypass the shell approval modal for scheduled runs.** A scheduled bot that issues `exec_command` MUST pop the modal. Cron = unattended timing, not unattended authority. Phase 5's `requestApproval` round-trip works the same whether the trigger was manual or cron.
- **Anti-pattern: queue missed fires on app restart.** The "missed fires are dropped" rule is intentional; CLAUDE.md says PC stays on 24/7. A 3-day offline period must NOT fire 3 days of catch-up. `croner.next()` is computed from the expression, not the persisted `lastFireAt`.
- **Anti-pattern: per-bot `schedule.json`.** Spreads scheduler state across N files; harder to debug; cross-bot is one atomic write. Use `<userData>/scheduler.json`.
- **Anti-pattern: `node-notifier` instead of Electron `Notification`.** `node-notifier` is deprecated on macOS, weaker on Windows; Electron's built-in API is the canonical solution and routes through Windows Action Center cleanly.
- **Anti-pattern: `setTimeout` re-scheduling loop.** Manual re-scheduling drifts across DST; `croner` handles timezone math + sleep/wake natively. Drift over weeks adds up to missed fires or duplicate fires.
- **Anti-pattern: notify on success too.** Phase 6 notifies ONLY on errored scheduled runs (per AGENT-10). Success is the expected case; the chat pane's "running" → "idle" transition + RunHistory row is the success signal. Adding success notifications creates notification fatigue.
- **Anti-pattern: long `scheduledPrompt` with secrets.** The prompt is persisted to disk in `config.json`. Like persona, it should be human-readable. Audit minimization: scheduled bot's user-message content is NOT logged to the audit JSONL (it's a session JSONL line — that's the bot's own log).
- **Anti-pattern: edit `config.json#cron` without upserting `scheduler.json`.** `bots/update` MUST route through `scheduler.upsertSchedule` to keep the in-memory `croner` map in sync. Otherwise the daemon has stale timers.
- **Anti-pattern: delete a bot without removing its schedule.** `bots/delete` MUST route through `scheduler.removeSchedule` to stop the cron task. Otherwise the croner tries to fire on a deleted bot (the `runSendMessageCycle` would `unknown_bot` log + audit; cleaner to stop the task).
- **Anti-pattern: spawn the click handler inline per Notification instance.** Notification click handlers in Electron are per-instance — that's fine, but don't add ad-hoc `notification.on('click', ...)` calls scattered across the codebase. All click behavior lives in `notifications.ts`.
- **Anti-pattern: run cron in renderer-supplied intervals.** The daemon owns the timer; renderer cannot influence timing. Renderer-side "next fire" preview is computed by parsing the cron expression client-side (using a lightweight expression parser or croner itself in a small bundle), not by polling the daemon.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cron expression parsing + scheduling | Hand-rolled `setTimeout` loop | `croner` | DST math, drift correction, sleep/wake, `protect: true` semantics are non-trivial; croner handles all of it correctly |
| Cron expression validation | Hand-rolled regex | croner `new Cron(expr, { ... })` wrapped in try/catch | croner throws `CronExpressionError` for invalid expressions; the daemon maps to `invalid_cron` code |
| Windows toast notifications | Custom WinRT bindings / PowerShell `New-BurntToastNotification` | Electron `new Notification({title, body})` + `app.setAppUserModelId` | Electron's API wraps the WinRT toast API; works on Windows 10/11; supports `click` event |
| Notification focus-on-click | Custom IPC handshake between toast and renderer | BrowserWindow reference + `webContents.send(EVENT_NAVIGATE_TO_BOT)` | Main already owns the BrowserWindow reference; renderer subscribes once via preload `on()` |
| Schedule persistence | SQLite / `lowdb` / `nedb` | `<userData>/scheduler.json` (atomic write) | Matches Phase 4's `config.json` pattern; inspectable in a text editor; FIFO write is trivial |
| Trigger conflict prevention | Custom run-queue + drain | `activeRuns: Map<runId, AbortController>` (Phase 4) + croner `protect: true` | Phase 4 already has the cross-check map; croner prevents overlapping fires from croner itself |
| Cron preview ("next fire at X") | Round-trip to daemon for every keystroke | Render-side cron parser (or croner itself in a small bundle) | Avoids IPC spam; the preview is best-effort UX |
| Per-bot schedule enable/disable | New IPC channel + per-bot state | `bots/update` patch with `cronEnabled: false` | Reuses the existing atomic-write path; the daemon reacts by calling `scheduler.removeSchedule` |
| Audit minimization for cron ops | Verbose per-tick logging | Silent per-tick; only `scheduler.fire` audit on actual runs | Matches Phase 4's `{runId, trigger, messageCount}` shape; one RunRecord per fire |

**Key insight:** Phase 1+2+3+4+5 established the JSON-RPC envelope (D-10/D-11), the IPC bridge (D-07), the audit shape (D-12), the per-bot policy loader (T-P4-03), the per-runId AbortController map (P4-D-02), the AppModal primitive, and the `bots/trigger` path. Phase 6 is purely additive on those layers — one new dependency (`croner`), one new daemon module (`daemon/scheduler/index.cjs`), one new IPC bridge (`src/main/ipc/notifications.ts`), and two new optional `config.json` fields. The hardest design decision is "what happens on app start" — Phase 6 picks "rehydrate from disk, compute next fire from the cron expression, drop missed fires" (the simplest model that matches CLAUDE.md's 24/7 assumption).

---

## Runtime State Inventory

> Phase 6 is NOT a rename/refactor/migration. This section is included for completeness but every category answers "Phase 6 adds new state; nothing migrated from prior phases."

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | NEW: `<userData>/scheduler.json` (cross-bot schedule registry) | code only — new file, no migration; created on first `bots/update` with `cron` |
| Stored data (extended) | `<userData>/bots/<bot>/config.json` adds `notifyOnError?` + `scheduledPrompt?` | schema-allowlist extension (`ALLOWED_CONFIG_KEYS`); existing configs without these fields are still valid (fields are optional, default to `true` and `DEFAULT_SCHEDULED_PROMPT` respectively) |
| Live service config | None — `croner` tasks are in-memory; rebuilt from `<userData>/scheduler.json` on `initialize` | n/a |
| OS-registered state | None — Phase 6 does NOT register Windows Task Scheduler entries, launchd plists, or systemd units. All scheduling lives in the Localbot daemon process | n/a |
| Secrets/env vars | None — Phase 6 doesn't add new env vars or secret keys | n/a |
| Build artifacts | NEW: `dist/main/daemon/scheduler/index.cjs` (copied from `daemon/scheduler/` by the existing `build:main` script's `cpSync`) | The existing `npm run build:main` script already does `fs.cpSync('daemon', 'dist/main/daemon', {recursive:true})` — Phase 6 is automatically picked up |
| NPM dependencies | NEW: `croner@^9.0.0` | `npm install croner@^9.0.0` adds the dep + the `package-lock.json` entry |

**Nothing found in category:** All categories above explicitly checked and noted. Phase 6 introduces a new top-level state file (`scheduler.json`) and two optional config fields but does not migrate or rename any existing state. Existing bots created before Phase 6 have `cronEnabled: undefined` (effectively false) so they will NOT be scheduled automatically.

---

## Common Pitfalls

### Pitfall 1: `croner` returns a Promise from `new Cron()` — wrong type assumption

**What goes wrong:** `croner` v9 is fully async-aware: a tick handler can return a Promise and the next tick waits for it. But `new Cron(expr, opts, handler)` itself is synchronous (it throws synchronously on invalid expressions). The naive code `const task = await new Cron(...)` succeeds without warning but the synchronous throw is swallowed because there's no enclosing `try`.

**Why it happens:** `croner` is async-first in its tick handling but the constructor is synchronous; mixing the two via `await` is a footgun.

**How to avoid:** Wrap the constructor in a synchronous `try { task = new Cron(...) } catch (err) { throw ... }` block (NOT `await`). The handler IS allowed to be async.

**Warning signs:** Manual test: set `cron: 'invalid expression'` in the settings; the bot is "saved" but no croner task is created; the next expected fire is silently missed.

### Pitfall 2: App-start catch-up fires after 3 days offline

**What goes wrong:** User closes the app Friday evening, reopens Monday morning. The cron task fires `*/15 * * * *` (every 15 min). If the scheduler uses `lastFireAt` to compute the next fire, it fires 200+ times in rapid succession on Monday morning.

**Why it happens:** "Catch up missed fires" is the default mental model for cron libraries; croner does NOT catch up by default but a hand-rolled "compute next fire from lastFireAt" loop WOULD.

**How to avoid:** `croner` computes next fire from the expression itself (`task.nextRun()` returns the next Cron time after the current instant), not from `lastFireAt`. Persist `lastFireAt` for UI display only; never use it to compute the next fire. On app start, croner naturally waits until the next expression hit; missed fires are silently dropped.

**Warning signs:** Manual test: set `*/1 * * * *`, close the app for 10 minutes, reopen; only ONE fire happens (the next one after reopen), not 10.

### Pitfall 3: Scheduled bot pop shell approval modal when user isn't there

**What goes wrong:** Bot `code-reviewer` is scheduled to run at 3 AM with cron expression `0 3 * * *`. The bot's LLM decides to call `exec_command('rm -rf build/')`. The Phase 5 approval modal pops in the renderer; the user is asleep; the modal blocks the chat composer forever (no timeout for the modal itself; Phase 5's `APPROVAL_TIMEOUT_MS = 5 * 60 * 1000` rejects after 5 minutes).

**Why it happens:** Phase 5's approval flow assumes a human is present. Phase 6 doesn't change this — scheduled bots that need shell exec will get the same modal. If no human is there, the 5-minute timeout rejects the exec; the bot run continues with `exitReason: 'errored'` and Phase 6 fires the notification.

**How to avoid:** Document this in the settings tab tooltip ("Scheduled runs still require approval for shell commands. If the bot needs to run shell while you're away, add the command to its always-allow list."). Phase 6 does NOT change Phase 5's approval flow; a future phase may add a "scheduled bot shell allowlist" but that's out of scope.

**Warning signs:** User report: "my 3 AM scheduled bot got stuck waiting for shell approval."

### Pitfall 4: `croner` `protect: true` doesn't help when the conflict is between manual + scheduled

**What goes wrong:** User manually triggers bot `code-reviewer` at 9:00:00. The 9:00:00 cron tick fires at the same instant. croner `protect: true` prevents two croner fires from overlapping, but it doesn't know about manual runs from `bots/trigger`. Both fires hit `runSendMessageCycle` simultaneously; the bot's session JSONL gets interleaved turns; the audit log shows two `bots.run` rows for the same wall clock.

**Why it happens:** `protect: true` is internal to croner; it doesn't see the daemon's `activeRuns` map.

**How to avoid:** The cron tick handler checks `activeRuns` for any run on the bot BEFORE calling `runSendMessageCycle` (Pattern 1). If a run is in progress, log `outcome: 'skipped', reason: 'run_in_progress'` and return. The next cron tick will retry; the `protect: true` flag handles the case where two croner fires somehow race (shouldn't happen but defensive).

**Warning signs:** Manual test: manually trigger a bot right as its cron fires; verify only one `runSendMessageCycle` actually runs.

### Pitfall 5: Notification click handler can't find the BrowserWindow (closed/minimized)

**What goes wrong:** User closed the Localbot window (it's still running in the tray — Phase 9 will add a tray; Phase 6 doesn't have one). A scheduled bot errors; the toast pops; user clicks; the click handler tries to focus a BrowserWindow that doesn't exist; `BrowserWindow.getAllWindows()[0]` returns undefined.

**Why it happens:** Phase 6 doesn't have a system tray; the window can be closed entirely (on macOS) or minimized (on Windows). The click handler must create-or-focus.

**How to avoid:** `notifications.ts#handleScheduledError` click handler calls `createMainWindow()` if `BrowserWindow.getAllWindows()[0]` is missing or destroyed. Phase 1's `createMainWindow` is the canonical helper; reuse it.

**Warning signs:** Manual test: close the Localbot window (X button on Windows); trigger a scheduled error toast; click the toast; verify the window reappears.

### Pitfall 6: `app.setAppUserModelId` not called → Windows toasts group under "electron.app.Localbot"

**What goes wrong:** The toast pops with the wrong app name in Action Center. The user has 5 "electron.app.Localbot" entries; they don't know which app fired them.

**Why it happens:** Electron's default `AppUserModelID` is `electron.app.<appname>`; Windows uses this to group toasts. Without an explicit `setAppUserModelId`, the toasts look like they came from "Electron" generically.

**How to avoid:** Call `app.setAppUserModelId('com.localbot.app')` ONCE at app startup (in `createMainWindow` or `src/main/index.ts` before the first window opens). This is the standard Electron pattern.

**Warning signs:** Manual test: trigger a toast; check Windows Action Center; verify it groups under "Localbot".

### Pitfall 7: `bot:status {status: 'scheduled'}` spam — emitting every cron tick

**What goes wrong:** The cron task fires every minute. The handler emits `bot:status {status: 'scheduled'}` whenever the next-fire is within 60s. The sidebar updates the dot 60 times per hour.

**Why it happens:** No debounce on the "scheduled" status emission.

**How to avoid:** Emit `status: 'scheduled'` ONLY on transitions: idle → scheduled (when next-fire enters the 60s window), scheduled → running (when fire starts), scheduled → idle (when fire completes). Track the current status in the scheduler module and only emit on change.

**Warning signs:** Manual test: watch the bot sidebar while a cron fires every minute; verify the "scheduled" dot toggles once per minute, not continuously.

### Pitfall 8: `scheduler.removeSchedule` doesn't persist the removal

**What goes wrong:** User disables cron on a bot via the settings page. The daemon's in-memory `croner` task is stopped, but `<userData>/scheduler.json` still contains the entry. The daemon restarts (crash + relaunch). On `initialize`, `loadScheduler` reads the file and re-starts the cron task for the disabled bot.

**Why it happens:** `removeSchedule` calls `schedules.delete(bot)` (in-memory) but the `persistSchedules` function iterates `schedules` (the in-memory map) which doesn't include the removed bot. The disabled entry stays on disk.

**How to avoid:** `persistSchedules` MUST iterate the authoritative in-memory map AND clear stale entries from disk. The simplest fix: re-write the file from scratch every time (which `persistSchedules` already does — the file content is built from `schedules.entries()`). The bug is that disabled bots are NOT in `schedules` but their config still says `cron: '...'`. So `loadScheduler` re-reads `config.json#cron` on `initialize` and re-starts the cron task.

The deeper fix: `loadScheduler` reads `<userData>/scheduler.json` as the source of truth (NOT `config.json#cron`). `bots/update` ALWAYS writes BOTH `config.json` (for renderer display) AND `scheduler.json` (for daemon state). On `initialize`, only `scheduler.json` matters. This is the locked Phase 6 design.

**Warning signs:** Manual test: disable cron on a bot; restart the daemon; verify the cron task is NOT restarted.

### Pitfall 9: Scheduled bot error notification fires for manual triggers

**What goes wrong:** User manually triggers bot `code-reviewer` with a message. The bot errors. The Phase 6 notification fires ("Bot errored: code-reviewer") even though it was a manual trigger.

**Why it happens:** The notification handler checks `cycle.exitReason === 'errored'` but doesn't check `trigger`.

**How to avoid:** Pattern 1 emits `notification:scheduled-error` ONLY when `cycle.exitReason === 'errored' && getBotNotifyOnError(bot) !== false`. The `trigger` check is implicit because `runSendMessageCycle` is called from the cron tick handler with a `trigger: 'cron'` marker. Manual triggers go through `bots/trigger` JSON-RPC which is a different code path and doesn't emit the notification. The audit line for manual triggers is `{trigger: 'manual'}` and for scheduled fires is `{trigger: 'cron'}` — keep them distinct.

**Warning signs:** Manual test: manually trigger a bot; force an error; verify NO toast pops.

### Pitfall 10: Cron expression in a non-system timezone silently drifts

**What goes wrong:** User sets `cron: '0 9 * * *'` expecting "9 AM every day in their local time". The bot fires at 9 AM UTC, which is 4 AM EST (or 1 AM PST). The user wakes up to a bot that ran 8 hours ago.

**Why it happens:** `croner` defaults to UTC unless `timezone` is specified. The user expects local time.

**How to avoid:** Pass `{ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }` to `new Cron(...)` so the scheduler uses the system's local timezone (Phase 6 uses this). Document the choice in the settings tab tooltip. A future phase may add a per-bot `cronTimezone?: string` override.

**Warning signs:** Manual test: set `0 9 * * *` on a machine set to EST; verify the fire happens at 9 AM EST (not 9 AM UTC).

### Pitfall 11: `config.json#notifyOnError: false` is silently dropped if the field is set without an explicit boolean

**What goes wrong:** User edits `config.json` by hand to add `"notifyOnError": 0` (the number zero). `validateConfig` rejects the file with `invalid_config`. The bot is "stuck" in the errored state.

**Why it happens:** `typeof cfg.notifyOnError !== 'boolean'` rejects truthy non-boolean values. A user expecting JSON's loose typing writes `0` or `"false"`.

**How to avoid:** `validateConfig` accepts `notifyOnError` ONLY when it's strictly boolean. The UI controls set explicit `true` or `false`. The error message tells the user the field must be boolean.

**Warning signs:** Manual test: edit `config.json` to set `notifyOnError: 0`; reload the bot settings; verify the field is reset to `true` (the default).

### Pitfall 12: `<userData>/scheduler.json` race condition with concurrent `bots/update` calls

**What goes wrong:** User rapidly toggles `cronEnabled` on/off via the settings page. Two `bots/update` calls land in the daemon simultaneously. Both call `upsertSchedule`; both write to `<userData>/scheduler.json`; the atomic `tmp + rename` race produces a corrupted file (the older write wins).

**Why it happens:** `bots/update` is processed serially by the daemon's readline handler (single-threaded), but `upsertSchedule` is async and the next readline event fires before the previous `persistSchedules` completes.

**How to avoid:** Serialize `persistSchedules` via a simple promise chain (`schedulerPersistQueue = schedulerPersistQueue.then(() => persistSchedules(...))`). The daemon's readline handler awaits the chain before processing the next event.

**Warning signs:** Manual test: rapidly toggle cronEnabled 10 times; verify the final `scheduler.json` is valid JSON and contains the correct entries.

---

## Code Examples

> Verified patterns from existing Phase 4 + Phase 5 code + standard Node 20+ stdlib usage + `croner` 9.x. All values shown match the locked decisions in this document.

### Existing pattern: per-runId AbortController map (Phase 4, `daemon/main.cjs:14-18`)

```javascript
const activeRuns = new Map();
const activeRunBots = new Map();
```

**Phase 6 extension:** The cron tick handler iterates `activeRuns` to detect cross-trigger conflicts (Pattern 1 + Pitfall 4). The map is the canonical "is this bot currently busy" check; both manual and scheduled triggers update it.

### Existing pattern: bot config schema allowlist (Phase 4, `daemon/bots/loader.cjs:19-34`)

```javascript
const ALLOWED_CONFIG_KEYS = new Set([
  'id', 'name', 'persona', 'workspace', 'allowlist',
  'cron', 'cronEnabled',
  'createdAt', 'updatedAt', 'status', 'lastRunAt',
  'lastRunExitReason', 'lastRunError', 'schemaVersion',
]);
```

**Phase 6 extension:** Add `'notifyOnError'` and `'scheduledPrompt'` to the set. Existing configs without these fields are still valid (fields are optional).

### Existing pattern: per-runId AbortController (Phase 4 + 5, `src/main/ipc/bots.ts:42-46`)

```typescript
const activeRuns = new Map<string, AbortController>();
const activeMsgToRun = new Map<string, string>();
```

**Phase 6 extension:** No change. Main's `activeRuns` is for the chat composer's `msgId`; the daemon's `activeRuns` is for the `runId` (used by cron + manual). Both maps coexist; the cron tick checks the daemon's map.

### Existing pattern: notification round-trip (Phase 5, `daemon/main.cjs:336-357`)

```javascript
const requestApproval = ({ command, bot: approvalBot }) => {
  // ... pendingApprovals.set(shellId, { resolve, reject, timer, command, bot, notify: sendNotification }) ...
  sendNotification('shell:request-approval', { shellId, command, bot: approvalBot, ts: Date.now() });
};
```

**Phase 6 extension:** Phase 6's `notification:scheduled-error` is the inverse direction: daemon → main → Windows toast. The `sendNotification` function is reused; main's `spawn.ts#onNotification` is the bridge.

### Existing pattern: AppModal primitive (Phase 4, `src/renderer/components/AppModal.tsx`)

**Phase 6 extension:** No change. The Schedule tab in `BotSettingsPage` is a form, not a modal.

### Existing pattern: `bots/trigger` JSON-RPC method (Phase 4, `daemon/main.cjs:734-823`)

**Phase 6 extension:** The cron tick handler calls `runSendMessageCycle` directly (NOT through `bots/trigger` JSON-RPC). The handler IS the daemon; no JSON-RPC round-trip needed. The `RunRecord` row written by `runSendMessageCycle` is `{trigger: 'cron', ...}` (Phase 6 adds the 'cron' variant to the trigger union).

### New pattern: cron tick handler with conflict check

```javascript
// daemon/scheduler/index.cjs (excerpt)
async function onCronTick(userDataDir, bot, ctx) {
  const startedAt = Date.now();

  // Cross-check: skip if a manual or scheduled run is already in flight.
  for (const [runId, _ctrl] of ctx.activeRuns) {
    const botOfRun = ctx.activeRunBots ? ctx.activeRunBots.get(runId) : null;
    if (botOfRun === bot) {
      ctx.appendAudit({
        tool: 'scheduler.tick',
        bot,
        params: { outcome: 'skipped', reason: 'run_in_progress' },
        outcome: 'error',
        durationMs: Date.now() - startedAt,
      });
      return;
    }
  }

  const runId = crypto.randomUUID();
  const prompt = (ctx.getBotScheduledPrompt && ctx.getBotScheduledPrompt(bot)) ||
                 '[Scheduled run] Perform your regular check-in.';
  const cycle = await ctx.runSendMessageCycle(userDataDir, bot, prompt, runId, new AbortController().signal);
  lastFire.set(bot, new Date().toISOString());
  await persistSchedules(userDataDir);

  if (cycle.exitReason === 'errored' && ctx.getBotNotifyOnError(bot) !== false) {
    ctx.sendNotification('notification:scheduled-error', {
      bot,
      runId,
      errorMessage: cycle.errorPayload ? cycle.errorPayload.message : 'unknown error',
      ts: new Date().toISOString(),
    });
  }
}
```

### New pattern: croner task with protect + local timezone

```javascript
// daemon/scheduler/index.cjs (excerpt)
const { Cron } = await ensureCroner();

const task = new Cron(cronExpr, {
  protect: true,
  name: `bot:${bot}`,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
}, async () => {
  await onCronTick(userDataDir, bot, ctx);
});
```

### New pattern: Electron Notification in main

```typescript
// src/main/ipc/notifications.ts (NEW)
import { Notification } from 'electron';
import { CHANNELS } from '../../shared/ipc-channels';

type ScheduledErrorPayload = {
  bot: string;
  runId: string;
  errorMessage: string;
  ts: string;
};

export function handleScheduledError(payload: ScheduledErrorPayload): void {
  if (!Notification.isSupported()) return; // headless / no libnotify
  const botName = payload.bot; // Phase 6 reads the name from the payload; main looks it up if needed
  const notification = new Notification({
    title: `Bot errored: ${botName}`,
    body: payload.errorMessage.slice(0, 120),
    silent: false,
  });
  notification.on('click', () => {
    // Phase 1's createMainWindow is imported here.
    const win = BrowserWindow.getAllWindows()[0] || require('../window').createMainWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(CHANNELS.EVENT_NAVIGATE_TO_BOT, { botId: payload.bot });
  });
  notification.show();
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `cron` + `cronEnabled` in `config.json` but unused | `daemon/scheduler/index.cjs` reads `<userData>/scheduler.json` + `config.json#cron` + runs `croner` per bot | Phase 6 | Bots run unattended on user-defined schedules |
| Per-bot shell approval modal pops for any exec_command | Same — scheduled runs inherit Phase 5 approval (no bypass) | Phase 6 | Cron = unattended timing, not unattended authority |
| No system notifications on bot errors | Electron `Notification` API in main fires on `trigger === 'cron' && exitReason === 'errored' && notifyOnError !== false` | Phase 6 | User is alerted when a scheduled bot fails while away |
| `setTimeout` re-scheduling for periodic work | `croner@^9.0.0` with `protect: true`, local timezone, async handlers | Phase 6 | DST + sleep/wake + manual + scheduled conflicts handled correctly |
| Sidebar `status: 'scheduled'` defined in union but never emitted | Daemon emits on transition when next-fire within 60s | Phase 6 | Sidebar pulses blue before each fire |
| `RunRecord.trigger: 'manual'` only | Extended to `'manual' | 'cron'` | Phase 6 | Run history distinguishes user-initiated vs scheduled runs |
| Per-bot shell approval (Phase 5) | Same — scheduled runs respect the modal | Phase 6 | No new shell authority; future phase may add auto-approve for scheduled bots |

**Deprecated/outdated:**
- **No scheduler.** Phase 6 introduces cron evaluation; before, `cron` was a dormant config field.
- **No system notifications on errors.** Phase 6 introduces the toast; before, errors only surfaced in the chat pane (visible only when the app was foregrounded).

---

## Assumptions Log

> Claims tagged `[ASSUMED]` need user confirmation before becoming locked decisions. The planner should surface these in discuss-phase if needed.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Cron evaluation lives in the daemon process, not main or renderer | Claude's Discretion | If user prefers main-side cron (closer to OS-level scheduling), Phase 6 moves the timer; renderer stays subscribed to status events |
| A2 | `croner@^9.0.0` is the right cron library (vs `node-cron` or `setTimeout`) | Claude's Discretion, Standard Stack | If user prefers `node-cron`, the codebase adds it; semantic behavior is similar |
| A3 | Electron `Notification` API (not `node-notifier`) for system notifications | Claude's Discretion | If user prefers `node-notifier`, the codebase adds it; toast routing is slightly weaker on Windows |
| A4 | Scheduled bot runs DO NOT bypass the shell approval modal | Locked Decisions from Phase 5 | If user wants cron to bypass approval, Phase 6 grows a "scheduled-shell-allowlist" config; out of scope |
| A5 | Missed-while-offline fires are dropped (CLAUDE.md 24/7 assumption) | Claude's Discretion | If user wants catch-up fires, Phase 6 adds a backfill loop on `initialize`; complex + risks firehose |
| A6 | `<userData>/scheduler.json` (cross-bot) vs per-bot `schedule.json` | Architecture Patterns | If user prefers per-bot, the codebase adds one file per bot; harder to debug |
| A7 | Only ONE scheduled run per bot at a time (skip-with-log on conflict) | Claude's Discretion | If user wants queueing, the codebase adds a queue; matches `activeRuns` cross-check |
| A8 | `notifyOnError` defaults to `true` for existing bots (where field is undefined) | Pattern 2 | If user prefers opt-in (default false), existing bots won't notify; user must toggle on |
| A9 | `scheduledPrompt` defaults to `[Scheduled run] Perform your regular check-in.` | Pattern 2 | If user wants a more elaborate default, the codebase changes the constant; user can always override |
| A10 | Cron uses system local timezone (via `Intl.DateTimeFormat().resolvedOptions().timeZone`) | Pitfall 10 | If user wants per-bot timezone, Phase 6 adds `cronTimezone?` field; out of scope |
| A11 | `bot:status {status: 'scheduled'}` fires when next-fire within 60s | Architecture | If user wants a different threshold, the daemon code changes |
| A12 | Notification click focuses the window + navigates to the bot's chat pane | Pattern 3 | If user wants click-to-open-only (no navigate), the click handler is simpler |
| A13 | Notification title format is `Bot errored: <bot.name>` | Pattern 3 | If user wants a different format, the title string is one line |
| A14 | `notification:scheduled-error` is a daemon → main notification (not a JSON-RPC method) | Claude's Discretion | If user prefers JSON-RPC semantics (with a response), the envelope changes |
| A15 | `app.setAppUserModelId('com.localbot.app')` is the AppUserModelID | Pitfall 6 | If user has a different bundle id preference, the constant changes |
| A16 | Audit minimization: scheduled fires use `{runId, trigger: 'cron', messageCount}` (same as manual) | Architecture | If user wants a distinct audit shape (e.g., separate `bots.cron.fire` tool name), the audit row changes |
| A17 | The renderer is responsible for showing the cron preview ("Next fire: <ISO>") in the settings tab | Architecture | If user prefers the daemon to send the next-fire timestamp, the IPC bridge adds `scheduler/next` |
| A18 | `bots/delete` removes the schedule for the deleted bot | Pitfall (anti-pattern) | If user wants to keep the schedule after bot delete (unlikely), the code path changes |

**If this table is empty:** All claims were verified or cited — no user confirmation needed. (This table is non-empty: items A1–A18 are `[ASSUMED]` from training knowledge + Phase 1+2+3+4+5 patterns + `croner` 9.x docs from training. The high-risk items are A5 [missed fires dropped] and A8 [notifyOnError default]. Planner should surface these in discuss-phase.)

---

## Open Questions (RESOLVED)

1. **Should scheduled runs bypass the shell approval modal?**
   - What we know: Phase 5's modal blocks on `requestApproval`. A scheduled bot at 3 AM can't get past it without a human.
   - What's unclear: Whether the user wants cron to bypass approval (trust the schedule) or to respect it (cron = unattended timing only).
   - Recommendation: Respect the modal (locked Phase 5 decision). User can pre-add commands to the bot's always-allow list. A future phase may add "auto-approve for scheduled runs only".
   - **RESOLVED** (2026-09-19): Decision = respect the modal (no bypass). Locked by Phase 5 decision; Phase 6 does NOT add an auto-approve-routine path. Future-phase hook documented in Deferred Ideas. No code change required in Phase 6.

2. **Should missed-while-offline fires catch up on app start?**
   - What we know: CLAUDE.md says PC stays on 24/7. `croner` doesn't catch up by default.
   - What's unclear: Whether a 3-day offline period should fire 3 days of catch-up runs (could be hundreds) or just the next single fire.
   - Recommendation: Drop missed fires; fire only the next single fire after reopen. Matches the CLAUDE.md 24/7 assumption. A future phase may add "catch up on app start" as an opt-in.
   - **RESOLVED** (2026-09-19): Decision = drop missed fires. `croner.nextRun()` computes from the expression, not from `lastFireAt`; `lastFireAt` is UI-display-only. Pitfall 2 mitigation already implemented in `06-01-PLAN.md`. No catch-up loop added.

3. **What timezone should cron expressions use?**
   - What we know: `croner` defaults to UTC unless `timezone` is specified. Users expect local time.
   - What's unclear: Whether per-bot timezone override is needed in v1.
   - Recommendation: System local timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone`. A future phase may add per-bot `cronTimezone?` field.
   - **RESOLVED** (2026-09-19): Decision = system local timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone`. Pitfall 10 mitigation already implemented in `06-01-PLAN.md` Task 1 `upsertSchedule`. Per-bot override deferred to a future phase (listed in Deferred Ideas).

4. **What should the default `scheduledPrompt` be?**
   - What we know: The bot's LLM-driven turn needs a user message. An empty message would confuse the SDK.
   - What's unclear: Whether the default should be a friendly check-in ("perform your regular check-in") or something more functional ("review recent activity and flag anything urgent").
   - Recommendation: `'[Scheduled run] Perform your regular check-in.'` — neutral, lets the bot's persona drive the actual behavior. User can override per-bot.
   - **RESOLVED** (2026-09-19): Decision = `'[Scheduled run] Perform your regular check-in.'` (matches `DEFAULT_SCHEDULED_PROMPT` in `daemon/scheduler/index.cjs` per Pattern 1 / Pitfall anti-pattern guidance). User can override per-bot via `scheduledPrompt` field.

5. **Should the notification include a "Snooze for 1 hour" button?**
   - What we know: Electron `Notification` supports `actions: [{type: 'button', text: 'Snooze'}]` on macOS/Linux but NOT on Windows (Windows toasts have no inline actions).
   - What's unclear: Whether cross-platform snooze is worth the complexity.
   - Recommendation: No snooze in v1. Click focuses the window; the user can disable the schedule from there.
   - **RESOLVED** (2026-09-19): Decision = no snooze button in v1 (Windows toasts lack inline actions; cross-platform snooze adds complexity without v1 benefit). Listed in Deferred Ideas. Phase 6 click behavior remains: focus window + navigate to bot's chat pane.

6. **Should we expose a "Run history filter: trigger === 'cron'" UI?**
   - What we know: Phase 4's `RunHistoryTable` shows all runs. Adding a filter is a small UI tweak.
   - What's unclear: Whether the user wants a filter (vs just sorting newest-first).
   - Recommendation: Yes — add a dropdown filter `{All, Manual, Cron}` to the RunHistoryTable. Matches the new `trigger: 'cron'` data.
   - **RESOLVED** (2026-09-19): Decision = add the `{All, Manual, Cron}` filter dropdown in `RunHistoryTable`. Listed in Deferred Ideas as deferred to a small follow-up phase — `06-03-PLAN.md` Task 1 only adds the `trigger:'cron'` label case for v1; the filter UI is explicitly out of Phase 6 scope (would require a Plan 3 expansion or a small follow-up plan).

7. **What should happen if the bot's `config.json#cron` is set but `config.json#cronEnabled` is `false`?**
   - What we know: `cronEnabled: false` means the bot should NOT be scheduled.
   - What's unclear: Whether the daemon should still persist the entry in `<userData>/scheduler.json` (so the renderer can show "scheduled but disabled") or skip persistence entirely.
   - Recommendation: Persist the entry with `enabled: false`; the daemon reads `enabled` at `loadScheduler` time and skips starting a croner task. The renderer reads `config.json#cronEnabled` for display.
   - **RESOLVED** (2026-09-19): Decision = persist the entry with `enabled: false` in `<userData>/scheduler.json`; `loadScheduler` skips starting a croner task for `enabled:false` entries (Pitfall 8 mitigation already in `06-01-PLAN.md` Task 1). The renderer reads `bot.cronEnabled` from `config.json` for display. `bots/update` with `cronEnabled:false` calls `upsertSchedule(..., {enabled:false})` which deletes from `schedules` map AND persists the empty row.

8. **Should scheduled runs appear in the chat pane?**
   - What we know: Manual runs create a chat session the user can scroll back through. Scheduled runs create the same session shape but the user wasn't there.
   - What's unclear: Whether the chat pane should show scheduled runs (with a `[Scheduled]` badge?) or hide them.
   - Recommendation: Show them — they're real runs with real messages; the `trigger: 'cron'` badge on the session header makes the origin clear. The user can scroll back to see what the bot did at 3 AM.
   - **RESOLVED** (2026-09-19): Decision = show scheduled runs in the chat pane with a `[cron]` trigger label (via the `RunHistoryTable` extension in `06-03-PLAN.md` Task 1 — `'cron'` case in the trigger label switch). Sessions are auto-named by ISO timestamp; concurrent cron fires never collide on disk.

---

## Environment Availability

> Step 2.6: per the protocol, this section is required for phases with external dependencies. Phase 6's external dependencies are `croner` (npm package), Electron's `Notification` API (built-in), and Windows Action Center (OS-level).

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `croner` (npm) | Cron expression parsing + scheduling | ✓ (after `npm install croner@^9.0.0`) | `^9.0.0` | — |
| Electron `Notification` API | Windows toast notifications | ✓ | ships with `electron@^33.2.0` | `Notification.isSupported()` returns false on headless Linux without libnotify; main logs to console instead |
| `app.setAppUserModelId` | Windows toast grouping | ✓ | ships with Electron | — |
| Windows 11 Action Center | Toast receiver | ✓ | Windows 11 Pro 10.0.26200 (env) | macOS Notification Center / Linux libnotify (Electron handles cross-platform) |
| Node 20+ stdlib `node:crypto` | runId generation | ✓ | per `@types/node: ^20.11.0` | — |
| Phase 4 `bots/trigger` JSON-RPC | Scheduled run dispatch | ✓ | all in place from prior phases | — |
| Phase 4 `config.json` + `ALLOWED_CONFIG_KEYS` | Schedule persistence | ✓ | `daemon/bots/loader.cjs` lines 19-34 | — |
| Phase 4 `activeRuns` + `activeRunBots` maps | Trigger conflict detection | ✓ | `daemon/main.cjs` lines 14-18 | — |
| Phase 4 `runSendMessageCycle` | Scheduled bot run cycle | ✓ | `daemon/main.cjs` lines 32-111 | — |
| Phase 5 `requestApproval` round-trip | Shell approval during scheduled runs | ✓ | `daemon/main.cjs` lines 336-357 | — |
| `<userData>/scheduler.json` write target | Schedule persistence | ✓ | `<userData>` is Phase 1's standard path | — |

**Missing dependencies with no fallback:** none — all covered by Phase 1+2+3+4+5 stack + one npm install (`croner`).

**Missing dependencies with fallback:**
- Electron `Notification.isSupported()` returning false (headless Linux without libnotify): main logs to console; renderer-side `bot:status` updates are still authoritative. Acceptable for the v1 single-Windows-user product.

*All Phase 6 capabilities are deliverable with the existing toolchain + Node 20+ stdlib + Electron 33 Notification API + one new npm dep (`croner`).*

---

## Validation Architecture

> `workflow.nyquist_validation` — assume enabled per GSD defaults. Full section included.

### Test Framework

| Property | Value |
|----------|-------|
| **Framework** | Vitest `^2.1.9` (unit) + Playwright `^1.63.0` (Electron + daemon smoke) |
| **Config files** | `vitest.config.ts` (Node env, includes `tests/unit/**`), `playwright.config.ts` |
| **Quick run command** | `npm test` (Vitest unit, ~20 s with the 2 new suites) |
| **Full suite command** | `npm run test:all` (Vitest + Playwright daemon smoke, ~60 s) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AGENT-09 | `croner` task starts for each enabled schedule on `initialize` | unit | `npx vitest run tests/unit/scheduler_index.test.ts` | Wave 0 |
| AGENT-09 | `upsertSchedule` adds a new croner task + persists to `scheduler.json` | unit | covered by `scheduler_index.test.ts` | Wave 0 |
| AGENT-09 | `removeSchedule` stops the croner task + removes from disk | unit | covered by `scheduler_index.test.ts` | Wave 0 |
| AGENT-09 | Cron tick handler calls `runSendMessageCycle` with the scheduled prompt | unit | covered by `scheduler_index.test.ts` | Wave 0 |
| AGENT-09 | Cron tick handler skips when `activeRuns` has a run for the bot | unit | covered by `scheduler_index.test.ts` | Wave 0 |
| AGENT-09 | `config.json#cron` regex validation rejects malformed expressions | unit | covered by `bot_config.test.ts` (extended) | Wave 0 |
| AGENT-09 | `bots/update` patches `cron` + `cronEnabled` + `notifyOnError` + `scheduledPrompt` | unit | covered by `bot_config.test.ts` (extended) | Wave 0 |
| AGENT-09 | `bots/delete` removes the bot's schedule | unit | covered by `scheduler_index.test.ts` | Wave 0 |
| AGENT-09 | Sidebar renders `status: 'scheduled'` dot | smoke | covered by `scheduler.test.ts` | Wave 0 |
| AGENT-09 | Schedule tab UI: cron input + enabled checkbox + notifyOnError + scheduledPrompt + next-fire preview | smoke | covered by `scheduler.test.ts` | Wave 0 |
| AGENT-10 | Scheduled bot error fires `notification:scheduled-error` event | unit | covered by `scheduler_index.test.ts` | Wave 0 |
| AGENT-10 | Manual trigger error does NOT fire `notification:scheduled-error` (Pitfall 9) | unit | covered by `scheduler_index.test.ts` | Wave 0 |
| AGENT-10 | Main `handleScheduledError` constructs Electron Notification with title + body | unit | covered by `notifications.test.ts` | Wave 0 |
| AGENT-10 | Notification click focuses the window + emits `EVENT_NAVIGATE_TO_BOT` | smoke | covered by `scheduler.test.ts` | Wave 0 |
| AGENT-10 | `notifyOnError: false` suppresses the notification | unit | covered by `scheduler_index.test.ts` | Wave 0 |
| AGENT-09 | `RunRecord.trigger: 'cron'` appears in run history | smoke | covered by `scheduler.test.ts` | Wave 0 |
| AGENT-09 | `app.setAppUserModelId('com.localbot.app')` is called at startup | smoke | covered by `scheduler.test.ts` (assertion on app id) | Wave 0 |

### Sampling Rate

- **Per task commit:** `npm test` (Vitest unit only, ~20 s with the 2 new suites)
- **Per wave merge:** `npm run test:all` (Vitest + Playwright daemon smoke, ~60 s)
- **Phase gate:** Full suite green before `/gsd-verify-work`; headed Electron smoke (`LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/scheduler.test.ts`) deferred to developer machine per Phase 1+2+3+4+5 precedent.

### Wave 0 Gaps

- [ ] `tests/unit/scheduler_index.test.ts` — covers `loadScheduler` rehydration, `upsertSchedule`, `removeSchedule`, cron tick handler (fires + skips + emits notification); uses a mock `runSendMessageCycle` so the test doesn't need the Anthropic SDK
- [ ] `tests/unit/scheduler_croner.test.ts` — covers croner expression parsing (5-field + 6-field), `next()` math across DST, `protect: true` semantics (two simultaneous fires)
- [ ] `tests/unit/bot_config.test.ts` (extended) — covers `notifyOnError` + `scheduledPrompt` validation; cron regex validation; `bots/update` patch with cron
- [ ] `tests/unit/notifications.test.ts` — covers `handleScheduledError` constructs Notification with correct title + body; click handler focuses window + sends `EVENT_NAVIGATE_TO_BOT` (uses a mocked BrowserWindow)
- [ ] `tests/playwright/scheduler.test.ts` — full vertical: enable cron on a bot with `*/1 * * * *` (every minute); wait for fire; verify RunRecord `trigger: 'cron'`; force an error path; verify `notification:scheduled-error` event in main; verify Notification API call; click the toast (headed smoke) → verify window focuses + chat pane switches

*(If no gaps: "None — existing test infrastructure covers all phase requirements" — N/A here; 2 new unit suites + 1 extended unit suite + 1 new Playwright suite are required.)*

---

## Security Domain

> `security_enforcement` is absent from `.planning/config.json` — treat as enabled (default per GSD config schema).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | partial | API key in OS keychain (Phase 1); scheduled runs use the same key as manual; no privilege escalation |
| V3 Session Management | yes | Per-runId AbortController (Phase 4) is reused; cancel mid-execution works for scheduled runs the same way as manual |
| V4 Access Control | yes | Per-bot allowlist (Phase 4); cron fires use the same `bots/trigger` path; same per-bot policy applies |
| V5 Input Validation | yes | Cron regex validation in `validateConfig`; `croner` rejects malformed expressions via `CronExpressionError`; scheduledPrompt is a string (capped at 4 KB by Phase 3's input cap pattern) |
| V6 Cryptography | no | Phase 6 doesn't add crypto; scheduler state is plaintext JSON |
| V7 Error Handling | yes | Cron lifecycle ops log audit lines; tick handler logs `outcome: 'skipped', reason: 'run_in_progress'` on conflict; errored runs log `outcome: 'error'` + emit notification |
| V9 Communication | yes | All scheduler events flow through the existing JSON-RPC over NDJSON transport (Phase 1 D-10/D-11); notification event is a daemon → main notification (same transport) |
| V12 File Integrity | yes | Atomic `tmp + rename` for `<userData>/scheduler.json` writes (Phase 4 pattern); `config.json` updates reuse Phase 4's atomic path |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Renderer fabricates a scheduled fire by emitting `bot:status {status: 'scheduled'}` | Tampering | Renderer cannot drive the timer (Anti-pattern: cron in renderer); daemon is the only owner; renderer events are visual-only |
| Scheduler fires a deleted bot | Tampering | `bots/delete` routes through `scheduler.removeSchedule` (Pitfall anti-pattern); cross-checked at tick time via `botLoader.botExists` |
| Cron expression with `* * * * *` floods the bot | Denial of Service | `croner` `protect: true` + cross-check `activeRuns` prevents two fires from running concurrently; `*/1 * * * *` still works but produces one fire per minute with no overlap |
| User edits `<userData>/scheduler.json` by hand to enable a disabled schedule | Tampering | Re-renders the file from `schedules` (in-memory map) on every `persistSchedules`; manual edits are overwritten on next `bots/update` |
| User edits `<userData>/scheduler.json` to inject a fake `notifyOnError: false` on a bot that has it `true` | Tampering | `loadScheduler` reads `notifyOnError` from `config.json`, not `scheduler.json` (single source of truth per Pitfall 8); the file is a cache of in-memory state |
| Notification spoofing (a malicious renderer emits `notification:scheduled-error`) | Spoofing | Daemon emits the event; renderer cannot (Anti-pattern: cron in renderer); main listens to daemon notifications only |
| Notification click hijack (a malicious renderer subscribes to `EVENT_NAVIGATE_TO_BOT` and overrides) | Tampering | The event carries `{botId}`; renderer's existing `setActiveBotId` updates the active bot — there's no privileged action that could be hijacked |
| Scheduled run uses `exec_command` and waits for approval modal that never arrives | Denial of Service | Phase 5's `APPROVAL_TIMEOUT_MS = 5 * 60 * 1000` rejects after 5 minutes; the bot run continues with `exitReason: 'errored'`; Phase 6 fires the notification |
| Scheduled run sends secrets via `scheduledPrompt` (e.g., AWS keys) | Information Disclosure | `scheduledPrompt` is persisted to disk in `config.json`; Phase 4's audit minimization for `bots/update` does NOT log prompt content (T-P4-22); the user is responsible for what's in the prompt; document this in the settings tab tooltip |
| Cron in user's non-local timezone (e.g., cron expression written assuming UTC but daemon runs in EST) | Repudiation | `Intl.DateTimeFormat().resolvedOptions().timeZone` sets `croner` to system local time; tooltip in settings tab explains this |
| Toast click fails because BrowserWindow was destroyed | Denial of Service | Click handler calls `createMainWindow()` if `BrowserWindow.getAllWindows()[0]` is missing; window is recreated from the canonical Phase 1 helper |
| `croner` v9 throws `CronExpressionError` at runtime (e.g., DST edge case) | Denial of Service | Constructor wrapped in try/catch (Pitfall 1); invalid cron rejects `bots/update` with `code: 'invalid_cron'` |
| Concurrent `bots/update` calls race the `<userData>/scheduler.json` write | Tampering | `persistSchedules` is serialized via a promise chain (Pitfall 12); atomic `tmp + rename` ensures the final write is coherent |
| `app.setAppUserModelId` not called → Windows toasts group under "Electron" | Repudiation | Called once at app startup in `createMainWindow` (Pitfall 6); user sees "Localbot" in Action Center |

---

## Sources

### Primary (HIGH confidence)

- `.planning/PROJECT.md` — phase scope, locked decisions, constraints (read this session)
- `.planning/REQUIREMENTS.md` — AGENT-09, AGENT-10 definitions (read this session)
- `.planning/ROADMAP.md` — Phase 6 success criteria + dependency on Phase 4+5 (inherited from STATE.md)
- `.planning/STATE.md` — accumulated decisions, debug history (read this session)
- `.planning/phases/05-shell-exec-with-approval/05-RESEARCH.md` — Phase 5 patterns: `requestApproval` round-trip, audit minimization, AppModal primitive (read this session)
- `.planning/phases/04-multi-bot-crud-sidebar/04-RESEARCH.md` — Phase 4 patterns: per-bot config.json + ALLOWED_CONFIG_KEYS, bots/* JSON-RPC, runId AbortController, RunRecord shape (read this session)
- `daemon/main.cjs` — JSON-RPC envelope, `bots/trigger`, `bots/update`, `bots/cancel`, `runSendMessageCycle`, `activeRuns` + `activeRunBots` maps, `requestApproval`, audit appendAudit (read this session)
- `daemon/bots/loader.cjs` — `ALLOWED_CONFIG_KEYS`, `validateConfig`, `writeConfigPatch`, atomic `tmp + rename`, `ID_REGEX` (read this session)
- `src/main/ipc/bots.ts` — `BOTS_TRIGGER` + `BOTS_UPDATE` handlers, per-runId AbortController, `EVENT_BOT_STATUS` broadcast (read this session)
- `src/shared/ipc-channels.ts` — `CHANNELS` registry (read this session)
- `src/shared/types.ts` — `BotConfig`, `RunRecord`, `BotStatus`, `BotTriggerRequest`, `BotUpdateRequest` (read this session)
- `src/renderer/state/bots.ts` — module-scope store + `EVENT_BOT_LIST_UPDATED` + `EVENT_BOT_STATUS` subscriptions, `updateBot` action (read this session)
- `src/main/preload/index.ts` — `contextBridge` + `window.localbot` surface + `EVENT_CHANNELS` set (read this session)
- `src/main/paths.ts` — `userDataDir()` + `botsDir()` + `botDir(bot)` helpers (read this session)
- `src/renderer/components/BotSettingsPage.tsx` — Schedule tab UI (cron text input + cronEnabled checkbox already present) (read this session)
- `package.json` — dependencies (read this session)

### Secondary (MEDIUM confidence)

- `croner` v9 documentation — `new Cron(expr, opts, handler)` signature, `protect: true` flag, `nextRun()` math, `CronExpressionError`, timezone option — recalled from training knowledge + standard cron library references; the planner should run `npm view croner version` after install to confirm v9.x is current.
- Electron `Notification` API documentation — `new Notification({title, body, silent})`, `.show()`, `.on('click', handler)`, `Notification.isSupported()`, `app.setAppUserModelId(id)` — recalled from training + standard Electron 33.x docs; the planner should verify against the local `node_modules/electron/electron.d.ts` after install.
- Windows Action Center AppUserModelID conventions — `com.<vendor>.<app>` format — recalled from training; standard Windows toast pattern.

### Tertiary (LOW confidence)

- croner 9.x async constructor vs sync constructor pitfall (Pitfall 1) — inferred from training; verify by reading the local `node_modules/croner/dist/croner.d.ts` after install.

---

## Metadata

**Confidence breakdown:**

- **Standard stack:** MEDIUM — `croner` is verified by training + npm registry knowledge, but the exact 9.x API surface needs verification via `npm view croner version` + reading the post-install `node_modules/croner/dist/croner.d.ts`. Electron `Notification` is verified by training + Electron docs but the exact event names (`'click'` vs `'show'`) need a quick check against the local `electron.d.ts`.
- **Architecture:** HIGH — Phase 1+2+3+4+5 patterns read this session (`daemon/main.cjs`, `daemon/bots/loader.cjs`, `src/main/ipc/bots.ts`, `src/main/preload/index.ts`, `src/shared/{ipc-channels,types}.ts`, `src/renderer/state/bots.ts`, `src/renderer/components/BotSettingsPage.tsx`, `src/main/paths.ts`); Phase 6 is purely additive on the existing layers; `daemon/scheduler/index.cjs` is a new module that imports the existing `botLoader`, `audit`, `appendRun`, `runSendMessageCycle` — no new transport, no new envelope.
- **Pitfalls:** HIGH — derived from reading actual Phase 1+2+3+4+5 code + the unique threats of cron evaluation (`protect: true` semantics, DST transitions, app-restart catch-up), notification delivery (AppUserModelID, BrowserWindow reference, click handlers), and bot config schema extension (cron regex validation, optional fields with default true).
- **Validation architecture:** HIGH — follows Phase 1+2+3+4+5's Vitest + Playwright pattern (proven in `tests/playwright/bot-crud.test.ts`, `tests/playwright/shell-approval.test.ts`, `tests/playwright/memory-history.test.ts`, `tests/playwright/tree-diff.test.ts`).

**Research date:** 2026-09-19
**Valid until:** 2026-10-19 (30 days — `croner` 9.x is stable; Electron `Notification` API has not changed since Electron 4; the locked Phase 1+2+3+4+5 patterns are stable from the executed plans; `Intl.DateTimeFormat` API is universally available in Node 20+.)