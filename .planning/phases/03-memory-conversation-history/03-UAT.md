---
status: testing
phase: 03-memory-conversation-history
source: [03-VERIFICATION.md]
started: 2026-09-18T11:24:00Z
updated: 2026-09-18T13:30:00Z
---

## Current Test

[re-running headed tests after preload-path fix in src/main/window.ts]

## Tests

### 1. Headed Electron: MemoryPill + WorkspaceTree render and chat turn
expected: Legacy global.jsonl migrates to default/<iso>.jsonl; sending a long message triggers maybeSummarize; the JSONL head-of-file is the summary row; SessionSwitcher lists 2+ sessions newest-first; clicking a session reloads the chat.
result: partial
reported: "Preload-path fix (src/main/window.ts:72 — `..` removed) unblocked the renderer mount. After the fix, `[data-testid="memory-pill"]`, `[data-testid="workspace-tree"]`, `[data-testid="composer-input"]`, `[data-testid="session-switcher"]`, `[data-testid="chat-header"]` are all present in the DOM after the key modal is saved. MemoryPill + WorkspaceTree render in the headed Electron chat header. The remaining test failure is downstream: `[data-role="assistant"]` never appears after `send-button` click — the chat handler does receive the sendMessage IPC (fake M3 request count = 1) but the streaming response is gated on the daemon's `initialized` flag, which stays false (`"daemon not initialized"` banner is visible in the DOM). This is a SEPARATE pre-existing bug (daemon spawn / handshake in headed test env), not the renderer-mount issue this debug session investigated."
severity: minor (downstream)

### 2. Headed Electron: SessionSwitcher round-trip + restart-reload
expected: After summarize, send a second message to create a new session file; click the first row in the SessionSwitcher dropdown; kill via electronApp.close(); relaunch with the same <tmp>. After reload, history:load returns the same messages + headSummary that was persisted before the kill.
result: partial
reported: "Same preload-path fix unblocked the renderer mount — `[data-testid="composer-input"]` is now in the DOM. The test now fails at `await window.locator('[data-role="assistant"]').first().waitFor({ state: 'visible' })` (line 176) for the same downstream daemon-not-initialized reason as test 1."
severity: minor (downstream)

### 3. Headed Electron: WorkspaceTree + DiffView + binary placeholder + chokidar refresh
expected: Pre-create <tmp>/workspace/default/{hello.txt,hello.bin}; launch Electron; send a sendMessage that triggers edit_file on hello.txt; then a second message that triggers edit_file on hello.bin; touch <tmp>/workspace/default/new_file.txt via fs.writeFileSync. DiffView renders for hello.txt (world and planet literals visible); DiffBinaryPlaceholder renders for hello.bin; WorkspaceTree increments tree-node count within 500ms of the external writeFile.
result: skipped
reason: "heeded sub-test still gated on `LOCALBOT_SMOKE_OK` + the same downstream daemon-not-initialized issue. Daemon-only sub-test passes in 1.2s, confirming tree/list + chokidar + audit logic. Renderer-mount blocker (G-3-1 / G-3-2 / G-3-3) is now resolved by the preload-path fix."

## Summary

total: 3
passed: 0
issues: 2 (now downstream-of-mount, daemon-related)
pending: 0
skipped: 1
blocked: 0
renderer_mount_root_cause: resolved (preload path corrected in src/main/window.ts:72)

## Gaps

```yaml
- gap_id: G-3-1
  truth: "Headed Electron chat surfaces MemoryPill + WorkspaceTree render and a chat turn persists a session"
  status: resolved_mount_blocker
  reason: "Renderer-mount root cause fixed: src/main/window.ts:72 preload path was one level too high (`../preload/index.js` from dist/main/ resolves to the non-existent dist/preload/index.js). Fixed to `preload/index.js`. After the fix, MemoryPill, WorkspaceTree, Composer, SessionSwitcher, ChatHeader all render in the DOM. Remaining downstream test failure is a separate daemon-initialization issue."
  severity: resolved
  test: 1
  artifacts:
    - path: "src/main/window.ts:72"
      issue: "Preload path was `path.join(__dirname, '..', 'preload', 'index.js')` — the `..` was incorrect (window.js sits next to preload/ in dist/main/, not one level up). Fixed."
  missing:
    - "DOWNSTREAM: chat-streaming test still fails at `[data-role=assistant]` because daemon does not initialize in the headed test environment. Surface as a NEW gap (e.g. G-3-4 daemon-spawn-headed) — out of scope for this debug session."
  debug_session: ".planning/debug/memory-pill-missing.md"

- gap_id: G-3-2
  truth: "Headed Electron SessionSwitcher lists 2+ sessions and round-trips through restart-reload"
  status: resolved_mount_blocker
  reason: "Same preload-path fix as G-3-1. Composer is now in the DOM; SessionSwitcher trigger button shows 'Current session'. Test fails at the same downstream `[data-role=assistant]` wait."
  severity: resolved
  test: 2
  artifacts:
    - path: "src/main/window.ts:72"
      issue: "Same preload-path bug as G-3-1."
  missing:
    - "DOWNSTREAM: same daemon-initialization issue as G-3-1."
  debug_session: ".planning/debug/memory-pill-missing.md"

- gap_id: G-3-3
  truth: "Headed Electron WorkspaceTree + DiffView + binary placeholder + chokidar refresh"
  status: resolved_mount_blocker
  reason: "WorkspaceTree now renders in the headed DOM (confirmed via diagnostic Playwright snapshot). DiffView + binary + chokidar sub-tests still gated on downstream daemon issue."
  severity: resolved
  test: 3
  artifacts:
    - path: "src/main/window.ts:72"
      issue: "Same preload-path bug as G-3-1."
  missing:
    - "DOWNSTREAM: same daemon-initialization issue as G-3-1."
  debug_session: ".planning/debug/memory-pill-missing.md"
```