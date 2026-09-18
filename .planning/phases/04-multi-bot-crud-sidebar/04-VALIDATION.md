---
phase: "4"
slug: "multi-bot-crud-sidebar"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-18"
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Derived from `04-RESEARCH.md` Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest `^2.1.9` (unit) + Playwright `^1.63.0` (Electron + daemon smoke) |
| **Config files** | `vitest.config.ts` (Node env, includes `tests/unit/**`), `playwright.config.ts` |
| **Quick run command** | `npm test` (Vitest unit, ~10 s) |
| **Full suite command** | `npm run test:all` (Vitest + Playwright daemon smoke, ~40 s) |
| **Estimated runtime** | ~40 seconds (full suite); ~10 seconds (unit only) |

---

## Sampling Rate

- **After every task commit:** Run `npm test` (Vitest unit only, ~10 s)
- **After every plan wave:** Run `npm run test:all` (Vitest + Playwright daemon smoke, ~40 s)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~40 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | REQ-AGENT-01 | T-04-01 | `bots/create` writes `config.json` under `<userData>/bots/<bot>/` only; `unknown_bot` thrown for bad ids | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/bot_config.test.ts` | ❌ W0 | ⬜ pending |
| 04-01-02 | 01 | 1 | REQ-AGENT-01..04 | T-04-01 / T-04-02 | `bots/list`, `bots/update`, `bots/delete` JSON-RPC lifecycle | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/bot_crud.test.ts` | ❌ W0 | ⬜ pending |
| 04-01-03 | 01 | 1 | REQ-AGENT-04 / SEC-02 | T-04-02 | `getPolicy(bot)` reads `config.json#allowlist`; falls back to `DEFAULT_POLICY` for `default` bot; throws `unknown_bot` otherwise | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/bot_policy.test.ts` | ❌ W0 | ⬜ pending |
| 04-02-01 | 02 | 2 | REQ-AGENT-07 | T-04-03 | `bots/trigger` runs one sendMessage cycle + appends run row keyed by run-id | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/bot_runs.test.ts` | ❌ W0 | ⬜ pending |
| 04-02-02 | 02 | 2 | REQ-AGENT-08 | T-04-03 | `bots/cancel` aborts run-id controller; writes cancelled run row | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/bot_runs.test.ts` | ❌ W0 | ⬜ pending |
| 04-03-01 | 03 | 3 | REQ-AGENT-01..04, AGENT-07..08, UI-01, UI-05..07 | T-04-01..T-04-05 | BotSidebar + NewBotModal + DeleteConfirmModal + SettingsEditModal + BotSettingsPage + RunHistoryTable render end-to-end against real daemon + fake M3 | smoke | `npx --prefix D:/Claude/Grokbot playwright test tests/playwright/bot-crud.test.ts` | ❌ W0 | ⬜ pending |
| 04-03-02 | 03 | 3 | REQ-AGENT-07, AGENT-08 | T-04-03 | Two bots with different policies; trigger A; trigger B; cancel A; verify B continues streaming (proves per-run-id controller isolation) | smoke | `npx --prefix D:/Claude/Grokbot playwright test tests/playwright/multi-bot.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/bot_config.test.ts` — covers `readConfig`, `writeConfig` roundtrip; schema validation rejects unknown keys; `schemaVersion: 1` enforced
- [ ] `tests/unit/bot_crud.test.ts` — covers `bots/create` + `bots/update` + `bots/delete` lifecycle; idempotent on re-create; safePath containment; `unknown_bot` on bad id
- [ ] `tests/unit/bot_policy.test.ts` — covers `getPolicy` reads `config.json#allowlist`; falls back to `DEFAULT_POLICY` for `default` bot; throws `unknown_bot` for non-existent bot
- [ ] `tests/unit/bot_runs.test.ts` — covers `appendRun` + `listRuns`; NDJSON append-only; newest-first ordering; limit parameter; `cancelled` exit reason row
- [ ] `tests/unit/allowlist.test.ts` (extended) — per-bot policy override: bot A allowlists only `read_file`; bot B allowlists all tools
- [ ] `tests/playwright/bot-crud.test.ts` — full vertical: spawn daemon + Electron + fake M3; NewBotModal → bots/create → sidebar shows new bot → bots/trigger → streaming response → bots/runs shows the row → bots/update → settings page → bots/delete → sidebar removes the row
- [ ] `tests/playwright/multi-bot.test.ts` — two bots with different policies; trigger bot A; while streaming, trigger bot B; cancel bot A; verify bot B continues streaming (proves per-run-id controller isolation)
- [ ] `tests/playwright/fake-m3-server.ts` (extended) — `streamBotTrigger({bot, port})` helper that emits an SSE stream for a bot-triggered run

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Headed Electron render + sidebar visual layout (260 px) + status dot colors | UI-01 | Layout is rendered in real Chromium; headed only | Run `LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/bot-crud.test.ts` on a desktop machine |
| NewBotModal flow (name → persona → workspace → allowlist → cron) keyboard-only nav | UI-05 | ARIA focus trap requires manual interaction | Manual click-through with screen reader |
| BotSettingsPage tabs (General / Permissions / Schedule) | UI-06 | Tab keyboard nav requires real focus ring | Manual tab + arrow key test |
| RunHistoryTable pagination for 100+ runs | UI-07 | NDJSON reads truncated at 50 by default; manual scroll needed | Generate 100 fake runs; verify last-50 visible, scroll loads more |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 40s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending