---
status: testing
phase: 03-memory-conversation-history
source: [03-VERIFICATION.md]
started: 2026-09-18T11:24:00Z
updated: 2026-09-18T11:24:00Z
---

## Current Test

number: 1
name: Headed Electron: MemoryPill + WorkspaceTree render + legacy migration + long-stream summarize
expected: |
  Set LOCALBOT_SMOKE_OK=1 and run `npx playwright test tests/playwright/memory-history.test.ts` against a real desktop session. Pre-create `<tmp>/sessions/global.jsonl` with 5 mock rows; launch Electron with LOCALBOT_USER_DATA_DIR=<tmp> + LOCALBOT_SOFT_CAP_TOKENS=10 + M3_PORT=<fake-m3>.
  Expected: Legacy global.jsonl migrates to default/<iso>.jsonl; sending a long message triggers maybeSummarize; the JSONL head-of-file is the summary row; SessionSwitcher lists 2+ sessions newest-first; clicking a session reloads the chat.
awaiting: user response

## Tests

### 1. Headed Electron: MemoryPill + WorkspaceTree render and chat turn
expected: Legacy global.jsonl migrates to default/<iso>.jsonl; sending a long message triggers maybeSummarize; the JSONL head-of-file is the summary row; SessionSwitcher lists 2+ sessions newest-first; clicking a session reloads the chat.
result: [pending]

### 2. Headed Electron: SessionSwitcher round-trip + restart-reload
expected: After summarize, send a second message to create a new session file; click the first row in the SessionSwitcher dropdown; kill via electronApp.close(); relaunch with the same <tmp>. After reload, history:load returns the same messages + headSummary that was persisted before the kill.
result: [pending]

### 3. Headed Electron: WorkspaceTree + DiffView + binary placeholder + chokidar refresh
expected: Pre-create <tmp>/workspace/default/{hello.txt,hello.bin}; launch Electron; send a sendMessage that triggers edit_file on hello.txt; then a second message that triggers edit_file on hello.bin; touch <tmp>/workspace/default/new_file.txt via fs.writeFileSync. DiffView renders for hello.txt (world and planet literals visible); DiffBinaryPlaceholder renders for hello.bin; WorkspaceTree increments tree-node count within 500ms of the external writeFile.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps

None — the 3 headed items are gated by LOCALBOT_SMOKE_OK=1 (desktop-session only, same pattern Phase 2 used). Deterministic daemon + unit coverage already proves the full vertical: 138/138 unit tests + 6/6 daemon-only Playwright smokes + 1 documented safeStorage skip. All 4 Phase 3 requirements (AGENT-05, AGENT-06, LLM-04, UI-08) are covered by automated tests.
