---
phase: "3"
slug: "memory-conversation-history"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-18"
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Derived from `03-RESEARCH.md` §Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^2.1.9 (unit) + Playwright ^1.63.0 (Electron + daemon smoke) |
| **Config files** | `vitest.config.ts` (Node env, includes `tests/unit/**`), `playwright.config.ts` |
| **Quick run command** | `npm --prefix D:/Claude/Grokbot test 2>&1 | tail -30` |
| **Full suite command** | `npm --prefix D:/Claude/Grokbot run test:all 2>&1 | tail -50` |
| **Estimated runtime** | Vitest ~10s (unit) + Playwright daemon smoke ~30s + Playwright headed smoke gated by `LOCALBOT_SMOKE_OK=1` |

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
| 03-01-01 | 01 | 1 | AGENT-05 | T-P3-01 | `memory.md` survives restart (kill app between write and reload) | unit | `npx vitest run tests/unit/memory.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 03-01-02 | 01 | 1 | AGENT-05 | — | `memory/read` JSON-RPC returns `{markdown, facts}` | unit | covered by `memory.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 03-01-03 | 01 | 1 | AGENT-05 | T-P3-04 | `memory/write` is path-contained (realpath inside `<botDir>`) | unit | covered by `memory.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 03-01-04 | 01 | 1 | AGENT-05 | — | Memory injected into system prompt (suffix appended, ≤ 4 KB cap) | unit | `npx vitest run tests/unit/memory.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 03-01-05 | 01 | 1 | AGENT-05 | — | `facts.json` merges by `name`; preserves `updatedAt` ordering | unit | `npx vitest run tests/unit/facts.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 03-01-06 | 01 | 1 | AGENT-06 | — | `appendMessage` writes to `<sessionsDir>/<bot>/<id>.jsonl` | unit | `npx vitest run tests/unit/jsonl_router.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 03-01-07 | 01 | 1 | AGENT-06 | — | Legacy `global.jsonl` migrates to `default/<id>.jsonl` on first load | unit | covered by `jsonl_router.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 03-01-08 | 01 | 1 | LLM-04 | — | Usage accumulator tracks `input_tokens + output_tokens` across multi-turn loop | unit | `npx vitest run tests/unit/usage_accumulator.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 03-01-09 | 01 | 1 | LLM-04 | — | `maybeSummarize` triggers when accumulator crosses SOFT_CAP | unit | `npx vitest run tests/unit/summarize.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 03-01-10 | 01 | 1 | LLM-04 | T-P3-08 | `runSummarizer` has separate retry budget; cannot retrigger outer retry | unit | covered by `summarize.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 03-01-11 | 01 | 1 | LLM-04 | T-P3-07 | Summary written as head-of-JSONL on disk so it survives restart | unit | covered by `summarize.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 03-02-01 | 02 | 2 | UI-08 | — | `tree/list` returns capped + lazy children; skips `node_modules`, `.git` | unit | `npx vitest run tests/unit/list_tree.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 03-02-02 | 02 | 2 | UI-08 | — | `chokidar` watcher emits `tree:refresh` on file change (debounced 250 ms) | unit | covered by `list_tree.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 03-02-03 | 02 | 2 | UI-08 | T-P3-09 | Binary file shows placeholder in diff view (not crash) | unit | covered by `list_tree.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 03-03-01 | 03 | 3 | AGENT-06, LLM-04 | — | End-to-end: app restart reloads from per-bot JSONL; renderer shows summary block | smoke | `npx playwright test tests/playwright/memory-history.test.ts` | ⬜ Wave 0 | ⬜ pending |
| 03-03-02 | 03 | 3 | UI-08 | — | Workspace tree renders; diff view renders before/after for `edit_file` | smoke | `npx playwright test tests/playwright/tree-diff.test.ts` | ⬜ Wave 0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/memory.test.ts` — read/write roundtrip; size cap (≤ 4 KB oldest sections dropped); concurrent writes serialized by per-bot mutex
- [ ] `tests/unit/facts.test.ts` — `mergeFacts` dedups by `name`; preserves `updatedAt` ordering; rejects invalid schema
- [ ] `tests/unit/jsonl_router.test.ts` — per-bot routing; newest-first listing; legacy `global.jsonl` migration
- [ ] `tests/unit/usage_accumulator.test.ts` — multi-turn loop; cache token handling (`cache_creation_input_tokens` + `cache_read_input_tokens`)
- [ ] `tests/unit/summarize.test.ts` — threshold trigger; head-of-JSONL write; cancel mid-summarize; separate retry budget
- [ ] `tests/unit/list_tree.test.ts` — caps; lazy children; exclusion list (`node_modules`, `.git`); binary detection
- [ ] `tests/playwright/memory-history.test.ts` — extends `fake-m3-server.ts` with `streamLongResponse(tokens)` helper emitting `usage.input_tokens: 100000` on `message_start`; asserts renderer shows summary block; restarts app and asserts session reloads
- [ ] `tests/playwright/tree-diff.test.ts` — full headed run; gated by `LOCALBOT_SMOKE_OK=1`
- [ ] `package.json` — add `chokidar`, `react-arborist`, `react-diff-viewer-continued`, `diff`; add `overrides` block for React 19 peer-deps where required

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Memory persists across full app restart (real Electron + real keychain) | AGENT-05 | Headed Electron + keychain requires a desktop session | 1) Launch app, type a message that triggers `update_memory`. 2) Quit (not just close window). 3) Relaunch and confirm memory block is still injected into the first response. |
| Token-budget summarize in a live long session | LLM-04 | Headed Electron + real LLM call | 1) Force `SOFT_CAP` low (e.g., 5 KB). 2) Send 20+ messages. 3) Confirm renderer shows a `summary` block at the head of the conversation. |
| Workspace tree refresh on external file edit | UI-08 | Requires chokidar running in renderer + visible file change | 1) Open the workspace tree. 2) Add a file to the workspace via `write_file` or the OS. 3) Confirm the tree refreshes within 500 ms. |
| Diff view for binary files | UI-08 | Visual check that placeholder is readable | 1) Edit a binary file via `edit_file` (or write a non-UTF8 buffer). 2) Confirm diff view shows "binary file" placeholder, not garbled text. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all 4 REQ-IDs (AGENT-05, AGENT-06, LLM-04, UI-08)
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
