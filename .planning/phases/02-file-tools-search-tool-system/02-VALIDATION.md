---
phase: "2"
slug: "file-tools-search-tool-system"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-17"
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^2.1.9 (unit) + Playwright ^1.63.0 (Electron + daemon smoke) |
| **Config files** | `vitest.config.ts` (Node env, includes `tests/unit/**`), `playwright.config.ts` |
| **Quick run command** | `npm --prefix D:/Claude/Grokbot test 2>&1 | tail -30` |
| **Full suite command** | `npm --prefix D:/Claude/Grokbot run test:all 2>&1 | tail -50` |
| **Estimated runtime** | Vitest ~10s (unit) + Playwright daemon smoke ~20s + Playwright headed smoke gated by `LOCALBOT_SMOKE_OK=1` |

---

## Sampling Rate

- **After every task commit:** `npm test` (Vitest unit only)
- **After every plan wave:** `npm run test:all` (Vitest + Playwright daemon smoke)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~10s for unit, ~30s for full suite

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | TOOL-01..05 | T-P2-01..03 | Workspace containment via `safePath` realpath + prefix | unit | `npx vitest run tests/unit/safe_path.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 02-01-02 | 01 | 1 | SEC-02 | T-P2-04 | Registry rejects non-allowlisted tool before any `fs` call | unit | `npx vitest run tests/unit/allowlist.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 02-01-03 | 01 | 1 | TOOL-01 | — | Reads workspace file, returns string | unit | `npx vitest run tests/unit/read_file.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 02-01-04 | 01 | 1 | TOOL-02 | T-P2-12 | Creates file + nested dirs; EACCES surfaces as `tool_result:is_error` | unit | `npx vitest run tests/unit/write_file.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 02-01-05 | 01 | 1 | TOOL-03 | T-P2-12 | Single-match find/replace; atomic via tmp+rename | unit | `npx vitest run tests/unit/edit_file.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 02-01-06 | 01 | 1 | TOOL-04 | — | Returns sorted entries, dirs-first | unit | `npx vitest run tests/unit/list_dir.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 02-01-07 | 01 | 1 | TOOL-05 | T-P2-05,06 | ripgrep regex+glob; max_results=200; 1 MiB cap compliance | unit | `npx vitest run tests/unit/code_search.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 02-02-01 | 02 | 2 | LLM-03 | — | Agentic loop: tool_use → execute → tool_result → resume | unit | `npx vitest run tests/unit/agentic_loop.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 02-02-02 | 02 | 2 | LLM-03, SEC-02 | T-P2-08 | Mid-tool cancel aborts SDK + kills daemon tool | unit | same as above | ⬜ Wave 0 | ⬜ pending |
| 02-02-03 | 02 | 2 | LLM-03, SEC-02, SEC-04 | — | End-to-end fake M3 emits tool_use, daemon runs read_file, audit JSONL line lands | smoke | `npx playwright test tests/playwright/daemon-tools.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 02-03-01 | 03 | 3 | UI-03 | — | Tool-use + tool-result blocks render with correct text + collapse for >N chars | smoke | `LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/smoke-tools.test.ts` | ⬜ Wave 0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/safe_path.test.ts` — workspace containment + symlink escape cases (TOOL-01..04)
- [ ] `tests/unit/read_file.test.ts` — happy path + ENOENT + EACCES
- [ ] `tests/unit/write_file.test.ts` — happy path + nested mkdir + EACCES
- [ ] `tests/unit/edit_file.test.ts` — single match, no match, multiple matches, atomic write
- [ ] `tests/unit/list_dir.test.ts` — dirs-first sort, empty dir, missing dir
- [ ] `tests/unit/code_search.test.ts` — regex match, glob filter, max_results=200, 1 MiB cap
- [ ] `tests/unit/allowlist.test.ts` — allowlist + denylist enforcement
- [ ] `tests/unit/agentic_loop.test.ts` — SDK stream → daemon dispatch → resume; stubbed `messages.stream` + stubbed `dispatchTool`
- [ ] `tests/playwright/daemon-tools.test.ts` — extends Phase 1 `tests/playwright/daemon.test.ts:81` pattern with `tools/call` for `read_file` against fixture workspace
- [ ] `tests/playwright/fake-m3-server.ts` — extend with `streamToolUseResponse(name, input, followupText)` helper (full SSE sequence)
- [ ] `tests/playwright/smoke-tools.test.ts` — fake M3 tool-use sequence → renderer renders block; headed run gated by `LOCALBOT_SMOKE_OK`

*Existing Phase 1 infrastructure (Vitest config, Playwright config, fake-m3-server base, daemon.test.ts, smoke.test.ts) is reusable as-is.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Headed Electron tool-call block render | UI-03 | Phase 1 precedent: headed smoke requires Windows desktop session + `LOCALBOT_SMOKE_OK`; Playwright daemon smoke covers the contract | On a desktop session: `LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/smoke-tools.test.ts` |
| Allowlist refusal from real LLM prompt | SEC-02 | Needs human to type a request that triggers a non-allowlisted tool (e.g., ask the bot to run a shell command) | Type "list the files in C:\Windows\System32" — verify daemon refuses and surfaces an error block |

*All other phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending