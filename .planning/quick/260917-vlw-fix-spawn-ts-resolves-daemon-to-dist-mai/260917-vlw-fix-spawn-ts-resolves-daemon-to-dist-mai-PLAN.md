---
quick: 260917-vlw-fix-spawn-ts-resolves-daemon-to-dist-mai
type: execute
wave: 1
depends_on: []
files_modified:
  - src/main/daemon/spawn.ts
  - tests/unit/spawn.test.ts
  - package.json
autonomous: true
requirements: []
user_setup: []

estimate:
  tokens: 18000
  raw_tokens: 9000
  tasks: 2
  confidence: high

must_haves:
  truths:
    - "Launching via `npm start` (electron dist/main/index.js) spawns the tool daemon successfully (no ENOENT on daemon/main.cjs)"
    - "Launching via `npm run dev:electron` (electron .) continues to spawn the tool daemon successfully"
    - "Unit test in tests/unit/spawn.test.ts exercises both appPath cases (project-root and dist/main) and passes"
  artifacts:
    - "src/main/daemon/spawn.ts exports a pure resolveDaemonEntry(appPath) function"
    - "tests/unit/spawn.test.ts exists with two cases using a real temp directory"
    - "package.json build:main invokes fs.cpSync('daemon', 'dist/main/daemon', { recursive: true, filter: ... }) after tsc"
    - "package.json build runs build:main (so npm start picks up the copy)"
    - "dist/main/daemon/{main,protocol,audit}.cjs and dist/main/daemon/tools/registry.cjs exist after npm run build"
  key_links:
    - "spawn.ts path resolution is replaced with resolveDaemonEntry(app.getAppPath()) - no logic change to the spawn() call"
    - "build:main copy step runs after tsc (not before) so dist/main/daemon is not clobbered"
---

<objective>
Fix `npm start` ENOENT on `daemon/main.cjs` by mirroring the runtime-only `daemon/*.cjs` files into `dist/main/daemon/` as part of the main build, and add a unit test that locks in the path-resolution contract for both launch modes (`electron .` and `electron dist/main/index.js`).

Purpose: today `spawn.ts` always resolves `<appPath>/daemon/main.cjs`. When `appPath` is the project root, the file is present; when it is `dist/main/`, the file is missing because tsc only compiles `src/`, not the root-level `daemon/` folder. After this fix the build mirrors the folder so both modes work.

Output: spawn.ts has a testable `resolveDaemonEntry`; a vitest unit test covers both modes; `build:main` copies `daemon/` into `dist/main/daemon/`; `build` routes through `build:main` so `npm start` works end-to-end.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/phases/01-skeleton-streaming-chat/01-VERIFICATION.md
@.claude/CLAUDE.md

# Source files the executor MUST read first
@src/main/daemon/spawn.ts
@tests/unit/safeStorage.test.ts
@vitest.config.ts
@tsconfig.main.json
@package.json
</context>

<tasks>

<task type="auto">
  <name>Task 1: Extract resolveDaemonEntry from spawn.ts and add unit test</name>
  <files>src/main/daemon/spawn.ts, tests/unit/spawn.test.ts</files>
  <action>
In `src/main/daemon/spawn.ts`:

1. Add a new exported pure function `resolveDaemonEntry(appPath: string): string` that takes `appPath` and returns the daemon entry path. Implementation:

   ```ts
   import fs from 'node:fs';
   // ... at top of file, add to existing imports

   export function resolveDaemonEntry(appPath: string): string {
     const candidates = [
       path.join(appPath, 'daemon', 'main.cjs'),
       path.join(appPath, '..', 'daemon', 'main.cjs'),
     ];
     for (const candidate of candidates) {
       if (fs.existsSync(candidate)) return candidate;
     }
     return candidates[0];
   }
   ```

   The first candidate is `<appPath>/daemon/main.cjs` (the layout used by `electron dist/main/index.js` after the build copy in Task 2). The second is `<appPath>/../daemon/main.cjs` (the project-root layout used by `electron .`). The function returns the first one that exists on disk, falling back to the first candidate if neither exists (preserves the current behavior of always returning a path).

2. Replace the line at `spawn.ts:154`:

   ```ts
   const entry = path.join(app.getAppPath(), 'daemon', 'main.cjs');
   ```

   with:

   ```ts
   const entry = resolveDaemonEntry(app.getAppPath());
   ```

   Do NOT change anything else in `spawnDaemon()`. The `spawn()` call, the handshake logic, the audit logging, and the respawn timers all stay byte-for-byte identical. Only the path-resolution expression is swapped.

3. Add `import fs from 'node:fs';` at the top of `spawn.ts` next to the existing `path` import. Do not import any other modules.

In `tests/unit/spawn.test.ts` (NEW file):

4. Follow the safeStorage.test.ts pattern exactly: `vi.mock('electron', () => ({ app: { getAppPath: () => 'unused' }, BrowserWindow: { getAllWindows: () => [] } }))` so the `electron` import inside `spawn.ts` resolves to a stub during the unit test. The stub satisfies the module-level reference but the function under test never calls it because we pass `appPath` directly.

5. Create a fresh temp dir per test using `fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-spawn-'))` (same pattern as safeStorage.test.ts) and clean up in `afterEach` with `fs.rmSync(tempDir, { recursive: true, force: true })`.

6. Test cases (each in its own `it` block):

   - **Case A - dev mode (`electron .`)**: `appPath = path.join(tempDir, 'project')`. Create `<tempDir>/project/daemon/main.cjs` (write a one-line stub `// stub`). Assert `resolveDaemonEntry(appPath)` equals `<tempDir>/project/daemon/main.cjs`.
   - **Case B - built mode (`electron dist/main/index.js`)**: `appPath = path.join(tempDir, 'project', 'dist', 'main')`. Create `<tempDir>/project/dist/main/daemon/main.cjs`. Assert `resolveDaemonEntry(appPath)` equals `<tempDir>/project/dist/main/daemon/main.cjs`.
   - **Case C - fallback when nothing exists**: pick a non-existent `appPath` like `path.join(tempDir, 'nothing')`. Assert the function returns `<that path>/daemon/main.cjs` (first candidate - preserves current behavior of never throwing).
   - **Case D - both layouts exist, prefer direct child**: `appPath = <tempDir>/project` AND both `<tempDir>/project/daemon/main.cjs` and `<tempDir>/project/../daemon/main.cjs` (= `<tempDir>/daemon/main.cjs`) exist. Assert the function returns the direct-child path, not the parent-fallback path. This proves the candidate ordering is correct.
   - **Case E - import smoke**: just importing `resolveDaemonEntry` from `spawn.ts` compiles under the vitest + electron-mock setup. (This is implicit; the four cases above already exercise the import. If you want a dedicated `it`, add a one-liner `expect(typeof resolveDaemonEntry).toBe('function')`.)

7. Do NOT add any new devDependency. `vi`, `fs`, `os`, `path` are already in use elsewhere.

8. Do NOT modify `vitest.config.ts`. The existing `deps.inline: [/electron/]` already makes the `vi.mock('electron', ...)` factory work.
  </action>
  <verify>
    <automated>npx tsc --noEmit -p tsconfig.main.json && npm test -- tests/unit/spawn.test.ts</automated>
  </verify>
  <done>
    - `src/main/daemon/spawn.ts` exports `resolveDaemonEntry(appPath: string): string` and `spawnDaemon()` calls `resolveDaemonEntry(app.getAppPath())` instead of inlining `path.join(...)`.
    - `tests/unit/spawn.test.ts` exists with 4-5 passing cases covering: dev-mode appPath, built-mode appPath, missing-file fallback, both-layouts-present ordering, and (optionally) import smoke.
    - The test file uses `vi.mock('electron', ...)` mirroring the safeStorage.test.ts pattern.
    - `npx tsc --noEmit -p tsconfig.main.json` exits 0 (no type errors from the new fs import or new function).
    - `npm test -- tests/unit/spawn.test.ts` exits 0.
    - No other source file changed - only `spawn.ts` in `src/main/daemon/` is touched.
  </done>
</task>

<task type="auto">
  <name>Task 2: Update build scripts to copy daemon/ into dist/main/daemon/</name>
  <files>package.json</files>
  <action>
In `package.json` scripts:

1. Replace `"build:main": "tsc -p tsconfig.main.json"` with the chained command that runs tsc then mirrors the runtime `.cjs` files into the compiled output directory:

   ```
   "build:main": "tsc -p tsconfig.main.json && node -e \"const fs=require('node:fs');fs.mkdirSync('dist/main/daemon',{recursive:true});fs.cpSync('daemon','dist/main/daemon',{recursive:true,filter:(s)=>!s.endsWith('.map')})\""
   ```

   - Inline `node -e` avoids adding a new script file (per implementer guidance). Escape inner double quotes with `\"` so the JSON stays valid.
   - `mkdirSync('dist/main/daemon', { recursive: true })` runs first because `fs.cpSync` requires the destination's parent to exist (it creates the leaf folder name `daemon` but not the chain `dist/main/daemon`).
   - The `filter` excludes source paths ending in `.map` - guards against accidental future sourcemaps; no `.map` files exist under `daemon/` today, but the filter is cheap insurance.
   - Order matters: copy runs AFTER tsc, so the tsc-compiled `dist/main/daemon/{spawn,protocol}.js` files are NOT clobbered. The copy sources are `.cjs` files, the tsc outputs are `.js` files - different filenames, so they coexist in the same folder.

2. Replace `"build": "tsc -p tsconfig.main.json && vite build"` with `"build": "npm run build:main && npm run build:renderer"` so `npm start` (which consumes `dist/main/index.js`) gets the daemon copy for free. `build:renderer` already exists as `"vite build"` - leave it alone.

3. Do NOT touch `dev:electron`. It already works because `electron .` resolves `appPath` to the project root where `daemon/main.cjs` is already present. Changing it would either inline the copy OR call `build:main`, both of which would slow the dev loop for no behavior benefit.

4. After editing, run from repo root:

   ```
   rm -rf dist/main/daemon
   npm run build
   test -f dist/main/daemon/main.cjs
   test -f dist/main/daemon/protocol.cjs
   test -f dist/main/daemon/audit.cjs
   test -f dist/main/daemon/tools/registry.cjs
   test -f dist/main/daemon/spawn.js
   test -f dist/main/daemon/protocol.js
   test ! -f dist/main/daemon/main.cjs.map
   ```

   All seven `test` lines must succeed. If any fails, fix the script and re-run.

5. Do NOT modify `tsconfig.main.json`, `vitest.config.ts`, or any source file - those are out of scope for this task.
  </action>
  <verify>
    <automated>rm -rf dist/main/daemon && npm run build && (test -f dist/main/daemon/main.cjs && test -f dist/main/daemon/protocol.cjs && test -f dist/main/daemon/audit.cjs && test -f dist/main/daemon/tools/registry.cjs && test -f dist/main/daemon/spawn.js && test -f dist/main/daemon/protocol.js && test ! -f dist/main/daemon/main.cjs.map && echo OK_BUILD_ARTIFACTS) || (echo FAIL_BUILD_ARTIFACTS && exit 1)</automated>
  </verify>
  <done>
    - `package.json` `build:main` runs `tsc -p tsconfig.main.json` then mirrors `daemon/` into `dist/main/daemon/` via inline `node -e` + `fs.cpSync`, with a `.map` filter and pre-copy `mkdirSync`.
    - `package.json` `build` routes through `npm run build:main && npm run build:renderer` (instead of inlining `tsc -p tsconfig.main.json`), so `npm start` is fixed.
    - `dev:electron` is unchanged.
    - After `rm -rf dist/main/daemon && npm run build`: `main.cjs`, `protocol.cjs`, `audit.cjs`, `tools/registry.cjs` (copy outputs) AND `spawn.js`, `protocol.js` (tsc outputs) all exist. No `.map` files in `dist/main/daemon/`.
  </done>
</task>

</tasks>

<verification>
After both tasks land:

1. `npm test` exits 0 (Task 1's 4-5 unit-test cases plus all pre-existing tests pass).
2. `npm run build` produces `dist/main/daemon/main.cjs` plus the other three runtime files (Task 2).
3. `npx tsc --noEmit -p tsconfig.main.json` exits 0 (Task 1's refactor compiles cleanly).
4. Manual smoke (documented in SUMMARY under "Known Limitations" mirroring `01-VERIFICATION.md`'s pattern, NOT gated as automated verify): `npm start` opens the Electron window and the renderer shows daemon status `ready` within 10 seconds - proves the file was found and the handshake succeeded. Headed launch is out of scope for CI on this fix; record the manual check as a follow-up the user can run on their desktop machine.
</verification>

<success_criteria>
- The `npm start` ENOENT bug from `01-VERIFICATION.md` is fixed at the source: the build now places the daemon next to the compiled main bundle.
- Five new artifacts exist on disk after a clean build: `dist/main/daemon/main.cjs`, `dist/main/daemon/protocol.cjs`, `dist/main/daemon/audit.cjs`, `dist/main/daemon/tools/registry.cjs` AND `tests/unit/spawn.test.ts`.
- The path resolution in `spawn.ts` is unchanged in behavior, just extracted into a named, tested function.
- No change to `dev:electron`, `tsconfig.main.json`, `vitest.config.ts`, or any file in `src/` other than `spawn.ts`.
- Both tasks finish with their `<automated>` verify commands returning success.
</success_criteria>

<output>
Write SUMMARY to `D:/Claude/Grokbot/.planning/quick/260917-vlw-fix-spawn-ts-resolves-daemon-to-dist-mai/260917-vlw-fix-spawn-ts-resolves-daemon-to-dist-mai-SUMMARY.md` after execution.
</output>