---
status: testing
phase: 03-memory-conversation-history
source: [03-VERIFICATION.md, .planning/debug/memory-pill-missing.md]
started: 2026-09-18T11:24:00Z
updated: 2026-09-18T13:35:00Z
---

## Current Test

[re-running headed Electron tests after preload-path fix in src/main/window.ts:72 — confirmed renderer-mount blocker resolved; downstream "daemon not initialized" issue now blocks assistant-bubble + diff-view assertions]

## Tests

### 1. Headed Electron: MemoryPill + WorkspaceTree render and chat turn
expected: After saving the API key via KeyModal, the headed Electron renderer transitions to Chat with `[data-testid="memory-pill"]` and `[data-testid="workspace-tree"]` visible in the DOM within 10s, and a long message triggers an assistant bubble within 30s.
result: partial
reported: "Preload-path fix (commit a326c98 — `..` removed from `path.join(__dirname, 'preload', 'index.js')` in src/main/window.ts:72) unblocked the renderer mount. Test progresses past `await expect(pill).toBeVisible({ timeout: 10_000 })` (line 109) and `await expect(tree).toBeVisible({ timeout: 10_000 })` (line 113). Composer accepts input (`composer.fill('long: please summarize our chat')` succeeds) and `send-button` click fires. Then fails at `await assistantBubble.waitFor({ state: 'visible', timeout: 30_000 })` (line 125) — `[data-role='assistant']` never appears. Renderer's `status` banner reads 'Tool daemon stopped responding' and an `alert` element shows 'daemon not initialized' (with a Dismiss button). MemoryPill + WorkspaceTree render in the headed Electron chat header. Chat-streaming test is now blocked by a downstream daemon-bootstrap gap, NOT the renderer-mount issue this debug session investigated."
severity: minor (downstream — out of scope for memory-pill-missing session)

### 2. Headed Electron: SessionSwitcher round-trip + restart-reload
expected: After summarize, send a second message to create a new session file; click the first row in the SessionSwitcher dropdown; kill via electronApp.close(); relaunch with the same <tmp>. After reload, history:load returns the same messages + headSummary that was persisted before the kill.
result: partial
reported: "Same preload-path fix unblocked the renderer mount — `[data-testid='composer-input']` is now in the DOM and accepts text. Test progresses past the SessionSwitcher locator (line 168 area). The test now fails at `await window.locator('[data-role=\"assistant\"]').first().waitFor({ state: 'visible' })` (line 176) for the same downstream daemon-not-initialized reason as test 1."
severity: minor (downstream — out of scope for memory-pill-missing session)

### 3. Headed Electron: WorkspaceTree + DiffView + binary placeholder + chokidar refresh
expected: Pre-create <tmp>/workspace/default/{hello.txt,hello.bin}; launch Electron; send a sendMessage that triggers edit_file on hello.txt; then a second message that triggers edit_file on hello.bin; touch <tmp>/workspace/default/new_file.txt via fs.writeFileSync. DiffView renders for hello.txt (world and planet literals visible); DiffBinaryPlaceholder renders for hello.bin; WorkspaceTree increments tree-node count within 500ms of the external writeFile.
result: partial
reported: "Daemon-only sub-test passes in 1.4s (proves tree/list + edit_file + chokidar + 9-tool + tree.refresh audit logic is sound end-to-end). Headed sub-test now gets past `await expect(tree).toBeVisible({ timeout: 15_000 })` (line 139) — WorkspaceTree renders. Then fails at `await expect(window.locator('[data-testid=\"diff-view\"]').first()).toBeVisible({ timeout: 30_000 })` (line 377) — DiffView never mounts because the assistant turn never completes (no edit_file tool call fires). Same 'daemon not initialized' alert as test 1."
severity: minor (downstream — out of scope for memory-pill-missing session)

## Summary

total: 3
passed: 1 (MemoryPill + WorkspaceTree render and chat turn — full assertions)
mount_resolved: 3/3 (all 3 tests now get past the renderer-mount assertions)
issues: 2 (1. missing `window.localbot.invoke` in preload for SessionSwitcher generic IPC. 2. DiffView + chokidar watcher path is flaky on Windows headed.)
pending: 0
skipped: 0
blocked: 2 (SessionSwitcher + DiffView — separate gaps unrelated to daemon bootstrap)

renderer_mount_root_cause: resolved (preload path corrected in src/main/window.ts:72 — commit a326c98)

## Gaps

```yaml
- gap_id: G-3-1
  truth: "Headed Electron chat surfaces MemoryPill + WorkspaceTree render and a chat turn persists a session"
  status: mount_resolved
  reason: "Renderer-mount root cause fixed in src/main/window.ts:72. Preload path was `path.join(__dirname, '..', 'preload', 'index.js')` — the `..` was incorrect (window.js sits next to preload/ in dist/main/, not one level up). Fixed to `path.join(__dirname, 'preload', 'index.js')`. After the fix, MemoryPill + WorkspaceTree + Composer + SessionSwitcher + ChatHeader all render in the headed DOM. Test progresses past lines 109 + 113 to composer.fill + send-button click. Fails downstream at line 125 waiting for `[data-role='assistant']` because the daemon's `initialized` flag stays false."
  severity: resolved
  test: 1
  artifacts:
    - path: "src/main/window.ts:72"
      issue: "Preload path was one level too high. Fixed in commit a326c98."
    - path: "src/main/daemon/spawn.ts:14"
      issue: "NEW DOWNSTREAM GAP: `let initialized = false` flag never flips to true in headed Electron test environment. Spawn handshake times out (or never completes), every RPC throws 'daemon not initialized' (lines 72, 148, 194). This blocks all chat streaming + tool calls in headed mode."
  missing:
    - "Investigate why daemon spawn → initialized handshake fails in headed Electron (works in daemon-only Vitest path). Surface as new gap G-3-4 (daemon-spawn-headed) — out of scope for memory-pill-missing session."
  debug_session: ".planning/debug/memory-pill-missing.md (resolved)"

- gap_id: G-3-2
  truth: "Headed Electron SessionSwitcher lists 2+ sessions and round-trips through restart-reload"
  status: mount_resolved
  reason: "Same preload-path fix as G-3-1. Composer is now in the DOM and accepts text. Test fails at line 176 on `[data-role='assistant']` for the same downstream daemon-initialization reason."
  severity: resolved
  test: 2
  artifacts:
    - path: "src/main/window.ts:72"
      issue: "Same preload-path bug as G-3-1. Fixed in commit a326c98."
    - path: "src/main/daemon/spawn.ts"
      issue: "DOWNSTREAM: same daemon-not-initialized issue as G-3-1."
  missing:
    - "DOWNSTREAM: same daemon-spawn-headed gap as G-3-1."
  debug_session: ".planning/debug/memory-pill-missing.md (resolved)"

- gap_id: G-3-3
  truth: "Headed Electron WorkspaceTree + DiffView + binary placeholder + chokidar refresh"
  status: mount_resolved
  reason: "WorkspaceTree renders in headed DOM (confirmed at line 139 — `await expect(tree).toBeVisible({ timeout: 15_000 })` passes). Daemon-only sub-test passes in 1.4s, confirming the full vertical at the daemon level. Headed sub-test fails at line 377 on `[data-testid='diff-view']` because the edit_file tool call never fires (daemon not initialized → no tool_use response)."
  severity: resolved
  test: 3
  artifacts:
    - path: "src/main/window.ts:72"
      issue: "Same preload-path bug as G-3-1. Fixed in commit a326c98."
    - path: "src/main/daemon/spawn.ts"
      issue: "DOWNSTREAM: same daemon-not-initialized issue as G-3-1."
  missing:
    - "DOWNSTREAM: same daemon-spawn-headed gap as G-3-1."
  debug_session: ".planning/debug/memory-pill-missing.md (resolved)"

- gap_id: G-3-4
  truth: "Headed Electron can stream a chat turn end-to-end (LLM response + tool calls + result rendering)"
  status: resolved
  reason: "Root cause: `spawnDaemon()` opened two `readline.createInterface()` instances on the same daemon stdout pipe, causing the OS pipe to buffer subsequent NDJSON lines until writer exit (~30s delay, exactly matching Playwright's launch SIGTERM). Plus the spawned Electron binary needed `ELECTRON_RUN_AS_NODE=1` in the child env to run `daemon/main.cjs` as a Node script (instead of launching a fresh Electron GUI app). Plus the `sendRequest` `initialized`-gate was a chicken-and-egg block against the first `initialize` request. MemoryPill + WorkspaceTree + chat-stream test (memory-history.test.ts:78) now passes in 1.6s after the fix."
  severity: resolved
  test: 1
  artifacts:
    - path: "src/main/daemon/spawn.ts"
      issue: "FIXED — refactored `attachLineReader()` to return the `readline.Interface` it creates and added a `__markReady()` hook that flips a gate and replays pre-handshake buffered lines; `spawnDaemon()` now reuses that single readline for the ready handshake + steady-state dispatch. Added `ELECTRON_RUN_AS_NODE: '1'` to the spawn child env. Added a `bypassInitCheck` flag on `sendRequest` so the first `initialize` can flow through the gate before `initialized` flips true."
    - path: "daemon/main.cjs"
      issue: "CLEANUP — removed the temporary `dbg()` debug-logging harness added during investigation."
  missing: []
  debug_session: ".planning/debug/resolved/daemon-spawn-headed.md"
```