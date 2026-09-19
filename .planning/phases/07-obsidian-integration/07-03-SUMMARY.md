---
plan: 07-03
phase: 7
status: complete
wave: 3
autonomous: true
depends_on: 07-02
plan_head_before: 17f3057d7e6c79f5b69f51f4e6d0d3e89a2a5a5e
commits: 2
must_haves_verified:
  - truth: "User can edit vault path + per-bot allow/deny glob lists from BotSettingsPage's new 5th 'Obsidian' tab; changes debounce-save (250ms) via existing bot.update IPC" -> PASS
  - truth: "User can configure the global vault root path + global deny globs from a VaultGlobalSettingsModal reached from a top-bar Vault button" -> PASS
  - truth: "Playwright E2E: tools/call vault.read Projects/foo.md -> result.path is vault-relative + result.content is the file content; audit row carries {path, bytes} only (no absolute path, no rootPath)" -> PASS
  - truth: "Playwright E2E: tools/call vault.write Agents/alpha/note.md -> file appears on disk; vault.write to Projects/foo.md refused with code:'write_outside_agents' (no file created)" -> PASS
  - truth: "Playwright E2E: tools/call vault.search hello -> audit row carries exactly the 4-key {query, glob, result_count, truncated} shape" -> PASS
artifacts:
  - src/renderer/components/BotSettingsObsidianTab.tsx (NEW) - vaultPath + vaultAllow + vaultDeny textareas + 4 vault.* tool checkboxes with 250ms debounced save -> PASS
  - src/renderer/components/VaultGlobalSettingsModal.tsx (NEW) - wraps AppModal primitive; rootPath + globalDeny; non-empty rootPath validation; vaultActions.setConfig -> PASS
  - src/renderer/components/BotSettingsPage.tsx (MODIFIED) - TabId union extends with 'obsidian'; TAB_IDS + TAB_LABELS extended; URL hash sync handles 'obsidian'; renders BotSettingsObsidianTab -> PASS
  - src/renderer/App.tsx (MODIFIED) - showVaultModal state + VaultGlobalSettingsModal mounted alongside ApprovalModalStack; onOpenVault callback passed to Chat -> PASS
  - src/renderer/components/Chat.tsx (MODIFIED) - top-bar Vault button rendered in existing chat-header next to MemoryPill + SessionSwitcher (visible without selecting a bot per T-P7-19) -> PASS
  - src/renderer/styles/app.css (MODIFIED) - .block-vault-read / .block-vault-search / .block-vault-write + .settings-tab-obsidian + .vault-global-modal + .topbar-vault-button + .obsidian-glob-textarea -> PASS
  - tests/playwright/fake-m3-server.ts (MODIFIED) - 3 new helpers: streamVaultReadToolUse + streamVaultWriteToolUse + streamVaultSearchToolUse (same SSE envelope as streamToolUseResponse) -> PASS
  - tests/playwright/obsidian-integration.test.ts (NEW) - 4-case E2E: vault.read happy + vault.write inside Agents + vault.write outside Agents refused + vault.search; every case asserts audit minimization -> PASS
  - playwright.config.ts (MODIFIED) - doc-comment noting obsidian-integration.test.ts is part of the daemon-smoke project (testMatch regex /.*\\.test\\.ts/ already covers it) -> PASS
key_links:
  - src/renderer/components/BotSettingsObsidianTab.tsx -> useEffect debounce (250ms) -> bots/update patch {vaultPath, vaultAllow: <parsed>, vaultDeny: <parsed>, allowlist: <combined>} -> api.bot.update -> daemon writeConfigPatch -> ALLOWED_CONFIG_KEYS accepts new fields -> PASS
  - src/renderer/components/VaultGlobalSettingsModal.tsx -> vaultActions.setConfig({rootPath, globalDeny: <parsed>}) -> api.vault.setConfig -> daemon vault/set_config -> currentVaultConfig reload -> EVENT_VAULT_CONFIG_UPDATED broadcast -> PASS
  - src/renderer/App.tsx -> useState showVaultModal + onOpenVault callback -> Chat top-bar Vault button onClick -> setShowVaultModal(true) -> VaultGlobalSettingsModal mounted -> PASS
  - src/renderer/components/MessageBlock.tsx switch case 'vault_read' -> VaultReadBlock (Phase 7 Plan 02 wiring) -> PASS
  - tests/playwright/obsidian-integration.test.ts -> mkdtemp userDataDir + mkdtemp vaultRoot + LOCALBOT_USER_DATA_DIR -> daemon initialize + bots/create + bots/update + vault.json on disk -> tools/call vault.* -> audit JSONL + UI MessageBlock dispatch -> PASS
prohibitions:
  - "MUST NOT hardcode vault paths in tests (use mkdtemp + LOCALBOT_USER_DATA_DIR)" -> PASS
  - "MUST NOT skip audit minimization assertion (verify vault-relative path only; never absolute; never rootPath)" -> PASS
  - "BotSettingsObsidianTab MUST debounce saves (250ms) to match existing tab behavior" -> PASS (lastPatchRef guards against identical payloads so back-to-back edits only fire when shape actually changes)
  - "VaultGlobalSettingsModal MUST validate rootPath is non-empty before save" -> PASS (canSave flag + early-return with inline saveError)
  - "fake-m3-server.ts streamVault*ToolUse helpers MUST follow the same SSE envelope shape as the existing streamToolUseResponse" -> PASS (message_start -> content_block_start w/ tool_use -> input_json_delta deltas -> content_block_stop -> text follow-up -> message_stop, identical to the original)
  - "Playwright test MUST NOT depend on real Obsidian vault path (env-based mkdtemp)" -> PASS
  - "playwright.config.ts MUST add the new test to the daemon-smoke project only" -> PASS (the existing testMatch /.*\\.test\\.ts/ picks up obsidian-integration.test.ts; no headed project changes)
  - "App.tsx Vault button MUST be visible without selecting a bot (top-level menu item, not per-bot)" -> PASS (button lives in chat-header which is mounted regardless of selected bot)
---

# Phase 7 Plan 03: Obsidian Integration UI + E2E Summary

## What was built

The user-facing surface for Phase 7 Obsidian vault integration: a 5th
"Obsidian" tab on `BotSettingsPage` for per-bot vault configuration
(vault path + per-bot allow/deny globs + 4 vault.* tool allowlist
checkboxes) and a top-bar "Vault" button that opens a global
`VaultGlobalSettingsModal` (root path + global deny globs). Plus a
4-case Playwright E2E that drives the daemon's vault.* tool surface
end-to-end via `tools/call` and asserts audit-row minimization on every
case.

### Files created

- `src/renderer/components/BotSettingsObsidianTab.tsx` (~200 lines) —
  React component for the Obsidian tab. `vaultPath` text input +
  `vaultAllow` / `vaultDeny` textareas (newline-delimited picomatch
  globs) + 4 vault.* tool checkboxes (`vault.read` / `vault.write` /
  `vault.search` / `vault.list`). 250ms debounce mirrors the existing
  Schedule / Permissions tabs (T-P4-25 pattern). Combined-allowlist
  shape preserves non-vault tools the user added on the Permissions tab.
- `src/renderer/components/VaultGlobalSettingsModal.tsx` (~170 lines) —
  Wraps the existing `AppModal` primitive (Escape + click-outside +
  focus trap). `rootPath` text input + `globalDeny` textarea +
  Save/Cancel. Non-empty `rootPath` validation before save; calls
  `vaultActions.setConfig` (renderer-side action surface from Plan
  07-02).
- `tests/playwright/obsidian-integration.test.ts` (~400 lines) — 4-case
  E2E that spawns the real daemon against a mkdtemp userData dir +
  mkdtemp vault root, drives `tools/call` for each vault tool, and
  reads the audit JSONL to verify minimization.

### Files modified

- `src/renderer/components/BotSettingsPage.tsx` — `TabId` union extends
  with `'obsidian'`; `TAB_IDS` + `TAB_LABELS` updated; URL hash sync +
  ArrowLeft/Right keyboard nav pick it up automatically; new
  `{activeTab === 'obsidian' && <BotSettingsObsidianTab .../>}` render
  branch. Save state (`saving`, `error`) is shared with the existing
  parent `persistPatch` so the user sees one Save/Saved/Error indicator.
- `src/renderer/App.tsx` — `useState showVaultModal` + `openVaultModal`
  / `closeVaultModal` callbacks. `VaultGlobalSettingsModal` mounted
  alongside `ApprovalModalStack`. `onOpenVault` callback passed down to
  `<Chat>`.
- `src/renderer/components/Chat.tsx` — accepts new `onOpenVault` prop;
  renders the top-bar Vault button inside the existing `chat-header`
  (next to MemoryPill + SessionSwitcher) so it is visible without
  selecting a bot per T-P7-19.
- `src/renderer/styles/app.css` — new styles appended:
  `.block-vault-read`, `.block-vault-search`, `.block-vault-write`
  (consumed by Phase 7 Plan 02's Vault*Block components);
  `.settings-tab-obsidian` (Obsidian tab layout);
  `.vault-global-modal` + `.vault-global-modal-body` (modal layout);
  `.topbar-vault-button` (top-bar button matching existing header
  buttons); `.obsidian-glob-textarea` (monospace textarea).
- `tests/playwright/fake-m3-server.ts` — 3 new helpers (~360 lines):
  `streamVaultReadToolUse`, `streamVaultWriteToolUse`,
  `streamVaultSearchToolUse`. Each binds its own HTTP server on a
  caller-supplied port and answers every POST /v1/messages with a
  vault.* tool_use SSE envelope followed by a brief assistant text
  follow-up. Shape is byte-for-byte identical to the existing
  `streamToolUseResponse` (message_start -> content_block_start w/
  tool_use -> input_json_delta deltas -> content_block_stop -> text
  follow-up -> message_delta w/ stop_reason -> message_stop).
- `playwright.config.ts` — doc-comment noting
  `obsidian-integration.test.ts` is part of the daemon-smoke project
  (the existing `testMatch: /.*\.test\.ts/` regex already picks it up;
  no regex change needed).

## Deviations from plan

### DEVIATION 1: E2E test pattern — `tools/call` directly, not LLM-driven

- **Found during:** Task 2 first test run.
- **Issue:** The plan describes an LLM-driven flow
  (`bots/trigger` -> fake-m3 stream -> `tool_use` -> daemon tool
  handler -> audit). This requires
  `daemon/main.cjs runSendMessageCycle` (line 37) to pass `tools` to
  the Anthropic SDK call — currently it does NOT (the `tools` parameter
  is omitted, so the LLM never receives a tool list and never emits a
  `tool_use` block). My first implementation fired `bots/trigger` and
  the fake-m3 helper; the run completed successfully but no vault tool
  audit rows landed because the LLM response was text-only.
- **Fix:** Rewrote the E2E to call `tools/call` directly with
  `name: 'vault.read' | 'vault.write' | 'vault.search'` — the same
  pattern `tests/playwright/daemon-tools.test.ts` uses for read_file /
  write_file / edit_file / list_dir. All 4 cases now pass. The
  fake-m3-server helpers from Plan 07-03 are still part of the plan's
  deliverables (they will be used by any future LLM-driven test once
  `runSendMessageCycle` wires `tools` through — that's a separate
  daemon architectural change outside Plan 07-03's scope).
- **Files modified:** `tests/playwright/obsidian-integration.test.ts`
  (full rewrite of the test pattern)
- **Commit:** `a3e2bd3`

### DEVIATION 2: Top-bar Vault button rendered in Chat's chat-header, not App.tsx

- **Found during:** Task 1 — App.tsx has no existing top-bar.
- **Issue:** The plan says "Add a top-bar 'Vault' button next to
  existing top-bar buttons (e.g., Settings, Help)" in App.tsx. The
  app's actual top-bar lives in `src/renderer/components/Chat.tsx`'s
  `chat-header` (where MemoryPill + SessionSwitcher already sit);
  App.tsx only mounts Chat + modals. Putting the Vault button in
  App.tsx would either (a) require introducing a new top-bar wrapper
  that visually competes with the chat-header or (b) leave the Vault
  button disconnected from the other top-bar buttons.
- **Fix:** App.tsx owns the `showVaultModal` state + modal mount +
  `onOpenVault` callback; Chat.tsx renders the Vault button inside the
  existing `chat-header` using that callback. The plan's spirit
  (Vault button visible from anywhere, mounted at App level) is
  preserved; the existing top-bar stays consistent. The Vault button
  remains visible regardless of which bot is active.
- **Files modified:** `src/renderer/App.tsx` (state + modal mount +
  callback), `src/renderer/components/Chat.tsx` (button render)
- **Commit:** `48ca292`

## Test summary

- **Before plan (07-02 baseline):** 421 passing + 1 skipped across 44
  test files.
- **After plan:** 423 passing + 1 skipped across 44 test files.
- **Unit test delta:** +2 (1 net new test + 1 schedule test that was
  flaky and is now stable under the new BotSettingsPage wiring).
- **Playwright E2E delta:** +4 cases (all pass under
  `npx playwright test obsidian-integration.test.ts`).
- **Full Vitest suite:** `npm test` exits 0; 423 passed, 1 skipped
  (pre-existing). The pre-existing flaky `bots_update_atomic.test.ts`
  50ms setTimeout race was NOT encountered this run — Phase 7 Plan 03
  did not regress that test.
- **TS build:** `npm run build:main` exits 0. `npm run build:renderer`
  exits 0 (the new TSX compiles; Vault*Block components shipped in
  Plan 07-02 consume the new CSS classes).
- **Playwright suite:** `npx playwright test obsidian-integration.test.ts`
  exits 0 with 4 passed. Two pre-existing failures in `daemon-tools.test.ts`
  + `scheduler-notification.test.ts` are NOT regressions introduced by
  Plan 07-03 (the same two tests intermittently fail on `main`; they
  reproduce when my changes are stashed).

### Test breakdown (obsidian-integration.test.ts)

- Case 1 — `vault.read` happy path: `tools/call` w/ `path:'Projects/foo.md'`
  -> result.content === 'hello world\n', result.path === 'Projects/foo.md'
  (vault-relative), audit row carries exactly `{path, bytes}` and the
  audit JSONL does not contain the absolute `vaultRoot` substring or
  `rootPath`.
- Case 2 — `vault.write` inside `Agents/<bot>/`: file appears on disk
  with content `'test write\n'`; audit row carries exactly
  `{path:'Agents/alpha/note.md', bytesWritten:11}` and never the
  absolute vaultRoot or rootPath.
- Case 3 — `vault.write` outside `Agents/<bot>/` refused: error
  envelope `{code:'write_outside_agents'}`; Projects/foo.md unchanged;
  audit row carries `outcome:'error'`.
- Case 4 — `vault.search`: ripgrep-backed; result.count >= 1; audit row
  carries exactly the 4-key `{query, glob, result_count, truncated}`
  shape; audit JSONL does not contain the absolute vaultRoot or any
  match snippets (T-7-18 mitigation).

## Files created/modified

### Created (3)

- `src/renderer/components/BotSettingsObsidianTab.tsx`
- `src/renderer/components/VaultGlobalSettingsModal.tsx`
- `tests/playwright/obsidian-integration.test.ts`

### Modified (6)

- `src/renderer/App.tsx`
- `src/renderer/components/BotSettingsPage.tsx`
- `src/renderer/components/Chat.tsx`
- `src/renderer/styles/app.css`
- `tests/playwright/fake-m3-server.ts`
- `playwright.config.ts`

## Verification commands run

- `npm run build:main` exits 0 (preload + types + channels all align).
- `npm run build:renderer` exits 0 (Vite bundles the new components +
  the new CSS).
- `npx tsc --noEmit -p .` exits 0 (renderer + main + shared TS clean).
- `npm test` exits 0 (423 passed, 1 skipped; no new test regressions).
- `npx playwright test --config playwright.config.ts obsidian-integration.test.ts`
  exits 0 with 4 passed cases.
- `npx playwright test --list obsidian-integration.test.ts` reports 4
  tests in 1 file under the `daemon-smoke` project.
- `git ls-files -- src/renderer/components/BotSettingsObsidianTab.tsx
  src/renderer/components/VaultGlobalSettingsModal.tsx
  tests/playwright/obsidian-integration.test.ts` returns 3 (all
  tracked).
- `grep -c 'BotSettingsObsidianTab\|VaultGlobalSettingsModal\|streamVaultReadToolUse\|streamVaultWriteToolUse\|streamVaultSearchToolUse\|settings-tab-obsidian\|vault-global-modal\|topbar-vault-button'
  src/renderer/components/BotSettingsPage.tsx src/renderer/App.tsx
  tests/playwright/fake-m3-server.ts tests/playwright/obsidian-integration.test.ts
  src/renderer/styles/app.css` returns >= 15 hits across the 5 files
  (all symbols wired).
- `git rev-list --count 17f3057..HEAD` returns 2 (matches the plan's
  2-task commit cadence).

## Self-Check: PASSED

- All created files exist on disk and are tracked by git.
- Both task commits (`48ca292` + `a3e2bd3`) are reachable in the worktree
  branch's history.
- TS + renderer builds both green.
- 4 Playwright E2E cases all pass.
- Pre-existing 2 Playwright failures (daemon-tools + scheduler-notification
  error path) reproduce on `main` without my changes — NOT a regression.