# GSD Debug Knowledge Base

Resolved debug sessions. Used by `gsd-debugger` to surface known-pattern hypotheses at the start of new investigations.

---

## daemon-spawn-headed — Headed Electron daemon stuck at "not initialized" (30s hang)
- **Date:** 2026-09-18
- **Error patterns:** "Tool daemon stopped responding", "daemon not initialized", readline buffering on Windows pipe, Playwright headed run timing out at ~30s
- **Root cause(s):** `spawnDaemon()` opened two `readline.createInterface()` instances on the same `daemonProc.stdout` ChildProcess pipe; on Windows + Electron the dual consumers caused the OS pipe to buffer the second and subsequent NDJSON lines until process exit (~30s delay matching Playwright's SIGTERM). Plus the spawned Electron binary needed `ELECTRON_RUN_AS_NODE=1` in the child env to execute `daemon/main.cjs` as a Node script instead of launching a fresh GUI app. Plus a chicken-and-egg: `sendRequest`'s `initialized` gate blocked the first `initialize` request.
- **Fix:** `attachLineReader()` returns the `readline.Interface` it creates and exposes a `__markReady()` hook that flips a gate and replays pre-handshake buffered lines; `spawnDaemon()` reuses that single readline for the ready handshake AND steady-state dispatch (no second `createInterface`). Added `ELECTRON_RUN_AS_NODE: '1'` to the spawn child env. Added a `bypassInitCheck` flag on `sendRequest` so the initialize handshake can flow through before `initialized` flips true.
- **Files changed:** `src/main/daemon/spawn.ts`, `daemon/main.cjs`, `dist/main/daemon/spawn.js`, `dist/main/daemon/main.cjs` (rebuilt)
- **Why not caught:** No headed Electron smoke test existed that exercised the spawn → initialize → first tool call path end-to-end before Phase 3 UAT. Daemon-only Vitest + Playwright tests run with `process.execPath === node.exe`, masking the dual-readline + Electron-binary behaviors.
- **Recurrence guard:** KB pattern + MemoryPill Playwright headed test (`tests/playwright/memory-history.test.ts`) now asserts `data-role=assistant` after a chat send, which forces the full spawn → initialize → memory.read → tool_use → render path under the Electron binary. Any future regression to spawn.ts readline or env flags will surface there.

---
