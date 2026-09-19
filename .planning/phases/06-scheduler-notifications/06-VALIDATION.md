---
phase: "6"
slug: "scheduler-notifications"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-19"
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Phase 6 covers AGENT-09 (cron schedule + per-bot enable/disable) and AGENT-10 (system notification on scheduled-bot error).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1.9 (unit) + @playwright/test 1.63 (E2E smoke) |
| **Config file** | `vitest.config.ts` + `playwright.config.ts` (already present from Phases 1–5) |
| **Quick run command** | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/scheduler*.test.ts 2>&1 | tail -40` |
| **Full suite command** | `npm --prefix D:/Claude/Grokbot test 2>&1 | tail -30` |
| **Estimated runtime** | ~20 seconds (unit) + ~45 seconds (Playwright daemon smoke) |

---

## Sampling Rate

- **After every task commit:** Run the quick run command above
- **After every plan wave:** Run `npm --prefix D:/Claude/Grokbot run build && npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot 2>&1 | tail -30`
- **Before `/gsd-verify-work`:** Full suite + Playwright daemon smoke + `LOCALBOT_SMOKE_OK=1` headed smoke (final acceptance gate, gated by desktop availability per STATE.md §Performance Metrics)
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 6-01-01 | 01 | 1 | AGENT-09 | T-P6-01 | croner@^9 instance per bot with `protect: true` + manual-fire cross-check (activeRuns map) — never double-fires | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/scheduler_tick.test.ts 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 6-01-02 | 01 | 1 | AGENT-09 | T-P6-02 | `<userData>/scheduler.json` atomic write + cross-bot reload preserves all cron schedules across daemon restart | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/scheduler_persistence.test.ts 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 6-01-03 | 01 | 1 | AGENT-09 | T-P6-03 | `bots/update` patches `config.json` + `scheduler.json` atomically — never leaves one behind the other | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/bots_update_atomic.test.ts 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 6-02-01 | 02 | 2 | AGENT-10 | T-P6-04 | Scheduled run with `notifyOnError: true` errors → Electron `Notification` fires once (debounced 60s) with bot name + error summary | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/scheduler_notification.test.ts 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 6-02-02 | 02 | 2 | AGENT-10 | T-P6-05 | Notification click focuses main `BrowserWindow` and navigates to the bot's run history tab | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/notification_click.test.ts 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 6-03-01 | 03 | 3 | AGENT-09, AGENT-10 | T-P6-06 | Schedule form (cron expression + enable toggle + notifyOnError toggle) renders in `BotSettingsPage` schedule tab, validates cron via `croner` parse | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/bot_settings_schedule.test.tsx 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 6-03-02 | 03 | 3 | AGENT-09 | T-P6-07 | Sidebar shows scheduled status indicator (`⏰` icon when cronEnabled && nextFireAt < 24h) and fires-at-upcoming sort order | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/sidebar_scheduled_indicator.test.tsx 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 6-03-03 | 03 | 3 | AGENT-09, AGENT-10 | T-P6-08 | RunRecord.trigger union extends to `'manual' | 'cron'`; audit minimization omits per-tick entries, writes only on RunRecord close with `{runId, trigger: 'cron', messageCount}` | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/scheduler_audit.test.ts 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 6-03-04 | 03 | 3 | AGENT-09, AGENT-10 | T-P6-09 | Playwright daemon smoke: fake M3 → bots/update cron → croner tick → bots/trigger (cron path) → run error → notification fires → sidebar updates | E2E | `npx --prefix D:/Claude/Grokbot playwright test --config D:/Claude/Grokbot/playwright.config.ts scheduler-notification.test.ts 2>&1 | tail -30` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/scheduler_tick.test.ts` — croner per-bot instance + protect + manual-cross-check (T-P6-01)
- [ ] `tests/unit/scheduler_persistence.test.ts` — `<userData>/scheduler.json` atomic write + reload (T-P6-02)
- [ ] `tests/unit/bots_update_atomic.test.ts` — `bots/update` config + scheduler atomicity (T-P6-03)
- [ ] `tests/unit/scheduler_notification.test.ts` — Electron Notification debounce + suppression (T-P6-04)
- [ ] `tests/unit/notification_click.test.ts` — click focuses window + routes to run history (T-P6-05)
- [ ] `tests/unit/bot_settings_schedule.test.tsx` — schedule form render + cron parse validation (T-P6-06)
- [ ] `tests/unit/sidebar_scheduled_indicator.test.tsx` — sidebar status + sort order (T-P6-07)
- [ ] `tests/unit/scheduler_audit.test.ts` — RunRecord.trigger + audit minimization (T-P6-08)
- [ ] `tests/playwright/scheduler-notification.test.ts` — Playwright daemon smoke for cron + notification (T-P6-09)
- [ ] `tests/fixtures/fake-m3-server.ts` extension — `streamCronTrigger` + `streamCronError` (analogous to `streamExecCommandToolUse` from Phase 5)
- [ ] `npm install croner@^9.0.0` — Wave 0 dependency (verify with `npm ls croner` after install)

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Headed Electron notification toast (Windows Action Center) | AGENT-10 | Toast appearance + grouping only verifiable on desktop | Run `LOCALBOT_SMOKE_OK=1 npx --prefix D:/Claude/Grokbot playwright test --config D:/Claude/Grokbot/playwright.config.ts scheduler-notification-headed.test.ts` on a Windows desktop; confirm toast appears in Action Center, click focuses main window, `app.setAppUserModelId` groups correctly |
| Cron expression in user's local timezone | AGENT-09 | Timezone math (DST transitions) hard to verify in CI | Manually set bot to `0 9 * * *` and observe fire time across a DST boundary (US DST 2026: Mar 8 / Nov 1); confirm local 9am fires (UTC offset shifts correctly) |
| App-startup catch-up behavior (or lack thereof) | AGENT-09 | Requires shutting down the app at a scheduled time, then restarting | Shut down Localbot at 14:55 with bot scheduled `*/15 * * * *`; restart at 15:10; observe whether missed fires replay (Phase 6 says no — CLAUDE.md 24/7 assumption) or are dropped |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
