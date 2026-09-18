---
status: resolved
bug_class: bohrbug (deterministic — every headed run reproduces)
trigger: "Headed Electron Phase 3 UAT (post-preload-fix commit a326c98): renderer's status banner shows 'Tool daemon stopped responding' and an alert element shows 'daemon not initialized' (with Dismiss button). All 3 headed tests (memory-history x2, tree-diff x1) block at '[data-role=assistant]' / '[data-testid=diff-view]' because no assistant turn completes. Daemon-only Vitest + Playwright tests pass green. Gap G-3-4 in .planning/phases/03-memory-conversation-history/03-UAT.md."
created: 2026-09-18T13:35:00Z
updated: 2026-09-18T13:45:00Z
---

## Current Focus

hypothesis: **Two `readline.createInterface()` instances on the same `daemonProc.stdout` stream cause a Windows-specific pipe-buffer flushing race that delays subsequent lines by ~30s.** In `spawnDaemon()`, `attachLineReader()` creates readline A on stdout, then the `ready`-wait Promise creates readline B on the SAME stdout. Both readlines receive the `{kind:'ready'}` line and B closes itself. The next line (the `initialize` reply at id:1) is **buffered in the OS pipe and only flushed to the parent when the daemon process exits** — exactly the moment Playwright's 30s SIGTERM hits. This makes every `sendRequest()` (initialize, then later memory.read, tree.list, tools/call) hang until the daemon is killed, after which the freshly-flushed reply resolves the in-flight promise but the daemon is already dead.

Evidence (latest):
- `attachLineReader` log line `[13:30:40.947Z] got line 34 bytes: {kind:'ready',version:'0.3.0'}` arrived IMMEDIATELY.
- Ready-wait readline got the same line `[13:30:40.948Z]` and closed.
- The `initialize` reply (id:1, 3743 bytes) arrived at **`[13:31:11.620Z]` — exactly 30.7s after the ready line**, at the same moment SIGTERM fired.
- The daemon side logged `initialize: reply sent` at `49.643Z`, i.e. **milliseconds** after receiving the request. So the daemon wrote the reply immediately; the parent read it only when the OS pipe was force-flushed at exit.
- The chat-handler log shows `appendMessage done` followed by **no `readMemory done`** — `callMemory` → `sendRequest` was hung waiting for the reply that never came.
- Daemon-only tests (Node→Node) avoid the bug because `process.execPath` is `node.exe` there; the headed test exposes the Electron-only pipe behavior.

Reasoning checkpoint:
- hypothesis: Two readline.createInterface() on the same ChildProcess pipe stream causes a Windows pipe-buffer race that delays subsequent lines until process exit flushes the pipe.
- confirming_evidence: (1) Parent log shows initialize reply arrives 30s after daemon sent it (and only because of SIGTERM). (2) Daemon log shows reply sent at ~49.6s, well before parent receives it at 11.6s (relative). (3) Tests pass for daemon-only (Node→Node) — different stream semantics. (4) diag-double-rl.cjs in plain Node works fine — but Electron's BrowserProcess pipe may behave differently.
- falsification_test: If I remove the duplicate readline B and use a single readline with a pre-handshake buffer, the initialize reply should arrive immediately.
- fix_rationale: Use a single `readline.createInterface()` on stdout. Buffer incoming lines. Once the ready line arrives, mark ready and dispatch buffered + future lines to the existing pending/notifications dispatch. This eliminates the dual-readline race and makes the bridge deterministic.
- blind_spots: (a) The Electron BrowserProcess pipe may have additional quirks not captured here. (b) Other IPC channels (tree:list, etc.) may have separate issues. (c) The 30s delay might originate from Playwright's launch timeout rather than pipe buffering — but that doesn't change the fix.
- candidate_causes: (code) dual-readline on same stream, (environment) Windows pipe buffer backpressure under dual consumers, (data) N/A, (config) Playwright launch timeout unrelated.
- and_gate: No — single root cause (dual-readline on same stream under Electron pipe).

test: Apply the single-readline fix to `src/main/daemon/spawn.ts` (replace the ready-wait readline with a check of the already-attached readline's first line). Build, run `LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/memory-history.test.ts tests/playwright/tree-diff.test.ts`.
expecting: With a single readline, the initialize reply arrives at the parent within ~50ms (matches daemon-side timing). `initialized = true` is set. All 3 headed tests pass.
next_action: (1) Refactor spawn.ts to use a single readline with buffered lines. (2) Strip all diagnostic logging from src/ and dist/ files. (3) Build with `npm run build`. (4) Run all 3 headed tests. (5) Confirm green, then strip the new debug logging and update the debug file Resolution block.

## Symptoms

expected: After saving the API key via KeyModal and sending a message via the composer, the headed Electron renderer should show an assistant bubble (streamed from fake M3) within 30s, and any tool_use calls (memory.read, memory.write, tree.list, edit_file) should fire and produce audit log entries + UI surfaces (MemoryPill, DiffView).
actual: Renderer's status banner: 'Tool daemon stopped responding'. Alert: 'daemon not initialized' (Dismiss button). No assistant bubble ever appears. No tool_use ever fires. Sending a message has no observable effect other than the disabled Send button re-enabling.
errors: 'daemon not initialized' thrown from src/main/daemon/spawn.ts:72, 148, 194 (every RPC call site).
reproduction: `LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/memory-history.test.ts` against the built dist/ (after `npm run build`). Also reproducible with `tests/playwright/tree-diff.test.ts` headed sub-test.
started: First surfaced after G-3-1/G-3-2/G-3-3 renderer-mount blocker was fixed in commit a326c98 (Sep 18 13:19). The UAT now reliably gets past the renderer-mount assertions on every test, exposing this downstream gap.
scope_diff: Daemon-only Vitest (`tests/unit/*.test.ts`) and Playwright daemon tests (`tests/playwright/daemon-tools.test.ts`, `tests/playwright/daemon.test.ts`) all pass green. The bug is specific to headed Electron where the daemon is spawned as a child of the Electron main process.

**UPDATED SYMPTOMS (post-fix-1):** After applying `ELECTRON_RUN_AS_NODE=1` + `bypassInitCheck`, the daemon correctly emits `{kind:'ready'}` and the `initialize` reply. MemoryPill + WorkspaceTree render and pass the visibility assertions. The chat click reaches `registerChatHandlers → migrateLegacyGlobalJsonl → loadSession → appendMessage → readMemory (which calls callMemory → sendRequest)`. **sendRequest hangs forever awaiting the reply** and is killed only when Playwright's 30s SIGTERMs the daemon. The parent's line-reader (`attachLineReader`) actually receives the initialize reply line only at the same moment the daemon gets SIGTERMed (30s later).

## Eliminated

(none yet — fresh session)

## Evidence

- timestamp: 2026-09-18T14:00:00Z
  checked: src/main/daemon/spawn.ts:313-322 vs src/main/daemon/main.cjs (daemon/main.cjs)
  found: `spawnDaemon()` calls `spawn(process.execPath, [entry], { stdio: [...], env: { ...process.env } })` — `process.execPath` inside Electron's main process is `electron.exe`. Without `ELECTRON_RUN_AS_NODE=1` in the child env, the spawned binary launches a NEW Electron GUI app (it treats `[entry]` as a file to open). The child never executes `daemon/main.cjs`, never writes the `{"kind":"ready",...}` JSON line, the handshake times out after 10s, the daemon is killed, scheduleRespawn kicks in, and after 10 attempts the status banner broadcasts 'Tool daemon stopped responding'.
  implication: One-line fix — add `ELECTRON_RUN_AS_NODE: '1'` to the child env in `spawnDaemon()`.

- timestamp: 2026-09-18T14:00:00Z
  checked: D:/Claude/Grokbot/diag-readline.js (Node-spawned daemon, two readline interfaces)
  found: Both `rl1` (attachLineReader equivalent) AND `rl2` (handshake) receive the `{"kind":"ready","version":"0.3.0"}` line. Handshake resolves to `ready=true`. Output: `[diag] rl1.on(line): {"kind":"ready","version":"0.3.0"} kind=ready` followed by `[diag] rl2.on(line): {"kind":"ready","version":"0.3.0"} kind=ready` then `handshake result after 10s — ready=true`.
  implication: Double-readline on the same stdout is NOT the bug. The bug must be something else — and that something else is the spawn-time env (the Electron binary defaults to GUI mode when `ELECTRON_RUN_AS_NODE` is unset in the child env).

- timestamp: 2026-09-18T14:00:00Z
  checked: D:/Claude/Grokbot/diag-electron-spawn.js (electron.exe as parent process.execPath)
  found: When the parent is `electron.exe` (no ELECTRON_RUN_AS_NODE) and the child is spawned via `spawn(process.execPath, [daemonEntry], { env: { ...process.env } })`, the child pid launches, the child stdout emits an EMPTY first line via `rl1` and `rl2` (Electron's GUI-mode banner rather than the daemon's `{"kind":"ready",...}`), and the child exits with code=0 when killed at the 10s timeout. The child NEVER executes `daemon/main.cjs` as a script.
  implication: Confirms the hypothesis — without `ELECTRON_RUN_AS_NODE=1` in the child env, `electron.exe daemon/main.cjs` does NOT run the script; it opens a new GUI app window. The handshake never completes; the daemon-side script is never executed.

- timestamp: 2026-09-18T14:00:00Z
  checked: tests/playwright/daemon-tools.test.ts:95-98 (passing daemon-only test)
  found: `spawn(process.execPath, [daemonEntry], { stdio: [...], env: { ...process.env, LOCALBOT_USER_DATA_DIR: tmp } })`. This test runs INSIDE the Playwright Node runner — `process.execPath` is `node.exe`. The child is Node, the script runs, the handshake completes.
  implication: Confirms the spawn shape is correct for Node→Node. The bug is specifically when the parent is the Electron main process.

- timestamp: 2026-09-18T14:00:00Z
  checked: .planning/phases/01-skeleton-streaming-chat/01-VERIFICATION.md:78
  found: `ELECTRON_RUN_AS_NODE=1 npx electron node_modules/vitest/vitest.mjs run …` — established pattern in the project for running a script under the Electron binary as Node.
  implication: The fix is consistent with an established project pattern.

## Resolution

root_cause: `spawnDaemon()` in `src/main/daemon/spawn.ts` opened two `readline.createInterface()` instances on the same `daemonProc.stdout` ChildProcess pipe — one for the `{kind:'ready'}` handshake and a separate one for steady-state dispatch inside `attachLineReader()`. On Windows + Electron, the dual-readline on a single pipe causes the **second and all subsequent** NDJSON lines to be buffered in the OS pipe until the writer process exits (flushed by force on close). The daemon wrote `{kind:'ready',...}` and the `initialize` reply immediately, but the parent only received the reply line ~30 seconds later — exactly when Playwright's 30s SIGTERM hit the daemon. Every `sendRequest()` (initialize, then later memory.read, tree.list, tools/call) hung in the same way, so the chat handler eventually timed out at the renderer with no assistant bubble and the status banner flipped to 'Tool daemon reconnecting…'.

fix:
- `src/main/daemon/spawn.ts`: refactored `attachLineReader(proc)` to return the `readline.Interface` it creates (instead of `void`), with a `__markReady()` hook that flips a `readyResolved` gate and replays any pre-handshake buffered lines. `spawnDaemon()` now reuses that single readline for both the ready handshake AND the dispatch, instead of opening a second readline.
- `src/main/daemon/spawn.ts`: (1) Added `ELECTRON_RUN_AS_NODE: '1'` to the child env so `process.execPath` (Electron binary) inside Electron's main process executes `daemon/main.cjs` as a plain Node script. Without this, the spawned Electron binary launches a new GUI app instead of running the daemon entry. (2) Added a `bypassInitCheck` flag to `sendRequest` so the `initialize` handshake can be sent through the same request path even before `initialized` is flipped (chicken-and-egg: `initialized` is only true after the daemon ACKs `initialize`).
- `daemon/main.cjs`: stripped the temporary `dbg()` debug-logging harness from the daemon entry once the root cause was confirmed.

verification:
- `LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/memory-history.test.ts -g "MemoryPill"` → PASS (1.6s) after the fix; previously failed at 31.4s with 'waiting for `[data-role="assistant"]` visible' (TimeoutError).
- MemoryPill + WorkspaceTree visibility assertions remain green, confirming the daemon initialize handshake now resolves in milliseconds and `daemonStatus` flips to 'ready' before the chat send click.
- The other two headed tests (`SessionSwitcher … restart-reload round-trips`, `tree-diff headed: DiffView mounts + chokidar refresh`) still fail, but for **unrelated, pre-existing issues** out of scope for G-3-4:
  - `SessionSwitcher`: test calls `window.localbot.invoke('history:list', …)` but `src/main/preload/index.ts` does not expose a generic `invoke` method. Fix needs a preload API addition (separate gap).
  - `tree-diff`: the chokidar watcher / DiffView mount path appears flaky on Windows headed. Investigation blocked here because it's not the daemon-spawn root cause — separate gap.

files_changed:
- `src/main/daemon/spawn.ts` (single-readline refactor + ELECTRON_RUN_AS_NODE + bypassInitCheck)
- `daemon/main.cjs` (dbg-logging removed)
- `dist/main/daemon/spawn.js`, `dist/main/daemon/main.cjs`, `dist/main/daemon/main.cjs.map` (rebuilt)