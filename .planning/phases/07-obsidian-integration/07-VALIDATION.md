---
phase: "7"
slug: "obsidian-integration"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-19"
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 2.1.9 (unit) + Playwright 1.63.0 (E2E) |
| **Config file** | `vitest.config.ts` (existing) + `playwright.config.ts` (existing) |
| **Quick run command** | `npx vitest run --root D:/Claude/Grokbot tests/unit/vault_glob.test.ts tests/unit/vault_read.test.ts tests/unit/vault_write.test.ts tests/unit/vault_search.test.ts tests/unit/vault_config.test.ts tests/unit/vault_wikilink.test.ts 2>&1 \| tail -50` |
| **Full suite command** | `npm run test:all` (Vitest unit + Playwright daemon smoke, ~60 s) |
| **Estimated runtime** | ~30 s (Wave 0 unit suites) + ~45 s (Playwright E2E smoke) |

---

## Sampling Rate

- **After every task commit:** Run quick run command (Wave 0 unit suites only)
- **After every plan wave:** Run `npm test` (all Vitest unit suites)
- **Before `/gsd-verify-work`:** Full suite must be green (`npm run test:all`)
- **Max feedback latency:** ~30 s per commit (single Vitest run)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 07-01-01 | 01 | 1 | OBS-01 | T-7-05 | `<userData>/vault.json` atomic round-trip; corrupt file falls back to empty | unit | `npx vitest run tests/daemon/vault_config.test.ts` | ❌ W0 | ⬜ pending |
| 07-01-02 | 01 | 1 | OBS-04, OBS-05 | T-7-02, T-7-05 | Per-bot allow/deny + global deny precedence (deny always wins) | unit | `npx vitest run tests/daemon/vault_glob.test.ts` | ❌ W0 | ⬜ pending |
| 07-01-03 | 01 | 1 | OBS-02 | T-7-01, T-7-08 | `vault.read` path containment (realpath) + glob filter + slicing | unit | `npx vitest run tests/daemon/vault_read.test.ts` | ❌ W0 | ⬜ pending |
| 07-01-04 | 01 | 1 | OBS-03 | T-7-03, T-7-09 | `vault.write` `Agents/<bot>/` containment (realpath relative check); tmp+rename atomic | unit | `npx vitest run tests/daemon/vault_write.test.ts` | ❌ W0 | ⬜ pending |
| 07-01-05 | 01 | 1 | OBS-06 | T-7-06 | `vault.search` ripgrep streaming + glob filter on results; `--no-follow` | unit | `npx vitest run tests/daemon/vault_search.test.ts` | ❌ W0 | ⬜ pending |
| 07-01-06 | 01 | 1 | OBS-02 | T-7-07 | Wikilink regex `[[Title]]` / `[[Title\|Alias]]` / `[[Title#Section]]` + index case-folding | unit | `npx vitest run tests/daemon/vault_wikilink.test.ts` | ❌ W0 | ⬜ pending |
| 07-02-01 | 02 | 2 | OBS-01..06 | T-7-all | IPC channels + main `vault.ts` + preload + EventEmitter bridge for `EVENT_VAULT_CONFIG_UPDATED` | unit + tsc | `npx tsc --noEmit -p . 2>&1 \| tail -30` | n/a | ⬜ pending |
| 07-03-01 | 03 | 3 | OBS-01..06 | T-7-all | Renderer Obsidian tab in `BotSettingsPage` (vaultPath + allow/deny + global deny view); Playwright E2E fake LLM streams vault tool uses; audit row minimization | unit + Playwright | `npx playwright test --config D:/Claude/Grokbot/playwright.config.ts obsidian-integration.test.ts 2>&1 \| tail -30` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/daemon/vault_glob.test.ts` — covers OBS-04 + OBS-05 (per-bot allow/deny + global deny precedence; deny-always-wins invariant)
- [ ] `tests/daemon/vault_read.test.ts` — covers OBS-02 (realpath containment + glob enforcement + slicing; symlink escape blocked)
- [ ] `tests/daemon/vault_write.test.ts` — covers OBS-03 (`Agents/<bot>/` containment via path.relative; tmp+rename atomic; cross-bot write blocked)
- [ ] `tests/daemon/vault_search.test.ts` — covers OBS-06 (ripgrep stream + glob filter on results; `--no-follow` so daemon containment is single source of truth)
- [ ] `tests/daemon/vault_config.test.ts` — covers OBS-01 (`<userData>/vault.json` round-trip + atomic write + per-bot override resolution + corrupt file fallback)
- [ ] `tests/daemon/vault_wikilink.test.ts` — covers wikilink regex (`[[Title]]`, `[[Title|Alias]]`, `[[Title#Section]]`) + index case-folding
- [ ] `tests/e2e/obsidian-integration.test.ts` — Playwright: fake LLM streams `vault.read` + `vault.search` + `vault.write`; asserts audit row minimization + UI block rendering + Agent folder isolation
- [ ] `tests/fakes/fake-m3-server.ts` — extend with `streamVaultReadToolUse` + `streamVaultWriteToolUse` + `streamVaultSearchToolUse` helpers

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Symlink in vault escapes to filesystem outside vault | OBS-02 | Test setup requires creating real symlinks; OS-dependent (Windows SeCreateSymbolicLinkPrivilege) | On Windows desktop with admin: create junction/symlink inside vault pointing outside; `vault.read <symlinked-path>` must reject with `outside_vault` |
| Headed Electron smoke end-to-end with real Obsidian vault | OBS-01..06 | Requires real vault + desktop GUI | Set `LOCALBOT_SMOKE_OK=1`; load a real vault containing wikilinks + Private/ folder; trigger a bot via composer; verify UI block renders + audit JSONL shows vault-relative paths only |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30 s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending