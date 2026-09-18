---
status: testing
phase: 03-memory-conversation-history
source: [03-VERIFICATION.md]
started: 2026-09-18T11:24:00Z
updated: 2026-09-18T11:34:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Headed Electron: MemoryPill + WorkspaceTree render and chat turn
expected: Legacy global.jsonl migrates to default/<iso>.jsonl; sending a long message triggers maybeSummarize; the JSONL head-of-file is the summary row; SessionSwitcher lists 2+ sessions newest-first; clicking a session reloads the chat.
result: issue
reported: "After fixing PowerShell env var (was skipped on first try, now runs): Locator: locator('[data-testid=memory-pill]') not visible within 10000ms — at tests/playwright/memory-history.test.ts:109. MemoryPill + WorkspaceTree fail to render in the headed Electron chat header."
severity: major

### 2. Headed Electron: SessionSwitcher round-trip + restart-reload
expected: After summarize, send a second message to create a new session file; click the first row in the SessionSwitcher dropdown; kill via electronApp.close(); relaunch with the same <tmp>. After reload, history:load returns the same messages + headSummary that was persisted before the kill.
result: issue
reported: "TimeoutError: locator.fill: Timeout 30000ms exceeded. waiting for locator('[data-testid=composer-input]') at tests/playwright/memory-history.test.ts:171. Composer never mounted (or never received data-testid='composer-input') in the headed renderer."
severity: major

### 3. Headed Electron: WorkspaceTree + DiffView + binary placeholder + chokidar refresh
expected: Pre-create <tmp>/workspace/default/{hello.txt,hello.bin}; launch Electron; send a sendMessage that triggers edit_file on hello.txt; then a second message that triggers edit_file on hello.bin; touch <tmp>/workspace/default/new_file.txt via fs.writeFileSync. DiffView renders for hello.txt (world and planet literals visible); DiffBinaryPlaceholder renders for hello.bin; WorkspaceTree increments tree-node count within 500ms of the external writeFile.
result: skipped
reason: "Env var not re-set in this shell session — `$env:LOCALBOT_SMOKE_OK = "1"` is per-shell in PowerShell, so the headed test was skipped. Daemon-only sub-test passed in 1.2s, confirming the underlying tree/list + chokidar + audit logic is sound. Headed sub-test skipped because the renderer-mount blocker from G-3-1/G-3-2 (MemoryPill and Composer missing in headed mode) almost certainly affects WorkspaceTree + DiffView too — re-running headed would surface the same root cause rather than fresh evidence."

## Summary

total: 3
passed: 0
issues: 2
pending: 0
skipped: 1
blocked: 0

## Gaps

```yaml
- gap_id: G-3-1
  truth: "Headed Electron chat surfaces MemoryPill + WorkspaceTree render and a chat turn persists a session"
  status: failed
  reason: "User reported (after fixing env var): Locator: locator('[data-testid=memory-pill]') not visible within 10000ms — at tests/playwright/memory-history.test.ts:109. The MemoryPill never reaches the DOM in the headed Electron renderer."
  severity: major
  test: 1
  artifacts:
    - path: "src/renderer/components/MemoryPill.tsx"
      issue: "Likely missing data-testid=memory-pill attribute on the rendered root element (or component never mounts in headed mode)"
    - path: "src/renderer/components/WorkspaceTree.tsx"
      issue: "Likely missing data-testid=workspace-tree attribute on the rendered root (same root cause as MemoryPill — second locator on the same line not visible either)"
  missing:
    - "Confirm whether the test selectors were never wired to the components, or whether the components are conditionally not rendering in headed mode (renderer boot, IPC bridge, or feature-flag path)"
  debug_session: ".planning/debug/uat-memory-pill-missing.md"

- gap_id: G-3-2
  truth: "Headed Electron SessionSwitcher lists 2+ sessions and round-trips through restart-reload"
  status: failed
  reason: "User reported: TimeoutError waiting for locator('[data-testid=composer-input]') at tests/playwright/memory-history.test.ts:171. The composer never reaches the DOM within 30s, blocking the test before SessionSwitcher can be exercised."
  severity: major
  test: 2
  artifacts:
    - path: "src/renderer/components/Composer.tsx (or equivalent)"
      issue: "Likely missing data-testid=composer-input attribute on the textarea/input root, OR composer never mounts in headed Electron (same renderer-boot blocker as gap G-3-1 — the composer fails before the chat ever sends)"
  missing:
    - "Verify the chat renderer's bootstrap path actually mounts Composer in headed Electron; if the headed vertical truly starts blank, gaps G-3-1 and G-3-2 share a single renderer-mount root cause"
  debug_session: ".planning/debug/uat-session-switcher-composer-missing.md"

- gap_id: G-3-3
  truth: "Headed Electron WorkspaceTree + DiffView + binary placeholder + chokidar refresh"
  status: skipped
  reason: "Headed test was skipped (env var not re-set in this shell); daemon-only sub-test passed in 1.2s, confirming the tree/list + chokidar + audit logic. Headed sub-test not retried because the renderer-mount blocker captured by G-3-1 (MemoryPill missing) and G-3-2 (Composer missing) very likely affects WorkspaceTree + DiffView too — re-running headed would surface the same root cause rather than fresh evidence."
  severity: major
  test: 3
  artifacts: []
  missing:
    - "Covered transitively by G-3-1 + G-3-2 — if the renderer-mount root cause is fixed, both will resolve together"
  debug_session: ".planning/debug/uat-tree-diff-headed.md"
```