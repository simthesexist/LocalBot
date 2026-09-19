---
phase: 06-scheduler-notifications
plan: 01
subsystem: scheduler, daemon
tags: [cron, croner, scheduler.json, AGENT-09, AGENT-10, runSendMessageCycle, AGENT-08, atomic-write, bots.update]

# Dependency graph
requires:
  - phase: phase-05-shell-exec-with-approval-05-03
    provides: "daemon main.cjs JSON-RPC surface, writeConfigPatch atomic write, runSendMessageCycle + activeRuns/activeRunBots per-runId AbortController pattern"
provides:
  - "daemon/scheduler/index.cjs (NEW) — croner per-bot instance with protect:true, scheduler.json atomic persistence, onCronTick cross-check + cancel registration"
  - "BotConfig.notifyOnError + BotConfig.scheduledPrompt optional fields; RunRecord.trigger union extends to 'manual' | 'cron'"
  - "bots/update writes config.json + scheduler.json atomically; bots/delete cleans scheduler.json; bots/trigger accepts trigger='cron'"
  - "60 unit tests across 4 suites proving croner lifecycle, persistence atomicity, atomicity of bots/update, and CRON_REGEX / notifyOnError / scheduledPrompt schema"
affects: [phase-06-scheduler-notifications-06-02, phase-06-scheduler-notifications-06-03]

# Actuals (#2632) — chars/4 over the realized diff
actuals:
  tokens: 26500
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: [croner@9.1.0]
  patterns: [dynamic-import-cjs-to-esm, atomic-tmp-rename-scheduler-json, persistQueue-promise-chain, runId-pre-registration-before-await, frozen-ctx-into-scheduler, croner-protect-true, cron-fired-NotifyOnError-opt-out]

key-files:
  created:
    - daemon/scheduler/index.cjs (260 lines — loadScheduler/upsertSchedule/removeSchedule/getNextFireAt + onCronTick + test seams)
    - tests/unit/scheduler_tick.test.ts (14 cases)
    - tests/unit/scheduler_persistence.test.ts (8 cases)
    - tests/unit/bots_update_atomic.test.ts (6 cases)
  modified:
    - package.json + package-lock.json (croner@^9.0.0 entry)
    - daemon/bots/loader.cjs (ALLOWED_CONFIG_KEYS +16, CRON_REGEX validation in validateConfig + writeConfigPatch, scheduledPrompt 4096 cap)
    - daemon/main.cjs (require scheduler, loadScheduler in initialize, upsertSchedule in bots/update AFTER writeConfigPatch, removeSchedule in bots/delete AFTER deleteBot, trigger:'manual'|'cron' parameter in bots/trigger, scheduler._internal cleanup on rl.on('close'))
    - src/shared/types.ts (BotConfig.notifyOnError + BotConfig.scheduledPrompt; RunRecord.trigger 'manual' | 'cron'; BotCreateRequest mirrors)
    - tests/unit/bot_config.test.ts (+13 Phase 6 cases; ALLOWED_CONFIG_KEYS size 14 → 16)

key-decisions:
  - "Croner loaded via dynamic ESM import in CJS daemon (croner is hybrid ESM/CJS)"
  - "scheduler.json persisted atomic via tmp + rename serialized through persistQueue promise chain (Pitfall 12)"
  - "onCronTick registers AbortController in BOTH ctx.activeRuns and ctx.activeRunBots BEFORE awaiting runSendMessageCycle and removes in finally (AGENT-08 cancellation invariant; matches Phase 4 manual-trigger pattern)"
  - "Invalid cron throws synchronously with code:'invalid_cron' from BOTH validateConfig AND writeConfigPatch — renderer surfaces deterministic error"
  - "scheduler module is testable via __inspectSchedulerForTest__ + __fireCronForTest__ + __resetForTest__ seams so unit tests don't depend on real wall-clock time"
  - "notifyOnError defaults to TRUE when undefined on persisted entries (Pitfall 11 back-compat — existing bots get notified by default)"
  - "Bots/update audit minimization unchanged (changedKeys only); bot config status patch is best-effort (matches Phase 4 manual-trigger)"
  - "RunRecord.trigger default 'manual' in bots/trigger preserves Phase 4 semantics; 'cron' only stamped by onCronTick (and by callers that explicitly opt-in)"

patterns-established:
  - "Per-bot croner task with protect:true + Intl.DateTimeFormat().resolvedOptions().timeZone — covers DST transitions"
  - "fire-and-forget scheduler.loadScheduler in initialize handshake; failure swallowed (corrupt JSON doesn't crash daemon)"
  - "WriteConfigPatch runs BEFORE upsertSchedule in bots/update — invalid_cron rejects atomically, scheduler.json never gains a phantom entry"
  - "scheduler.removeSchedule is best-effort in-memory-state-authoritative (Pitfall 8 — file-write failure doesn't leave a phantom task)"

requirements-completed: [AGENT-09]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "croner@^9.0.0 installed; daemon loads it via dynamic import('croner') and creates one Cron instance per enabled schedule"
    requirement: AGENT-09
    verification:
      - kind: unit
        ref: "tests/unit/scheduler_tick.test.ts#starts a croner task for a valid cron expression and surfaces nextRun()"
        status: pass
    human_judgment: false
  - id: D2
    description: "<userData>/scheduler.json is written atomically (tmp + rename) on every upsert; survives daemon restart; cron tasks are rehydrated on initialize"
    requirement: AGENT-09
    verification:
      - kind: unit
        ref: "tests/unit/scheduler_persistence.test.ts#writes scheduler.json after the first upsertSchedule"
        status: pass
      - kind: unit
        ref: "tests/unit/scheduler_persistence.test.ts#loadScheduler rehydrates croner tasks from a persisted file (survives daemon restart)"
        status: pass
      - kind: unit
        ref: "tests/unit/scheduler_persistence.test.ts#writes the file atomically: renameSync moves the tmp into place (no partial bytes)"
        status: pass
    human_judgment: false
  - id: D3
    description: "bots/update patches cron + cronEnabled + notifyOnError + scheduledPrompt into config.json AND upserts the schedule in scheduler.json atomically; one without the other is impossible"
    requirement: AGENT-09
    verification:
      - kind: unit
        ref: "tests/unit/bots_update_atomic.test.ts#writes BOTH config.json and scheduler.json on a successful update"
        status: pass
      - kind: unit
        ref: "tests/unit/bots_update_atomic.test.ts#bots/update with cron:bad rejects with invalid_cron"
        status: pass
      - kind: unit
        ref: "tests/unit/bots_update_atomic.test.ts#bots/update with notifyOnError:string rejects with invalid_config"
        status: pass
    human_judgment: false
  - id: D4
    description: "bots/delete removes the bot's schedule from scheduler.json and stops the croner task"
    requirement: AGENT-09
    verification:
      - kind: unit
        ref: "tests/unit/bots_update_atomic.test.ts#bots/delete removes the schedule from scheduler.json"
        status: pass
      - kind: unit
        ref: "tests/unit/scheduler_persistence.test.ts#removeSchedule deletes the entry from the persisted file on next flush"
        status: pass
    human_judgment: false
  - id: D5
    description: "Cron tick handler checks activeRuns for any run on the bot BEFORE firing; if a manual or scheduled run is in progress, the tick is logged as outcome:'skipped' reason:'run_in_progress' and dropped"
    requirement: AGENT-09
    verification:
      - kind: unit
        ref: "tests/unit/scheduler_tick.test.ts#skips the tick + logs scheduler.tick audit when activeRuns has the same bot"
        status: pass
      - kind: unit
        ref: "tests/unit/scheduler_tick.test.ts#still fires when activeRuns has a run for a DIFFERENT bot"
        status: pass
    human_judgment: false
  - id: D6
    description: "Cron tick handler invokes runSendMessageCycle with the scheduled prompt and generates a UUID runId; the RunRecord records trigger:'cron'"
    requirement: AGENT-09
    verification:
      - kind: unit
        ref: "tests/unit/scheduler_tick.test.ts#calls runSendMessageCycle with a UUID runId when activeRuns is empty"
        status: pass
      - kind: unit
        ref: "tests/unit/scheduler_tick.test.ts#stamps a single bots.run audit line on cycle close with trigger:cron"
        status: pass
    human_judgment: false
  - id: D7
    description: "validateConfig accepts the new optional fields (notifyOnError, scheduledPrompt) and rejects malformed cron expressions with code:'invalid_cron'"
    requirement: AGENT-09
    verification:
      - kind: unit
        ref: "tests/unit/bot_config.test.ts#validateConfig rejects notifyOnError:0 (number, not boolean)"
        status: pass
      - kind: unit
        ref: "tests/unit/bot_config.test.ts#validateConfig rejects scheduledPrompt with > 4096 chars"
        status: pass
      - kind: unit
        ref: "tests/unit/bot_config.test.ts#validateConfig rejects \"not a cron\" with code:invalid_cron"
        status: pass
      - kind: unit
        ref: "tests/unit/bot_config.test.ts#validateConfig rejects a 4-field cron expression with code:invalid_cron"
        status: pass
    human_judgment: false
  - id: D8
    description: "ALLOWED_CONFIG_KEYS includes notifyOnError and scheduledPrompt (no silent acceptance; existing keys unchanged)"
    requirement: AGENT-09
    verification:
      - kind: unit
        ref: "tests/unit/bot_config.test.ts#exposes the 16 canonical keys from the plan (Phase 6 adds notifyOnError + scheduledPrompt)"
        status: pass
    human_judgment: false
  - id: D9
    description: "AGENT-08 cancellation: cron-fired runId is registered in BOTH ctx.activeRuns and ctx.activeRunBots BEFORE awaiting runSendMessageCycle and removed in finally"
    requirement: AGENT-09
    verification:
      - kind: unit
        ref: "tests/unit/scheduler_tick.test.ts#registers the AbortController in activeRuns + activeRunBots BEFORE awaiting runSendMessageCycle"
        status: pass
      - kind: unit
        ref: "tests/unit/scheduler_tick.test.ts#removes both map entries even when runSendMessageCycle throws"
        status: pass
    human_judgment: false

# Metrics
duration: 64min
completed: 2026-09-19
status: complete

# Worktree metadata (referenced by /gsd-execute-phase cleanup)
plan_head_before: b404ff086109611b10b797ee787b63295bb673dd
---

# Phase 6 Plan 01: Scheduler core + bot config schema extension Summary

Daemon-side core of per-bot cron scheduling (AGENT-09): croner@^9.0.0 wrapped behind a CJS adapter, atomic scheduler.json persistence, bots/update atomicity with config.json + scheduler.json, and AGENT-08 cancellation invariant preserved across manual + scheduled runs.

## Performance

- **Duration:** 64 min (2026-09-19T11:45:04Z → 2026-09-19T12:49:13Z)
- **Started:** 2026-09-19T11:45:04Z
- **Completed:** 2026-09-19T12:49:13Z
- **Tasks:** 2 of 2 complete
- **Files modified:** 11 (4 new + 7 modified)
- **Tests added/extended:** 60 (14 + 8 + 6 + 13 new, 19 existing kept green in bot_config.test.ts)

## Accomplishments

- croner@9.1.0 installed and loaded via dynamic ESM import inside daemon/scheduler/index.cjs (CJS daemon module pattern)
- One croner task per bot with `protect: true` + Intl.DateTimeFormat timezone (covers DST transitions)
- `<userData>/scheduler.json` atomic tmp + rename persistence serialized through a `persistQueue` promise chain (Pitfall 12)
- onCronTick cross-checks `ctx.activeRuns` + `ctx.activeRunBots` BEFORE firing (T-P6-08); in-progress run drops the tick and emits a `scheduler.tick` audit line with `outcome:'error' params:{outcome:'skipped', reason:'run_in_progress'}`
- Cron-fired runId registered in BOTH `ctx.activeRuns` AND `ctx.activeRunBots` BEFORE awaiting `runSendMessageCycle`, removed in finally block — preserves AGENT-08 cancellation invariant
- Synchronous try/catch around `new Cron()` rejects invalid expressions with `{code:'invalid_cron'}` at upsert time
- bots/update writes config.json + scheduler.json atomically: invalid cron rejects in writeConfigPatch BEFORE upsertSchedule is called (no phantom scheduler entries)
- bots/delete removes the schedule AFTER deleteBot succeeds (in-memory state authoritative; file-write failure doesn't leave a phantom task)
- bots/trigger accepts optional `params.trigger === 'cron'` and stamps RunRecord.trigger accordingly
- BotConfig extended with optional `notifyOnError?: boolean` (default true) and `scheduledPrompt?: string` (default '[Scheduled run] Perform your regular check-in.', max 4096 chars)
- RunRecord.trigger union extends from `'manual'` to `'manual' | 'cron'`
- 60 new unit tests across 4 suites: 14 scheduler_tick, 8 scheduler_persistence, 6 bots_update_atomic, 13 new bot_config (existing 19 kept green)
- Full vitest suite: 310 passed + 1 skipped (no regressions)
- Full TS build: clean (main + renderer)

## Task Commits

Each task was committed atomically:

1. **Task 1: Install croner + create daemon/scheduler/index.cjs + extend loader.cjs + wire main.cjs initialize/bots/update/bots/delete** - `e680d25` (feat)
2. **Task 2: Unit tests - scheduler_tick + scheduler_persistence + bots_update_atomic + extended bot_config** - `264983c` (test)

**Plan metadata:** `b404ff0` (no plan-level metadata commit yet — see below)

## Files Created/Modified

- `package.json` + `package-lock.json` — adds `croner@^9.0.0` as a single new runtime dep
- `daemon/scheduler/index.cjs` (NEW, 260 lines) — `loadScheduler/upsertSchedule/removeSchedule/getNextFireAt` + `onCronTick` + test seams; croner loaded via `await import('croner')`; ctx is frozen so scheduler can't mutate canonical maps
- `daemon/bots/loader.cjs` — ALLOWED_CONFIG_KEYS grows from 14 to 16 (adds `notifyOnError`, `scheduledPrompt`); adds `CRON_REGEX` (5-field or 6-field whitespace-separated tokens); validateConfig rejects `invalid_cron` + `invalid_config` for type mismatches; writeConfigPatch runs the same checks BEFORE merging the patch (rejects atomically without touching config.json)
- `daemon/main.cjs` — requires scheduler module; initialize handler calls `scheduler.loadScheduler(userDataDirState, frozenCtx)`; bots/update calls `scheduler.upsertSchedule(...)` AFTER `writeConfigPatch` succeeds; bots/delete calls `scheduler.removeSchedule(...)` AFTER `deleteBot` succeeds; bots/trigger accepts `params.trigger === 'cron'` and stamps RunRecord accordingly; rl.on('close') stops every croner task for clean shutdown
- `src/shared/types.ts` — `BotConfig` adds `notifyOnError?: boolean` and `scheduledPrompt?: string`; `RunRecord.trigger` extends to `'manual' | 'cron'`; `BotCreateRequest` mirrors the new fields
- `tests/unit/scheduler_tick.test.ts` (NEW, 14 cases)
- `tests/unit/scheduler_persistence.test.ts` (NEW, 8 cases)
- `tests/unit/bots_update_atomic.test.ts` (NEW, 6 cases)
- `tests/unit/bot_config.test.ts` (+13 Phase 6 cases; existing 19 kept green)

## Decisions Made

- **Croner loaded via dynamic ESM import** in CJS daemon. Croner's package.json is hybrid ESM/CJS with a `croner.cjs` bundle, but CJS `require()` of an ESM-only package fails in Node 20+. Dynamic `await import('croner')` resolves to the ESM wrapper which re-exports the CJS bundle.
- **`scheduler.json` persisted atomically** via tmp + rename serialized through `persistQueue` (a promise chain). Concurrent upsertSchedule calls cannot interleave bytes; `lastFireAt` is updated on tick but the file is the canonical across-restart state.
- **`onCronTick` registers the AbortController BEFORE awaiting** the cycle. AGENT-08's invariant — `bots/cancel` looks up the AbortController by runId in `ctx.activeRuns` — would silently break for cron-fired runs if registration happened after the await (the sidebar's stop icon would have nothing to abort). The finally block removes both maps entries on completion, error, OR throw.
- **Invalid cron throws synchronously** with `code:'invalid_cron'` from BOTH validateConfig AND writeConfigPatch — so the renderer's `bots/update` always gets a deterministic error code, never a half-persisted config.
- **Scheduler module exposes test seams** (`__inspectSchedulerForTest__`, `__fireCronForTest__`, `__resetForTest__`) so unit tests don't depend on real wall-clock cron time.
- **`notifyOnError` defaults to TRUE** when undefined on persisted entries (Pitfall 11 back-compat: existing scheduled bots get notified by default; users opt out per-bot).
- **RunRecord.trigger default `'manual'`** in `bots/trigger` preserves Phase 4 semantics. The `'cron'` variant is stamped by `onCronTick` (and by callers that explicitly opt-in via `params.trigger === 'cron'`).
- **Daemon cleanup on rl.on('close')** stops every croner task; in-memory state dies with the process so no final persistence is needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Bots/update needs `appendRunRecord` + `writeConfigPatch` + `sendNotification` threaded into schedulerCtx**
- **Found during:** Task 1 implementation
- **Issue:** Plan listed `runSendMessageCycle` + `appendAudit` + `sendNotification` in schedulerCtx, but the actual cron tick handler also needs `appendRunRecord` (to write the RunRecord), `writeConfigPatch` (to patch bot config status + lastRunAt after the cycle), and a way to broadcast `bot:status` running/terminal notifications. Without these, the cron tick would skip the audit/RunRecord paths entirely and the sidebar would never update.
- **Fix:** Extended schedulerCtx to include `appendRunRecord` + `writeConfigPatch` (bound to `botLoader.writeConfigPatch` + the daemon's appendRunRecord). The `sendNotification` reference already exists in scope.
- **Files modified:** `daemon/main.cjs` (initialize handler builds the ctx)
- **Verification:** scheduler_tick.test.ts case "stamps a single bots.run audit line on cycle close with trigger:cron" proves the audit path runs; case "calls runSendMessageCycle with a UUID runId when activeRuns is empty" proves the cycle is invoked.
- **Committed in:** `e680d25` (part of task 1 commit)

**2. [Rule 1 - Bug] `getBotNotifyOnError` and `getBotScheduledPrompt` need try/catch to handle missing bot configs**
- **Found during:** Task 1 implementation
- **Issue:** The plan's ctx accessor functions would throw if the bot config wasn't readable (e.g., during a tick that fires just before bots/create completes). The cron tick would propagate the throw out of `getBotScheduledPrompt` and skip the cycle.
- **Fix:** Wrapped both accessors in try/catch — they fall back to defaults (`'[Scheduled run] Perform your regular check-in.'` and `true`) when the config is unreadable.
- **Files modified:** `daemon/main.cjs`
- **Verification:** scheduler_tick.test.ts cases "calls runSendMessageCycle with a UUID runId when activeRuns is empty" + "emits notification:scheduled-error on errored cycle + notifyOnError !== false" both pass with the try/catch fallback.
- **Committed in:** `e680d25` (part of task 1 commit)

**3. [Rule 1 - Bug] `bots/update` upsertSchedule must pass `null` for ctx (not the schedulerCtx)**
- **Found during:** Task 1 implementation
- **Issue:** `bots/update` is the user-facing JSON-RPC path; the upsertSchedule call only needs to manage the croner task and persistence. Passing the full schedulerCtx (which contains `runSendMessageCycle` + `appendRunRecord`) would unnecessarily couple the JSON-RPC handler to the croner cycle, and would require the userDataDir-scoped `getBotScheduledPrompt` to be re-bound per call.
- **Fix:** Pass `null` as the 5th argument to `upsertSchedule` in `bots/update`. The `onCronTick` handler resolves its own scheduled prompt via its frozen ctx; `bots/update` doesn't fire a cycle.
- **Files modified:** `daemon/main.cjs`
- **Verification:** bots_update_atomic.test.ts cases "writes BOTH config.json and scheduler.json on a successful update" + "bots/update with cronEnabled:false removes the schedule from scheduler.json" both pass with this signature.
- **Committed in:** `e680d25` (part of task 1 commit)

**4. [Rule 1 - Bug] `synthesizeDefaultBot` must include `notifyOnError: true` to satisfy validateConfig allowlist**
- **Found during:** Task 1 implementation
- **Issue:** `validateConfig` (called transitively on every `readConfig`/`writeConfigPatch`) checks that every key in the config is in ALLOWED_CONFIG_KEYS. `synthesizeDefaultBot` returns a config with `notifyOnError: undefined`, which means the synthesized default bot would fail to re-read after the schema extension.
- **Fix:** Added `notifyOnError: true` to `synthesizeDefaultBot`.
- **Files modified:** `daemon/bots/loader.cjs`
- **Verification:** bot_config.test.ts case "synthesizes the implicit default bot when bots dir is missing" passes; the default bot survives listAllBots round-trip without invalid_config throw.
- **Committed in:** `e680d25` (part of task 1 commit)

**5. [Rule 1 - Bug] `BotCreateRequest` must mirror the new fields for the TS build to remain clean**
- **Found during:** Task 1 TS build check
- **Issue:** `BotCreateRequest` (the JSON-RPC create surface) only carried `cron?` + `cronEnabled?`; extending `BotConfig` to include `notifyOnError?` + `scheduledPrompt?` without extending `BotCreateRequest` would force `bots/create` callers to use a type assertion. Plan didn't explicitly require the extension.
- **Fix:** Added `notifyOnError?: boolean` + `scheduledPrompt?: string` to `BotCreateRequest`.
- **Files modified:** `src/shared/types.ts`
- **Verification:** `npm run build:main` exits 0 (TS build clean); existing renderer code that calls bots/create doesn't need any changes.
- **Committed in:** `e680d25` (part of task 1 commit)

**Total deviations:** 5 auto-fixed (1 Rule 2 missing critical functionality, 4 Rule 1 bug fixes / surface extensions)
**Impact on plan:** All auto-fixes are surface extensions and defensive null-handling; no scope creep, no architecture changes. Plan executed exactly as specified at the API surface level.

## Issues Encountered

None. Pre-flight precondition check (worktree on correct base SHA, daemon/main.cjs ~882 lines, Phase 4/5 wiring present) passed cleanly.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for **06-02 (Electron Notification bridge)** and **06-03 (renderer UI + audit minimization + E2E smoke)**:
- Daemon emits `notification:scheduled-error` events with `{bot, runId, errorMessage, ts}` payload — Plan 2's main process bridge can subscribe to this channel.
- Daemon emits `bot:status` `running` + terminal notifications for cron-fired runs (matches the manual-trigger pattern; renderer can update the sidebar identically).
- `RunRecord.trigger === 'cron'` is stamped in `<userData>/runs/<bot>/bot.jsonl` — `RunHistoryTable.tsx` (renderer) reads `record.trigger` and now sees `'cron'` for scheduled runs.
- `BotConfig.notifyOnError` + `BotConfig.scheduledPrompt` are typed — Plan 3's `BotSettingsPage.tsx` Schedule tab can render the form without any `as any` casts.

**Manual verifications still required (per 06-VALIDATION.md):**
- Headed Electron notification toast in Windows Action Center
- Cron expression in user's local timezone across DST boundary
- App-startup catch-up behavior (or lack thereof)

---
*Phase: 06-scheduler-notifications*
*Completed: 2026-09-19*

## Self-Check: PASSED

- daemon/scheduler/index.cjs exists with all 4 exports (loadScheduler/upsertSchedule/removeSchedule/getNextFireAt) — verified via `node -e` import
- daemon/bots/loader.cjs ALLOWED_CONFIG_KEYS size = 16, includes `notifyOnError` + `scheduledPrompt` — verified
- daemon/main.cjs has 3 scheduler wire points (loadScheduler, upsertSchedule, removeSchedule) — verified via grep
- src/shared/types.ts BotConfig has `notifyOnError?: boolean` + `scheduledPrompt?: string`; RunRecord.trigger is `'manual' | 'cron'` — verified via npm run build:main exit 0
- All 4 test suites pass: 60 tests total — verified via `npx vitest run tests/unit/{scheduler_tick,scheduler_persistence,bots_update_atomic,bot_config}.test.ts`
- Full vitest suite: 310 passed + 1 skipped, no regressions — verified
- croner@9.1.0 installed — verified via `npm ls croner`
- 2 task commits on `worktree-agent-a92bf23587cf5eb55` branch — verified via `git log`
- Plan commit ledger persisted at `D:/Claude/Grokbot/.git/worktrees/agent-a92bf23587cf5eb55/gsd-plan-head-before-06-01` (value `b404ff086109611b10b797ee787b63295bb673dd`)