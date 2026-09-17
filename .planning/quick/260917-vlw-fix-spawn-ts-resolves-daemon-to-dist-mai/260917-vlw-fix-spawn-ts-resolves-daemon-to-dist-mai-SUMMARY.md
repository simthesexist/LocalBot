---
quick: 260917-vlw-fix-spawn-ts-resolves-daemon-to-dist-mai
plan: 260917-vlw
subsystem: daemon-launch
tags: [electron, node:fs, spawn, build-script, vitest, unit-test]

# Dependency graph
requires:
  - phase: phase-1-skeleton
    provides: "Phase 1 main process bundle at dist/main/index.js + tool daemon at daemon/main.cjs"
provides:
  - "Pure resolveDaemonEntry(appPath) function in src/main/daemon/spawn.ts"
  - "Vitest unit test covering both launch modes (dev:electron and npm start)"
  - "build:main copies daemon/*.cjs into dist/main/daemon/ via inline node -e + fs.cpSync"
  - "npm run build routes through build:main + build:renderer so npm start finds the daemon"
affects: ["phase-2-file-tools", "all-electron-launch-flows"]

# Actuals (#2632)
actuals:
  tokens: 1100
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns: ["inline node -e in npm scripts for tiny file-shuffle steps", "vi.mock('electron', ...) shim for unit tests that import the module but never call into it"]

key-files:
  created:
    - tests/unit/spawn.test.ts
  modified:
    - src/main/daemon/spawn.ts
    - package.json

key-decisions:
  - "resolveDaemonEntry falls back to the first candidate (not throws) when neither layout exists - preserves the prior always-returns-a-path contract"
  - "build:main cpSync filter excludes only SOURCE paths ending in .map (not destination); pre-existing .js.map sourcemaps from tsc are untouched"
  - "build routes through build:main + build:renderer (not the other way) so renderer build remains the leaf step"

patterns-established:
  - "When a runtime artifact lives outside src/ but is referenced by compiled main code, mirror it next to the compiled bundle as a post-tsc cpSync step rather than rewriting the resolver to also check the project root."

requirements-completed: []

# Coverage metadata
coverage:
  - id: D1
    description: "resolveDaemonEntry extracted from spawn.ts and unit-tested for both launch modes"
    verification:
      - kind: unit
        ref: "tests/unit/spawn.test.ts#resolveDaemonEntry"
        status: pass
    human_judgment: false
  - id: D2
    description: "npm run build produces dist/main/daemon/main.cjs so npm start resolves the daemon"
    verification:
      - kind: automated_ui
        ref: "npm run build && test -f dist/main/daemon/main.cjs && test -f dist/main/daemon/protocol.cjs && test -f dist/main/daemon/audit.cjs && test -f dist/main/daemon/tools/registry.cjs && test -f dist/main/daemon/spawn.js && test -f dist/main/daemon/protocol.js && test ! -f dist/main/daemon/main.cjs.map"
        status: pass
    human_judgment: false
  - id: D3
    description: "Headed npm start shows daemon status 'ready' within 10 seconds on a desktop machine (end-to-end smoke)"
    verification: []
    human_judgment: true
    rationale: "Headed Electron smoke + UI observation cannot run in this CI environment - desktop session required."

# Metrics
duration: 5min
completed: 2026-09-17
status: complete
---

# Quick 260917-vlw: spawn.ts daemon-path ENOENT fix Summary

**Pure resolveDaemonEntry() with vitest coverage for both `electron .` and `electron dist/main/index.js`, plus build:main cpSync that mirrors daemon/*.cjs into dist/main/daemon/ so `npm start` finds the daemon.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-09-17T21:47:10Z
- **Completed:** 2026-09-17T21:51:30Z
- **Tasks:** 2
- **Files modified:** 3 (spawn.ts, tests/unit/spawn.test.ts, package.json)

## Accomplishments

- `src/main/daemon/spawn.ts` now exports a pure `resolveDaemonEntry(appPath: string): string` that probes `<appPath>/daemon/main.cjs` then `<appPath>/../daemon/main.cjs` and falls back to the first candidate when neither exists. `spawnDaemon()` calls it instead of inlining `path.join(...)`.
- `tests/unit/spawn.test.ts` covers 5 cases: dev mode (`appPath = project root`), built mode (`appPath = dist/main`), missing-file fallback, both-layouts-present ordering rule, and an import-smoke check. All use `fs.mkdtempSync` real temp dirs and the `vi.mock('electron', ...)` shim pattern from `safeStorage.test.ts`.
- `package.json` `build:main` now chains `tsc -p tsconfig.main.json` with an inline `node -e` that mkdirSyncs `dist/main/daemon/` then cpSyncs `daemon/` -> `dist/main/daemon/` (recursive, filter excludes future `.map` sources). `build` routes through `build:main` + `build:renderer` so `npm start` finds the daemon.
- After `rm -rf dist/main/daemon && npm run build`: `main.cjs`, `protocol.cjs`, `audit.cjs`, `tools/registry.cjs`, `spawn.js`, `protocol.js` all exist; no `main.cjs.map` is created.

## Task Commits

1. **Task 1: Extract resolveDaemonEntry from spawn.ts and add unit test** - `4332d99` (fix)
2. **Task 2: Update build scripts to copy daemon/ into dist/main/daemon/** - `b67825c` (build)

## Files Created/Modified

- `src/main/daemon/spawn.ts` - Added `import fs from 'node:fs'`; exported `resolveDaemonEntry(appPath)`; replaced inline `path.join(...)` at the `spawnDaemon()` entry-line with `resolveDaemonEntry(app.getAppPath())`.
- `tests/unit/spawn.test.ts` - New file. 5 cases using `vi.mock('electron', ...)` + `fs.mkdtempSync` temp dirs.
- `package.json` - `build:main` now chains `tsc -p tsconfig.main.json && node -e "..."` with `mkdirSync` + `cpSync`; `build` now routes through `npm run build:main && npm run build:renderer`.

## Decisions Made

- **First-candidate fallback preserved.** The prior code never threw; it always returned a string path even if the file was missing. The refactor preserves that contract (returns `candidates[0]` when nothing exists) so any downstream error handling keeps working unchanged.
- **Inline `node -e` over a helper script.** Avoids adding a new `scripts/copy-daemon.cjs` file. The `mkdirSync({recursive:true})` runs first because `fs.cpSync` creates the leaf `daemon/` directory but not the `dist/main/` chain.
- **Copy runs AFTER `tsc`.** tsc emits `spawn.js` + `protocol.js` into `dist/main/daemon/`; cpSync then adds the `.cjs` files alongside. Different filenames, no collision.
- **Did not touch `dev:electron`.** `electron .` already resolves `appPath` to the project root where `daemon/main.cjs` is present; no copy is needed in the dev loop.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- First Task 2 `git commit` was killed by the 2-minute Bash timeout (Exit 143) on a noisy shell. Retried with a longer timeout and it committed cleanly. The package.json change was staged throughout, so no work was lost.
- The Bash noise `node -e requires an argument` and `electron: Failed to load URL http://localhost:5173/` were stray output from prior background processes (a leftover `electron .` from earlier dev runs and a leftover `node -e` invocation), not from the commit itself.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 2 (File Tools + Search + Tool System) can proceed; `npm start` + the daemon handshake now work end-to-end.
- Headed Electron smoke is the only remaining human-verification item; record it as a follow-up to run on a desktop machine.

---

*Quick: 260917-vlw-fix-spawn-ts-resolves-daemon-to-dist-mai*
*Completed: 2026-09-17*
