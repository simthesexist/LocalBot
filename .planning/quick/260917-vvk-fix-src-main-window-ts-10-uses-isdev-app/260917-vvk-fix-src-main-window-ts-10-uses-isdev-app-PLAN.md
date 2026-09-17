---
quick: 260917-vvk-fix-src-main-window-ts-10-uses-isdev-app
plan: 260917-vvk
type: execute
wave: 1
depends_on: []
files_modified:
  - src/main/window.ts
  - tests/unit/window.test.ts
autonomous: true
requirements: []
user_setup: []

must_haves:
  truths:
    - "npm run build && npm start loads the KeyModal (no ERR_CONNECTION_REFUSED for http://localhost:5173)"
    - "npm run dev:electron still loads http://localhost:5173 when dist/renderer/index.html is absent"
    - "Renderer-URL branch decision is driven by file existence, not by app.isPackaged"
  artifacts:
    - path: src/main/window.ts
      provides: "Exported pure resolveRendererUrl() + createMainWindow() that consumes it"
    - path: tests/unit/window.test.ts
      provides: "Vitest coverage for built/dev branches using mkdtempSync temp dirs"
  key_links:
    - from: "src/main/window.ts#createMainWindow"
      to: "fs.existsSync(builtIndexPath)"
      via: "resolveRendererUrl"
      critical: "If the resolver still calls loadURL for built mode, npm start keeps the ERR_CONNECTION_REFUSED bug"
---

<objective>
Replace the `const isDev = !app.isPackaged` heuristic in `src/main/window.ts:10` with a pure
`resolveRendererUrl()` resolver that branches on whether `dist/renderer/index.html` exists on disk.
This fixes `npm start` (currently tries to connect to localhost:5173 with no Vite running) without
breaking `npm run dev:electron` (where the file genuinely is absent). Add vitest coverage for both
branches following the `tests/unit/spawn.test.ts` pattern.

Purpose: `npm run build && npm start` must launch KeyModal end-to-end. The `app.isPackaged` check is
unreliable in a single-machine desktop workflow where both `electron .` and `electron
dist/main/index.js` run unpackaged.

Output: Patched `src/main/window.ts` + new `tests/unit/window.test.ts`. No `package.json` changes.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/quick/260917-vlw-fix-spawn-ts-resolves-daemon-to-dist-mai/260917-vlw-fix-spawn-ts-resolves-daemon-to-dist-mai-SUMMARY.md
@src/main/window.ts
@tests/unit/spawn.test.ts
@tests/unit/safeStorage.test.ts
@vitest.config.ts
@package.json
</context>

<tasks>

<task type="auto">
  <name>Refactor window.ts to use resolveRendererUrl + add vitest unit test</name>
  <files>src/main/window.ts, tests/unit/window.test.ts</files>
  <action>
    Edit `src/main/window.ts`:

    1. Add `import fs from 'node:fs';` next to the existing `path` import.
    2. Remove the line `const isDev = !app.isPackaged;`.
    3. Add a new exported pure resolver above `createMainWindow`:

       - `export type RendererTarget = { kind: 'built'; path: string } | { kind: 'dev'; url: string };`
       - `export function resolveRendererUrl(opts: { builtIndexPath: string; devUrl?: string }): RendererTarget {`
         - if `fs.existsSync(opts.builtIndexPath)` -> `{ kind: 'built', path: opts.builtIndexPath }`
         - else -> `{ kind: 'dev', url: opts.devUrl ?? 'http://localhost:5173' }`
       - }

    4. Replace the `if (isDev) { ... } else { ... }` block at lines 63-68 with:

       - `const builtIndexPath = path.join(__dirname, '..', '..', 'renderer', 'index.html');`
       - `const target = resolveRendererUrl({ builtIndexPath });`
       - `if (target.kind === 'dev') { void win.loadURL(target.url); } else { void win.loadFile(target.path); }`

       Keep the surrounding `if/else` shape so the `did-fail-load` audit + `ready-to-show` show() paths
       remain unchanged.

    Do NOT touch `package.json`, scripts, or any other file. The resolver lives in `window.ts` so
    the test only needs the `vi.mock('electron', ...)` shim from `tests/unit/spawn.test.ts` (window.ts
    imports `BrowserWindow` and `app` from electron at module scope — that import is satisfied by
    the shim; the resolver itself never touches `app` or `BrowserWindow`).

    Create `tests/unit/window.test.ts`:

    - Same shape as `tests/unit/spawn.test.ts`: top-of-file `vi.mock('electron', () => ({ app: { getAppPath: () => '<unused>' }, BrowserWindow: class {}, }))`,
      then `import { resolveRendererUrl } from '../../src/main/window';`.
    - `beforeEach` mkdtempSync into `os.tmpdir()` with a `localbot-window-` prefix; `afterEach` rmSync
      `{ recursive: true, force: true }`.
    - Cases:
      1. `it('returns { kind: \"built\", path } when builtIndexPath exists on disk')` — writeFileSync
         a fake `index.html` inside the temp dir, expect the resolver to return the built branch.
      2. `it('returns { kind: \"dev\", url: \"http://localhost:5173\" } when builtIndexPath is missing')` —
         default devUrl.
      3. `it('honors a custom devUrl when builtIndexPath is missing')` — pass `devUrl: 'http://localhost:9999'`.
      4. `it('imports as a function (smoke test for the electron-mock + tsconfig setup)')` — same
         pattern as `spawn.test.ts`.
    - The mock electron shape needs `BrowserWindow` (used at module-scope import in window.ts) and
      `app` (used at module-scope import). Nothing else — the resolver does not touch them.

    Why this shape:
    - Pure resolver + temp-dir test is the same pattern that worked for `resolveDaemonEntry`; no
      new dependencies, no Electron bootstrap, no Playwright.
    - The `devUrl` opt keeps the Vite URL configurable for the test and any future override (e.g.
      a remote dev server) without re-touching window.ts.
  </action>
  <verify>
    <automated>npx tsc --noEmit -p tsconfig.main.json && npm test</automated>
    <human-check>rm -rf dist && npm run build && test -f dist/renderer/index.html && test -f dist/main/window.js && test -f dist/main/daemon/main.cjs && ! grep -q isDev src/main/window.ts && ! grep -q isPackaged dist/main/window.js</human-check>
  </verify>
  <done>
    - `npx tsc --noEmit -p tsconfig.main.json` exits 0.
    - `npm test` exits 0; the new `tests/unit/window.test.ts` contributes 4 passing cases; the
      previous 26 + 1 skipped remain green.
    - `npm run build` produces `dist/renderer/index.html`, `dist/main/window.js`,
      `dist/main/daemon/main.cjs`.
    - `grep -c isDev src/main/window.ts` returns 0.
    - `grep -c isPackaged dist/main/window.js` returns 0 (the compiled bundle no longer carries
      the heuristic).
    - Headed `npm start` on a desktop machine loads KeyModal (recorded as a human-verification
      item in the SUMMARY; not runnable in this CI environment).
  </done>
</task>

</tasks>

<verification>
- `npx tsc --noEmit -p tsconfig.main.json` exits 0
- `npm test` passes (existing 26 + 1 skipped; +4 new cases for resolveRendererUrl)
- `npm run build` produces `dist/renderer/index.html`, `dist/main/window.js`,
  `dist/main/daemon/main.cjs`
- `grep -c isDev src/main/window.ts` is 0
- `grep -c isPackaged dist/main/window.js` is 0
- Manual `npm start` on a desktop machine launches KeyModal (human-verification follow-up)
</verification>

<success_criteria>
- `resolveRendererUrl({ builtIndexPath, devUrl? })` is exported from `src/main/window.ts` as a
  pure function returning `{ kind: 'built', path }` when the file exists or
  `{ kind: 'dev', url }` (default `http://localhost:5173`) when it does not.
- `createMainWindow` no longer references `app.isPackaged`; it consumes the resolver and calls
  `win.loadFile` or `win.loadURL` accordingly.
- `tests/unit/window.test.ts` covers both branches with real temp dirs.
- `npm run build && npm start` will load KeyModal (human-verification on a desktop machine).
- `npm run dev:electron` continues to work (no `dist/renderer/index.html` after a fresh `rm -rf
  dist`; resolver returns the dev branch).
</success_criteria>

<output>
Create `.planning/quick/260917-vvk-fix-src-main-window-ts-10-uses-isdev-app/260917-vvk-fix-src-main-window-ts-10-uses-isdev-app-SUMMARY.md` when done.
</output>