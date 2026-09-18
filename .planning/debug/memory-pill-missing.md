---
status: resolved
trigger: "After fixing PowerShell env var (was skipped on first try, now runs): Locator: locator('[data-testid=memory-pill]') not visible within 10000ms — at tests/playwright/memory-history.test.ts:109. MemoryPill + WorkspaceTree fail to render in the headed Electron chat header."
created: 2026-09-18T12:00:00Z
updated: 2026-09-18T13:30:00Z
---

## Current Focus

hypothesis: REVISED — The previous "useEffect vs did-finish-load race" theory was a plausible-but-wrong reading of the evidence. Diagnostic instrumentation (console.log on `[app-init] REQUEST_APP_INIT received` + Playwright renderer-console capture of preload load errors) revealed the true root cause: the `preload` path in `BrowserWindow.webPreferences` was `path.join(__dirname, '..', 'preload', 'index.js')`. With `__dirname` being `dist/main/`, this resolved to `dist/preload/index.js` — which DOES NOT EXIST (the actual preload is at `dist/main/preload/index.js`). Electron silently failed to load the preload, `contextBridge` never exposed `window.localbot`, and `App.tsx`'s `if (!window.localbot) return;` early-return in `useEffect` prevented any IPC subscription. `hasKey` stayed `null` forever, Chat never mounted, and every downstream `data-testid` was absent from the DOM.

test: Add renderer-console + main-stdout capture in a diagnostic Playwright test, then surface the preload load error.
expecting: A console.error from the renderer confirming `Unable to load preload script`.
next_action: Fix the preload path to `path.join(__dirname, 'preload', 'index.js')` (window.js sits next to preload/ in dist/main/).

## Symptoms

expected: After saving the API key via KeyModal, the headed Electron renderer transitions to Chat with `[data-testid="memory-pill"]` and `[data-testid="workspace-tree"]` visible in the DOM within 10s.
actual: `Locator: locator('[data-testid=memory-pill]') not visible within 10000ms` at `tests/playwright/memory-history.test.ts:109`. The renderer body is stuck at `<div class="boot">Loading…</div>` because the React tree never receives `app:init`.
errors: Playwright TimeoutError on memory-pill locator wait (10s timeout). Renderer console emits `Unable to load preload script: D:\Claude\Grokbot\dist\preload\index.js` (silent in test output without explicit console listener).
reproduction: `LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/memory-history.test.ts` — first test fails at line 109. Identical symptom in smoke.test.ts because both rely on the renderer reaching the Chat mount state.
started: Reported after the user fixed the PowerShell env var so headed Electron tests actually run.

## Eliminated

- hypothesis: "data-testid is missing from the source components"
  evidence: MemoryPill.tsx:30 has `data-testid="memory-pill"`. WorkspaceTree.tsx:71 has `data-testid="workspace-tree"`. Composer.tsx:73 has `data-testid="composer-input"`. All three strings appear in the built bundle (`dist/renderer/assets/index-*.js`).
  timestamp: 2026-09-18T12:00:00Z

- hypothesis: "Chat.tsx conditionally hides MemoryPill / WorkspaceTree"
  evidence: Chat.tsx renders `<MemoryPill bot="default" />` at line 99 and `<WorkspaceTree workspaceRoot={workspaceRoot} />` at line 104 unconditionally. No feature flag, IPC handshake, or branch gates them.
  timestamp: 2026-09-18T12:00:00Z

- hypothesis: "Main process is sending app:init with hasKey=true while key modal is also visible (race)"
  evidence: window.ts:64-75 sends `EVENT_APP_INIT` exactly once on `did-finish-load` with `hasKey=await hasStoredKey()`. Subsequent `key.set` does NOT re-send `app:init` (key.ts:52-65 only persists and returns). Renderer transitions `hasKey` locally via KeyModal `onSaved` callback in App.tsx.
  timestamp: 2026-09-18T12:00:00Z

- hypothesis: "Preload script strips data-testid attributes"
  evidence: preload/index.ts (built dist/main/preload/index.js) uses contextBridge.exposeInMainWorld and does not transform JSX attributes — React renders them directly. The bundled renderer includes all four testid strings verbatim.
  timestamp: 2026-09-18T12:00:00Z

- hypothesis: "Chat never mounts because useMessages / useCurrentSession throws synchronously"
  evidence: All hooks (useMessages, useCurrentSession, useMemory, useWorkspaceTree) catch errors and degrade to error-state renders; none throw out of render. Each effect is independent and wrapped in try/catch.
  timestamp: 2026-09-18T12:00:00Z

- hypothesis: "Race between did-finish-load (main) and useEffect (renderer)"
  evidence: Diagnostic instrumentation showed the renderer never received `REQUEST_APP_INIT` IPC even after main's `did-finish-load` handler fired and main's pull-request handler was registered. The renderer's `[renderer] error Unable to load preload script` in the Playwright console-capture proved the preload never loaded — `window.localbot` was undefined, so App.tsx's `if (!window.localbot) return;` short-circuited the listener registration entirely. The race theory was a misread of the symptom.
  timestamp: 2026-09-18T13:30:00Z

## Evidence

- timestamp: 2026-09-18T12:00:00Z
  checked: tests/playwright/memory-history.test.ts:78-132
  found: primeKeyModal silently returns if the modal is not visible within 8s (`if (!(await modal.isVisible({ timeout: 8_000 }).catch(() => false))) return;`). The test then proceeds to line 109 where it waits for `[data-testid="memory-pill"]`. If the modal never appeared (because `hasKey` stayed null), the error surfaces only at line 109, masquerading as a MemoryPill render bug.
  implication: The reported line-109 failure may not be the actual location of the bug. A stuck `hasKey === null` (renderer showing "Loading…") would explain it.

- timestamp: 2026-09-18T12:00:00Z
  checked: src/renderer/App.tsx:8-31
  found: `app:init` listener is registered in `useEffect` with empty deps `[]`, so it runs once after first commit. The initial render returns `<div className="boot">Loading…</div>` when `hasKey === null`. `app:init` arriving before this useEffect runs (race) means `hasKey` never gets set and the renderer is stuck at "Loading…".
  implication: Critical timing dependency on when the React useEffect runs vs when `did-finish-load` fires.

- timestamp: 2026-09-18T12:00:00Z
  checked: src/main/window.ts:64-75
  found: `did-finish-load` handler awaits `Promise.all([hasStoredKey(), loadSession('default')])` then calls `webContents.send(CHANNELS.EVENT_APP_INIT, ...)`. loadSession walks `sessionsDir()` and reads/parses JSONL files; in headed Electron with a fresh userData dir this should return immediately (empty), but if it throws the catch block sends `hasKey: false` and the renderer shows the modal.
  implication: The catch branch sends `{ hasKey: false, messages: [], headSummary: null }` — modal will still appear. So if `loadSession` throws, modal is shown but messages are empty (still fine, Chat renders with empty messages).

- timestamp: 2026-09-18T12:00:00Z
  checked: dist/main/window.js:59-71 (built version of window.ts)
  found: The compiled output preserves the same `did-finish-load → app:init` ordering and uses `await Promise.all([hasStoredKey(), loadSession('default')])`.
  implication: Built version matches source; no build artifact mismatch.

- timestamp: 2026-09-18T12:00:00Z
  checked: src/renderer/components/{MemoryPill,WorkspaceTree,Composer}.tsx + dist bundle grep
  found: All four target testids (`memory-pill`, `workspace-tree`, `composer-input`, `key-modal`) are present in the built Vite bundle. React 19 renders them as plain attributes.
  implication: data-testid wiring is correct in both source and bundle.

- timestamp: 2026-09-18T12:00:00Z
  checked: src/main/preload/index.ts + dist version
  found: `contextBridge.exposeInMainWorld('localbot', api)` exposes `key.{get,set,probe,clear}`, `history.{listSessions,load}`, `memory.read`, `tree.list`, `on(...)`. All event channels (including `app:init`) are in EVENT_CHANNELS allow-list so `on()` does not throw.
  implication: Bridge is correctly wired.

- timestamp: 2026-09-18T12:00:00Z
  checked: tests/playwright/memory-history.test.ts:108-113 vs src/renderer/components/Chat.tsx:89-104
  found: Chat renders MemoryPill (line 99) and WorkspaceTree (line 104) unconditionally. Composer (line 205) also unconditionally. No gating logic at all.
  implication: If Chat mounts, all three testids appear. If Chat does not mount (e.g., App.tsx stuck at hasKey===null showing Loading…), none of them appear and the test fails at line 109.

- timestamp: 2026-09-18T12:00:00Z
  checked: src/main/preload/index.ts:22-29 `on` wrapper
  found: `on(channel, handler)` throws `Error('bad channel: …')` if the channel is not in EVENT_CHANNELS. The renderer's `window.localbot.on('app:init', ...)` call passes a channel that IS in the allow-list, so no throw.
  implication: Bridge API surface is correct; the listener registration call cannot throw for the channels in use.

- timestamp: 2026-09-18T12:00:00Z
  checked: G-3-2 report (same file, line 171, `[data-testid="composer-input"]` not found after 30s)
  found: Both G-3-1 (memory-pill at line 109) and G-3-2 (composer-input at line 171) target the same failure pattern: locators for elements that are only present once Chat mounts. If Chat never mounts, both locators time out at the same line.
  implication: Strong evidence the two gaps share a single renderer-mount root cause — Chat never mounting. This matches the UAT note that "the renderer-mount blocker from G-3-1/G-3-2 (MemoryPill and Composer missing in headed mode) almost certainly affects WorkspaceTree + DiffView too".

- timestamp: 2026-09-18T12:00:00Z
  checked: src/renderer/App.tsx:12-20 useEffect
  found: The `app:init` listener is registered via `window.localbot.on(...)` inside useEffect with `[]` deps. useEffect runs AFTER React commits the first render. The first render outputs `<div className="boot">Loading…</div>` (hasKey===null).
  implication: If main process sends `app:init` before useEffect registers the listener, `hasKey` stays null and the user sees "Loading…" indefinitely.

- timestamp: 2026-09-18T12:00:00Z
  checked: src/main/window.ts:60-62 ready-to-show
  found: `win.show()` is called on `ready-to-show`, not on `did-finish-load`. So the window appears as soon as the first frame is ready, then `did-finish-load` may fire before/after that. If the user (or Playwright) sees a stable frame that says "Loading…", that's the symptom of the listener race.
  implication: The symptom (modal not appearing within 8s) is consistent with `app:init` being missed.

- timestamp: 2026-09-18T13:30:00Z
  checked: src/main/window.ts:71 webPreferences.preload
  found: `path.join(__dirname, '..', 'preload', 'index.js')`. `__dirname` at runtime is `dist/main/` (because tsc emits to dist/main/), so this resolves to `dist/preload/index.js`. The actual preload lives at `dist/main/preload/index.js` (placed there by the `tsconfig.main.json` include of `src/main/preload/`). The path is one level too high.
  implication: Electron silently fails to load the preload, `contextBridge.exposeInMainWorld('localbot', api)` never runs, `window.localbot` is `undefined`, and `App.tsx`'s `if (!window.localbot) return;` early-returns without registering the listener. This is the true root cause — the prior race-condition theory was a misread.

- timestamp: 2026-09-18T13:30:00Z
  checked: Playwright diagnostic with `window.on('console')` + `electronApp.process().stdout` capture
  found: Renderer console emitted `[renderer] error Unable to load preload script: D:\Claude\Grokbot\dist\preload\index.js` followed by the Node `MODULE_NOT_FOUND` stack. Main process stdout showed `[app-init] registered trigger`, `[app-init] did-finish-load fired`, `[app-init] sendAppInit called`, `[app-init] sending EVENT_APP_INIT` — confirming the main side fired but the renderer's listener never executed because the preload never exposed `window.localbot`.
  implication: Preload load failure is the deterministic root cause; the race-condition theory was wrong because it assumed the listener was even being called.

- timestamp: 2026-09-18T13:30:00Z
  checked: After fixing the preload path to `path.join(__dirname, 'preload', 'index.js')`
  found: Diagnostic Playwright test showed `.boot count: 0`, `key-modal count: 1`, and a follow-up send-message test showed the full Chat DOM with `[data-testid="memory-pill"]`, `[data-testid="workspace-tree"]`, `[data-testid="composer-input"]`, `[data-testid="session-switcher"]`, `[data-testid="chat-header"]` all present. The renderer-mount blocker is resolved.
  implication: The fix works; downstream chat-response issue (daemon not initialized) is a separate, pre-existing bug unrelated to this debug session's scope.

## Resolution

root_cause: The `preload` path in `src/main/window.ts:72` was `path.join(__dirname, '..', 'preload', 'index.js')`, which from `dist/main/` resolves to `dist/preload/index.js` — a path that does NOT exist (the actual preload is at `dist/main/preload/index.js`). Electron silently failed to load the preload script, so `contextBridge.exposeInMainWorld('localbot', api)` never ran, leaving `window.localbot` undefined. App.tsx's `useEffect` short-circuits on `if (!window.localbot) return;`, so the `app:init` listener was never registered; `hasKey` stayed `null` forever; the renderer was stuck at the `<div className="boot">Loading…</div>` stub; Chat never mounted; and all downstream `data-testid` locators (MemoryPill, WorkspaceTree, Composer, SessionSwitcher) timed out.

fix: Two changes — (1) PRIMARY: `src/main/window.ts:72` — change `path.join(__dirname, '..', 'preload', 'index.js')` to `path.join(__dirname, 'preload', 'index.js')`. The `..` was incorrect; the preload sits in the same `dist/main/` directory as `window.js`. This is the actual fix that resolves the renderer-mount blocker for G-3-1, G-3-2, and G-3-3. (2) DEFENSIVE: added an `app:init:request` pull-back channel (`REQUEST_APP_INIT` in `src/shared/ipc-channels.ts`, `requestAppInit` on `LocalbotApi` in `src/shared/window.d.ts` + `src/main/preload/index.ts`, and `window.localbot.requestAppInit()` call in `src/renderer/App.tsx`'s `useEffect`). The renderer asks main to re-send `EVENT_APP_INIT` after registering its listener. The `did-finish-load` send is kept as the primary path. This belt-and-suspenders measure was added during the original (wrong) race-condition investigation and retained because it makes future similar races benign.

verification: Diagnostic Playwright test (`LOCALBOT_SMOKE_OK=1` headed Electron) with renderer console + main stdout capture. Before: `[renderer] error Unable to load preload script: D:\Claude\Grokbot\dist\preload\index.js` and the rendered DOM is `<div class="boot">Loading…</div>`. After: preload loads cleanly, `[data-testid="memory-pill"]`, `[data-testid="workspace-tree"]`, `[data-testid="composer-input"]`, `[data-testid="session-switcher"]`, `[data-testid="chat-header"]` are all present in the DOM after the key modal is saved. The renderer-mount blocker (G-3-1, G-3-2, G-3-3) is resolved. NOTE: the downstream chat-response test (waiting for `[data-role="assistant"]`) still fails because the daemon does not initialize in the test environment (`"daemon not initialized"` banner in DOM, `"Tool daemon reconnecting…"` banner) — this is a SEPARATE pre-existing bug that surfaces only after the renderer can mount, and is outside this debug session's scope.

files_changed:
  - src/main/window.ts (preload path `..` → no `..`; added `REQUEST_APP_INIT` IPC handler and per-window app-init trigger map; registered trigger in createMainWindow; refactored did-finish-load handler to reuse the trigger closure)
  - src/shared/ipc-channels.ts (added `REQUEST_APP_INIT: 'app:init:request'`)
  - src/shared/window.d.ts (added `requestAppInit: () => void` to `LocalbotApi`)
  - src/main/preload/index.ts (added `requestAppInit: () => ipcRenderer.send(CHANNELS.REQUEST_APP_INIT)`)
  - src/renderer/App.tsx (registered listener then called `window.localbot.requestAppInit()` as a backstop; idempotent setState means a duplicate delivery is harmless)
