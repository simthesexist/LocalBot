---
quick: 260918-mtv-fix-sessionswitcher-window-localbot-invo
plan: 260918-mtv
type: execute
wave: 1
depends_on: []
files_modified:
  - src/main/preload/index.ts
  - src/shared/window.d.ts
  - tests/unit/preload.test.ts
autonomous: true
requirements: []
user_setup: []

must_haves:
  truths:
    - "`tests/playwright/memory-history.test.ts` lines 199 / 254 / 264 compile (the cast `window as unknown as { localbot: { invoke: (ch, p) => Promise<unknown> } }` resolves)"
    - "`window.localbot.invoke('history:list', { bot: 'default' })` returns the same shape as the typed `window.localbot.history.listSessions('default')`"
    - "Existing typed preload surface (`sendMessage`, `cancel`, `key.*`, `history.listSessions`, `history.load`, `memory.read`, `tree.list`, `requestAppInit`, `on`) keeps working unchanged"
  artifacts:
    - path: src/main/preload/index.ts
      provides: "`LocalbotApi.invoke(channel, payload?)` thin proxy to `ipcRenderer.invoke(channel, payload)`"
    - path: src/shared/window.d.ts
      provides: "`LocalbotApi.invoke(channel, payload?): Promise<unknown>` declaration"
    - path: tests/unit/preload.test.ts
      provides: "Vitest coverage proving the new invoke proxies to ipcRenderer.invoke with the same args + channel"
  key_links:
    - from: "src/main/preload/index.ts"
      to: "ipcRenderer.invoke(channel, payload)"
      via: "LocalbotApi.invoke"
      critical: "If invoke is missing, the G-3-2 Playwright test fails with 'localbot.invoke is not a function' under LOCALBOT_SMOKE_OK=1"
---

<objective>
Expose a generic `invoke(channel, payload?)` on the preload bridge so that
`tests/playwright/memory-history.test.ts` can call
`window.localbot.invoke('history:list', { bot: 'default' })` (lines 199, 254) and
`window.localbot.invoke('history:load', { bot: 'default', sessionId: sid })`
(line 264) without type casts falling back to `undefined`. The fix is additive —
the typed `history.listSessions` / `history.load` / `memory.read` / `tree.list`
etc. namespace surface is preserved; `invoke` is a thin pass-through to
`ipcRenderer.invoke(channel, payload)` for callers that prefer the channel-name
form (Playwright tests, future generic tools, ad-hoc dev console probing).

Purpose: Closes G-3-2 (SessionSwitcher round-trip + restart-reload headed
smoke). The actual root cause was always missing in the preload bridge, not the
daemon bootstrap — that was G-3-4 and is already resolved. The Playwright test
file already calls `invoke`; the bridge just doesn't expose it.

Output: Patched `src/main/preload/index.ts` + `src/shared/window.d.ts` +
new `tests/unit/preload.test.ts`. No `package.json` changes. No `npm install`.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/quick/260917-vvk-fix-src-main-window-ts-10-uses-isdev-app/260917-vvk-fix-src-main-window-ts-10-uses-isdev-app-PLAN.md
@.planning/quick/260917-vvk-fix-src-main-window-ts-10-uses-isdev-app/260917-vvk-fix-src-main-window-ts-10-uses-isdev-app-SUMMARY.md
@src/main/preload/index.ts
@src/shared/window.d.ts
@src/shared/ipc-channels.ts
@src/main/ipc/history.ts
@tests/unit/spawn.test.ts
@tests/unit/window.test.ts
@tests/playwright/memory-history.test.ts
@vitest.config.ts
@tsconfig.preload.json
</context>

<tasks>

<task type="auto">
  <name>Add invoke() to preload bridge + types + unit test</name>
  <files>src/main/preload/index.ts, src/shared/window.d.ts, tests/unit/preload.test.ts</files>
  <action>
    Edit `src/main/preload/index.ts`:

    1. Add `invoke` to the `LocalbotApi` object literal AFTER `requestAppInit`
       and BEFORE the `on` binding. The implementation is a thin proxy:

       - `invoke: (channel: LocalbotChannel | string, payload?: unknown) => (payload === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, payload)),`

       Keep the existing entries (`sendMessage`, `cancel`, `key.*`, `history.*`,
       `memory.*`, `tree.*`, `requestAppInit`, `on`) byte-for-byte unchanged.
       The `payload === undefined` branch is required because some channels
       (e.g. `KEY_GET`, `KEY_CLEAR`, `CANCEL`) currently call
       `ipcRenderer.invoke(CHANNELS.X)` with no payload — forwarding `undefined`
       to those handlers is fine, but forwarding the literal `undefined` as a
       positional arg changes the shape of the dispatched event for some
       Electron versions. Use the conditional to stay safe.

    2. Do NOT add a new entry to `EVENT_CHANNELS` — `invoke` is for
       `ipcRenderer.invoke` (request/response), not `ipcRenderer.on` (events).

    Edit `src/shared/window.d.ts`:

    1. Add a new field to the `LocalbotApi` interface AFTER `requestAppInit`
       and BEFORE the `on` field:

       - `/**
          * Generic IPC proxy: forwards `ipcRenderer.invoke(channel, payload?)`
          * so renderer code (and Playwright tests) can address any registered
          * channel by name without the preload having to enumerate every
          * handler. Mirrors the typed namespace surface above; the channel
          * names must match `CHANNELS` in `src/shared/ipc-channels.ts`.
          */
         invoke: <T = unknown>(channel: LocalbotChannel | string, payload?: unknown) => Promise<T>;`

       The generic `<T = unknown>` lets the caller cast the result back to the
       expected shape (which is what the test already does via the
       `as { ok: boolean; sessions?: ... }` casts on lines 200, 255, 267).

    2. Do NOT change `LocalbotChannel` — it is for events, not invokes.

    Create `tests/unit/preload.test.ts`:

    Use the same vi.mock('electron', ...) shim pattern as
    `tests/unit/window.test.ts` and `tests/unit/spawn.test.ts`.

    - Top-of-file: `vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), }, }));`
      (The `contextBridge.exposeInMainWorld` vi.fn lets us assert the bridge
      was called with `'localbot'` and an object containing `invoke`.)
    - Import `ipcRenderer, contextBridge } from 'electron';` so the test can
      inspect the mocks.
    - `import { CHANNELS } from '../../src/shared/ipc-channels';`
    - Then `import '../src/main/preload/index';` (side-effect import — loads
      the module under test, which calls `contextBridge.exposeInMainWorld`).
    - Cases:
      1. `it('exposes localbot with an invoke method')` — grab the second arg
         of the `exposeInMainWorld` mock call (the api object) and assert
         `typeof api.invoke === 'function'`.
      2. `it('invoke(channel) forwards to ipcRenderer.invoke with no payload when payload is undefined')`
         — call `api.invoke(CHANNELS.KEY_GET)`; assert `ipcRenderer.invoke` was
         called once with `('key:get')` only.
      3. `it('invoke(channel, payload) forwards to ipcRenderer.invoke(channel, payload)')`
         — call `api.invoke(CHANNELS.HISTORY_LIST, { bot: 'default' })`; assert
         `ipcRenderer.invoke` was called once with `('history:listSessions', { bot: 'default' })`.
      4. `it('preserves the existing typed surface (history.listSessions, sendMessage, on)')`
         — call each typed method (history.listSessions('default'),
         sendMessage('hi', 'm1'), on('history:appended', () => {})) and assert
         `ipcRenderer.invoke` / `ipcRenderer.on` was called with the same
         channel + args as before (regression guard).
    - `beforeEach`: `vi.clearAllMocks()`.

    Why this shape:
    - Pure preload-bridge unit test mirrors `tests/unit/window.test.ts` —
      no Electron bootstrap, no Playwright, runs in <100ms.
    - The mock pattern is the one already proven by
      `tests/unit/window.test.ts` + `tests/unit/spawn.test.ts`; re-using the
      same `vi.mock('electron', ...)` shape keeps the dependency surface
      consistent.
    - The regression-guard case (4) is the most important: it prevents a
      future refactor from breaking the typed namespace surface that the
      production renderer components depend on (`SessionSwitcher`,
      `WorkspaceTree`, `MemoryPanel`, etc. all call `history.listSessions` /
      `memory.read` / `tree.list`, NOT `invoke`).

    Reference for the kebab-case channel:
    - `CHANNELS.HISTORY_LIST` evaluates to `'history:listSessions'`
      (per `src/shared/ipc-channels.ts:13`). The Playwright test passes the
      literal `'history:list'` (line 199), which is the kebab form of the
      constant — it works because `ipcRenderer.invoke` is just a string
      transport. The unit test asserts the EXACT channel string used by the
      preload (`CHANNELS.HISTORY_LIST`), so future drift between the preload
      and `CHANNELS` is caught.
  </action>
  <verify>
    <automated>npx tsc --noEmit -p tsconfig.preload.json && npx tsc --noEmit -p tsconfig.main.json</automated>
    <human-check>grep -c "invoke" src/main/preload/index.ts src/shared/window.d.ts | awk '{ if ($1 < 2) exit 1 }'</human-check>
  </verify>
  <done>
    - `npx tsc --noEmit -p tsconfig.preload.json` exits 0 (preload compiles).
    - `npx tsc --noEmit -p tsconfig.main.json` exits 0 (the renderer type that imports `LocalbotApi` still resolves; the `window.localbot.invoke` cast in `memory-history.test.ts` now type-checks).
    - `npm test` exits 0; `tests/unit/preload.test.ts` contributes 4 passing cases; the previous 26 + 1 skipped + the 4 from `tests/unit/window.test.ts` + 8 from `tests/unit/list_tree.test.ts` etc. remain green.
    - `grep -c "invoke" src/main/preload/index.ts` returns >= 1.
    - `grep -c "invoke" src/shared/window.d.ts` returns >= 1.
    - `tests/unit/preload.test.ts` exists and contains the 4 cases listed.
    - The existing `history.listSessions`, `sendMessage`, `key.get`, etc. typed entries are unchanged (visual diff against `git show HEAD:src/main/preload/index.ts`).
    - Headed `LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/memory-history.test.ts` on a desktop machine completes the SessionSwitcher round-trip + restart-reload (recorded as a human-verification follow-up; not runnable in this CI environment).
  </done>
</task>

</tasks>

<verification>
- `npx tsc --noEmit -p tsconfig.preload.json` exits 0
- `npx tsc --noEmit -p tsconfig.main.json` exits 0
- `npm test` exits 0; `tests/unit/preload.test.ts` adds 4 passing cases
- `grep -c "invoke" src/main/preload/index.ts` is >= 1
- `grep -c "invoke" src/shared/window.d.ts` is >= 1
- The existing `sendMessage`, `cancel`, `key.*`, `history.listSessions`, `history.load`, `memory.read`, `tree.list`, `requestAppInit`, `on` entries are unchanged
- Manual `LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/memory-history.test.ts` on a desktop machine runs the SessionSwitcher round-trip + restart-reload end-to-end (human-verification follow-up)
</verification>

<success_criteria>
- `LocalbotApi.invoke(channel, payload?)` is exported from `src/main/preload/index.ts` as a thin proxy to `ipcRenderer.invoke(channel, payload?)`.
- `LocalbotApi.invoke` is declared in `src/shared/window.d.ts` so the renderer + Playwright test casts type-check.
- `tests/unit/preload.test.ts` covers the new invoke + a regression guard for the existing typed surface, both via `vi.mock('electron', ...)`.
- `npm test` and both `tsc --noEmit` runs exit 0.
- The G-3-2 Playwright assertion lines (`window.localbot.invoke('history:list', ...)` + `('history:load', ...)`) type-check and will resolve at runtime against the preload bundle.
</success_criteria>

<output>
Create `.planning/quick/260918-mtv-fix-sessionswitcher-window-localbot-invo/260918-mtv-fix-sessionswitcher-window-localbot-invo-SUMMARY.md` when done.
</output>
