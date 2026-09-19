---
phase: "5"
slug: "shell-exec-with-approval"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-18"
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Phase 5 covers TOOL-06 (exec_command), SEC-03 (global denylist), UI-04 (approval modal).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1.9 (unit) + @playwright/test 1.63 (E2E smoke) |
| **Config file** | `vitest.config.ts` + `playwright.config.ts` (already present from Phases 1–4) |
| **Quick run command** | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/exec_denylist.test.ts tests/unit/exec_alwaysAllow.test.ts tests/unit/exec_command.test.ts 2>&1 | tail -40` |
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
| 5-01-01 | 01 | 1 | TOOL-06, SEC-03 | T-P5-01, T-P5-02 | GLOBAL_DENYLIST blocks rm -rf /, sudo, curl*\|bash BEFORE per-bot allowlist | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/exec_denylist.test.ts 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 5-01-02 | 01 | 1 | TOOL-06 | T-P5-03 | shell/approve JSON-RPC round-trip blocks tools/call exec_command until renderer responds | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/exec_approve.test.ts 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 5-01-03 | 01 | 1 | TOOL-06, UI-04 | T-P5-04 | always-allow lookup short-circuits approval (exact-string, FIFO at 50) | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/exec_alwaysAllow.test.ts 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 5-01-04 | 01 | 1 | TOOL-06 | T-P5-05 | child_process spawn uses cmd.exe /d /s /c, streams stdout/stderr line-buffered | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/exec_command.test.ts 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 5-02-01 | 02 | 2 | UI-04, TOOL-06 | T-P5-06 | Approval modal (Allow once / Always allow / Deny) renders from shell/approve IPC, blocks composer | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/shell_approval_modal.test.tsx 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 5-02-02 | 02 | 2 | TOOL-06 | T-P5-07 | shell:token + shell:exit IPC stream stdout/stderr + exit code to MessageBlock.kind='shell_stream' | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/shell_stream_block.test.tsx 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 5-02-03 | 02 | 2 | TOOL-06 | T-P5-05 | AbortController cancel triggers taskkill /pid /T /F on Windows; child.kill('SIGTERM') on POSIX | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/exec_cancel.test.ts 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 5-03-01 | 03 | 3 | TOOL-06, SEC-03, UI-04 | T-P5-08 | Audit line: {command_redacted (slice(0,80)), commandLength, approvedBy, exitCode, stdoutBytes, stderrCount} — never full command, never stdout/stderr | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/exec_audit.test.ts 2>&1 | tail -20` | ❌ W0 | ⬜ pending |
| 5-03-02 | 03 | 3 | TOOL-06, UI-04, SEC-03 | T-P5-09 | Playwright daemon smoke: fake M3 emits exec_command → modal → Allow → spawn → stream → exit → audit | E2E | `npx --prefix D:/Claude/Grokbot playwright test --config D:/Claude/Grokbot/playwright.config.ts exec-command-approval.test.ts 2>&1 | tail -30` | ❌ W0 | ⬜ pending |
| 5-03-03 | 03 | 3 | SEC-03 | T-P5-10 | Daemon-side denylist re-check is defense-in-depth even if renderer pre-check lets a command through | unit | `npx --prefix D:/Claude/Grokbot vitest run --root D:/Claude/Grokbot tests/unit/exec_denylist_defense.test.ts 2>&1 | tail -20` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/exec_denylist.test.ts` — stubs for GLOBAL_DENYLIST pattern matching (T-P5-01)
- [ ] `tests/unit/exec_approve.test.ts` — shell/approve JSON-RPC round-trip stub (T-P5-02)
- [ ] `tests/unit/exec_alwaysAllow.test.ts` — FIFO eviction + exact-string match (T-P5-03)
- [ ] `tests/unit/exec_command.test.ts` — spawn mock + line-buffered stdout/stderr capture (T-P5-04)
- [ ] `tests/unit/shell_approval_modal.test.tsx` — approval modal component render + click (T-P5-06)
- [ ] `tests/unit/shell_stream_block.test.tsx` — shell_stream MessageBlock accumulator (T-P5-07)
- [ ] `tests/unit/exec_cancel.test.ts` — taskkill /T /F + AbortController integration (T-P5-05)
- [ ] `tests/unit/exec_audit.test.ts` — audit minimization invariants (T-P5-08)
- [ ] `tests/unit/exec_denylist_defense.test.ts` — daemon re-check after renderer (T-P5-10)
- [ ] `tests/e2e/exec-command-approval.test.ts` — Playwright daemon smoke for full approval flow (T-P5-09)
- [ ] `tests/fixtures/fake-m3-server.ts` extension — `streamExecCommandToolUse` (analogous to `streamEditFileToolUse` from Phase 3)

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Headed Electron approval modal flow | UI-04 | Window focus + click-outside + Escape key only testable on desktop | Run `LOCALBOT_SMOKE_OK=1 npx --prefix D:/Claude/Grokbot playwright test --config D:/Claude/Grokbot/playwright.config.ts shell-approval-headed.test.ts` on a Windows desktop; confirm modal opens, Allow/Deny buttons fire IPC, click-outside closes |
| Real OS keychain — `child_process.spawn('cmd.exe', …)` cross-process tree kill | TOOL-06 | `taskkill /T /F` semantics differ in containerized CI vs real Windows host | Run `npm --prefix D:/Claude/Grokbot run smoke:exec` on the user's PC; observe parent cmd.exe + any children killed in Task Manager |

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
