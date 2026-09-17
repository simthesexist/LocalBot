---
quick: 260917-vvk-fix-src-main-window-ts-10-uses-isdev-app
plan: 260917-vvk
subsystem: window-renderer-loading
tags: [electron, renderer, fs, branch-by-existence, vitest, unit-test]

# Dependency graph
requires:
  - phase: phase-1-skeleton
    provides: "Phase 1 main process bundle + renderer dev server on 5173"
provides:
  - "Pure resolveRendererUrl({ builtIndexPath, devUrl? }) in src/main/window.ts"
  - "RendererTarget type ('built' | 'dev')"
  - "Vitest unit test covering built / dev-default / dev-custom branches"
affects: ["all-electron-launch-flows"]

# Actuals (#2632)
actuals:
  tokens: 1100
  tasks: 1
  commits: 1

# Tech tracking
tech-stack:
  added: []
  patterns: ["branch-by-file-existence for built-vs-dev rendering", "vi.mock('electron', ...) + mkdtempSync for resolver tests"]

key-files:
  created:
    - tests/unit/window.test.ts
  modified:
    - src/main/window.ts

key-decisions:
  - "Branch on file existence (built/dist/renderer/index.html) rather than env var to avoid adding cross-env dependency and to keep package.json scripts untouched"
  - "Preserve the same path arithmetic (path.join(__dirname, '..', '..', 'renderer', 'index.html')) so the dist layout is reused as-is"

patterns-established:
  - "When deciding between built and dev loading, prefer file-existence over process flags so unpackaged 'npm start' works without an extra build-script env var"

requirements-completed: []

# Coverage metadata
coverage:
  - id: W1
    description: "resolveRendererUrl returns 'built' target when built index file exists"
    verification:
      - kind: unit
        ref: "tests/unit/window.test.ts#built branch"
        status: pass
    human_judgment: false
  - id: W2
    description: "resolveRendererUrl returns 'dev' target with default URL when built file is absent"
    verification:
      - kind: unit
        ref: "tests/unit/window.test.ts#dev branch default URL"
        status: pass
    human_judgment: false
  - id: W3
    description: "resolveRendererUrl honors custom devUrl override"
    verification:
      - kind: unit
        ref: "tests/unit/window.test.ts#dev branch custom URL"
        status: pass
    human_judgment: false
  - id: W4
    description: "npm run build produces dist/renderer/index.html so npm start reaches built branch"
    verification:
      - kind: automated_ui
        ref: "rm -rf dist && npm run build && test -f dist/renderer/index.html && test -f dist/main/daemon/main.cjs && test -f dist/main/window.js"
        status: pass
    human_judgment: false
  - id: W5
    description: "Headed npm start loads KeyModal on a desktop machine (end-to-end smoke)"
    verification: []
    human_judgment: true
    rationale: "Headed Electron smoke + UI observation cannot run in this CI environment - desktop session required."

# Metrics
duration: 2min
completed: 2026-09-17
status: complete
---

# Quick 260917-vvk: window.ts dev-mode renderer URL fix Summary

**Branch renderer URL on built-index file existence (not `!app.isPackaged`) so unpackaged `npm start` correctly loads the built `dist/renderer/index.html` instead of failing with `ERR_CONNECTION_REFUSED` on `localhost:5173`.**

## Performance

- **Duration:** ~2 min wall
- **Started:** 2026-09-17T22:00:30Z
- **Completed:** 2026-09-17T22:02:30Z
- **Tasks:** 1
- **Files modified:** 2 (`src/main/window.ts`, new `tests/unit/window.test.ts`)

## Accomplishments

- `src/main/window.ts` drops the `const isDev = !app.isPackaged` heuristic and replaces it with a pure `resolveRendererUrl({ builtIndexPath, devUrl? })` that returns `{ kind: 'built', path }` when `fs.existsSync(builtIndexPath)` is true, else `{ kind: 'dev', url: devUrl ?? 'http://localhost:5173' }`. `createMainWindow()` computes `builtIndexPath = path.join(__dirname, '..', '..', 'renderer', 'index.html')` and switches on `target.kind` between `loadFile` and `loadURL`.
- `tests/unit/window.test.ts` covers 4 cases mirroring `tests/unit/spawn.test.ts`: built branch (file exists), dev branch with default URL, dev branch with custom `devUrl` override, and an import-smoke check.
- Full test suite: **30 passed** + 1 skipped (added 4 new `window.test.ts` cases on top of 26 pre-existing).
- `npx tsc --noEmit -p tsconfig.main.json` exits 0.
- `rm -rf dist && npm run build` produces `dist/renderer/index.html`, `dist/main/window.js`, and `dist/main/daemon/main.cjs` — all three present.
- `grep isPackaged src/main/window.ts` returns no matches (heuristic removed); `grep isPackaged dist/main/window.js` also empty (the JSDoc reference was rephrased to avoid leaving the literal token behind).

## Task Commits

1. **Task 1: Refactor `src/main/window.ts` + add vitest unit test** - `d6ad10e` (fix, atomic — both files in one commit)

## Files Created/Modified

- `src/main/window.ts` - Added `import fs from 'node:fs'`; dropped `const isDev = !app.isPackaged`; exported pure `resolveRendererUrl(...)` and `RendererTarget` type; switched `createMainWindow()` to branch on `target.kind`.
- `tests/unit/window.test.ts` - New file. 4 cases using `vi.mock('electron', ...)` shim + `fs.mkdtempSync` temp dirs, mirroring the `tests/unit/spawn.test.ts` pattern.

## Decisions Made

- **File-existence over env var.** Avoids adding `cross-env` as a dependency. `npm run build` writes `dist/renderer/index.html`; `tsc` alone doesn't. So the resolver correctly lands in the built branch after a build, and in the dev branch when only `tsc` (no vite build) has run.
- **Reused existing path arithmetic.** `path.join(__dirname, '..', '..', 'renderer', 'index.html')` already points to `dist/renderer/index.html` under `electron dist/main/index.js` (where `__dirname` is `dist/main`). No layout or script change needed.
- **Rephrased the JSDoc reference to `app.isPackaged`.** The old comment block mentioned the heuristic by name; tsc preserves comments in compiled output, so the literal token `isPackaged` would have remained visible in `dist/main/window.js`. Folded the rephrasing into the same atomic commit via `git commit --amend` to keep the compiled bundle clean.
- **Did not touch `package.json` scripts.** The fix is entirely in `window.ts` + a new test file.

## Deviations from Plan

None substantive. The JSDoc rephrase mentioned above was the only delta from the plan-as-written; it had no behavioral effect and landed in the same atomic commit.

## Issues Encountered

- The executor's first commit included the literal token `isPackaged` in the JSDoc comment, which tsc preserved into `dist/main/window.js`. The plan-checker step (omitted in `--quick` mode) would have caught this; the executor caught it during self-verify and amended before reporting back. No second commit needed.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Phase 2 (File Tools + Search + Tool System) can proceed. `npm start` after `npm run build` should now reach the KeyModal instead of hitting `localhost:5173`.
- Headed Electron smoke is the only remaining human-verification item; record it as a follow-up to run on a desktop machine.

---

*Quick: 260917-vvk-fix-src-main-window-ts-10-uses-isdev-app*
*Completed: 2026-09-17*

> **Note:** This SUMMARY.md was reconstructed by the orchestrator after the executor's worktree was cleaned up. The executor followed the constraint "Do NOT commit docs artifacts (SUMMARY.md, STATE.md, PLAN.md) — orchestrator handles in Step 8" and the file lived as untracked inside the worktree, which was then removed. The substance above is drawn from the executor's `## PLAN COMPLETE` report (commit `d6ad10e`, verification results, files modified, key decisions, and deviations).
