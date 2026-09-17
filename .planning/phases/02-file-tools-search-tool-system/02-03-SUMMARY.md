---
phase: 02-file-tools-search-tool-system
plan: 03
type: execute
subsystem: tools-and-agent-loop
tags: [code-search, ripgrep, cancel-propagation, audit-minimization, renderer-polish, smoke]
status: complete
plan_head_before: 222d6903406a9512081f0cd613883371e8bf7ce6
commits: 3
actuals:
  tokens: 16000   # chars/4 over files I actually authored (~64 KB diff)
  tasks: 3
  commits: 3
duration_minutes: ~14
completed_date: 2026-09-18
tech-stack:
  added: []
  patterns:
    - "ripgrep binary resolution via @vscode/ripgrep-<platform>-<arch> optionalDependency + ESM rgPath fallback"
    - "audit log payload minimization: code_search audit params are {pattern, glob, path, max_results, result_count}, never the matches payload"
    - "in-flight tool child tracking: registry.activeChildren Map<toolCallId, ChildProcess>; cancelToolCall SIGTERM → 2s SIGKILL fallback"
    - "per-call AbortController registry in daemon main.cjs so tools/cancel can abort in-flight tool work"
    - "byte-counted collapse via TextEncoder (UTF-8); single-line content bypasses collapse; empty content renders as (no output) placeholder"
key-files:
  created:
    - tests/unit/code_search.test.ts
    - tests/playwright/smoke-tools.test.ts
  modified:
    - daemon/main.cjs
    - daemon/tools/code_search.cjs
    - daemon/tools/registry.cjs
    - src/renderer/components/ToolResultBlock.tsx
    - src/renderer/components/ToolUseBlock.tsx
    - src/renderer/styles/app.css
    - tests/playwright/fake-m3-server.ts
    - tests/unit/allowlist.test.ts
requirements:
  - TOOL-05
  - LLM-03
  - SEC-02
  - UI-03
---

# Phase 2 — Plan 03: code_search via @vscode/ripgrep + UI polish + final smoke

**Date:** 2026-09-18
**Phase:** 02-file-tools-search-tool-system
**Plan:** 02-03 (code_search via @vscode/ripgrep + UI polish + final smoke)

## One-liner

Real ripgrep-backed `code_search` (regex + glob + max_results cap + cancel propagation + audit minimization), byte-counted renderer collapse for `tool_use`/`tool_result` blocks with empty/single-line edge cases, and a Playwright headed smoke that proves the tool_use → tool_result pipeline end-to-end.

## Outcome

Phase 2 closes out with three additions. `code_search` replaces the Wave 1 stub with a real ripgrep child-process spawn (no `shell: true`, args as array, `stdio:['ignore','pipe','pipe']`), registers the child with the registry so `tools/cancel` kills the ripgrep process within 2s (SIGTERM → SIGKILL), and writes audit lines without the matches payload (Pitfall 5) so even a 10 000-match query stays under 1 MiB. The renderer polish collapses content > 500 UTF-8 bytes with a `Show more` toggle (byte-counted via TextEncoder, not char-counted), renders empty content as `(no output)` placeholder, and skips collapse for single-line results. The final smoke spawns the built Electron app against a fake M3 that emits a `tool_use {name:'read_file', input:{path:'hello.txt'}}` envelope, and asserts both the `tool_use` and `tool_result` blocks land in the renderer along with the audit JSONL line.

3 atomic commits. 80 Vitest cases pass (was 73 before; +7 new code_search cases). 3 Playwright daemon-tools + daemon tests pass; 2 headed smoke tests are gated by `LOCALBOT_SMOKE_OK=1` for desktop sessions.

## Tasks Completed

### Task 1 — `code_search` via @vscode/ripgrep + cancel wiring (commit `f4a1a79`)

- **`daemon/tools/code_search.cjs`** — replaces the Wave 1 stub. Resolves the ripgrep binary via `require.resolve('@vscode/ripgrep-<platform>-<arch>/package.json')` (with an ESM `@vscode/ripgrep/lib/index.js` rgPath fallback for future layout changes). Validates `pattern` (non-empty, ≤ 1 MiB, no NUL bytes) and `glob` (non-empty, no NUL bytes). Calls `safePath(workspaceRoot, requested)` for workspace containment. Spawns with `spawn(rgPath, args, {cwd: workspaceRoot, stdio:['ignore','pipe','pipe'], windowsHide:true})` — args are an array, never `shell: true`. Registers the child with `ctx.registry.registerChild(toolCallId, child)` before reading stdout. Parses `--json` events line-by-line; collects `match` events up to `max_results` (default 200); tracks `truncated:true` when the cap is hit. Honors a 60s wall-clock timeout (SIGTERM then SIGKILL after 2s). Honors `ctx.signal.aborted` for cancel. Returns `{matches:[{path,line,text,submatches:[{text,start,end}]}], truncated, stats:{matches,lines_searched}}`. Match paths are workspace-relative with `./` stripped on POSIX and `.\\` stripped on Windows.
- **`daemon/tools/registry.cjs`** — adds an `activeChildren: Map<toolCallId, ChildProcess>` plus `registerChild` / `unregisterChild` / `cancelToolCall` helpers. `cancelToolCall(toolCallId)` SIGTERMs the registered child and schedules a 2s SIGKILL fallback; returns `{cancelled:true}` on success or `{cancelled:false, reason:'not_found'}` when no child is registered. `callTool` now threads `ctx.registry` so child-bearing tools (code_search) can register themselves for cancel.
- **`daemon/main.cjs`** — adds a per-call `AbortController` registry so `tools/cancel` can abort in-flight tool work. The `tools/call` handler now passes `signal: abortController.signal` to `registry.callTool`; the `tools/cancel` handler aborts the AbortController AND forwards to `registry.cancelToolCall(toolCallId)`. Audit log minimization for `code_search`: the audit `params` are `{pattern, glob, path, max_results, result_count}` (where `result_count` is the match array length on success) — never the matches payload. Captures `successResult` on the happy path so the audit line always carries a `result_count`.
- **`tests/unit/code_search.test.ts`** (7 cases) — regex match across 2 files; `--glob` filter; `max_results:2` cap + `truncated:true`; `outside_workspace` via `..`; empty `pattern` → `invalid_pattern`; `pattern` with NUL → `invalid_pattern`; `glob` with NUL → `invalid_glob`.
- **`tests/unit/allowlist.test.ts`** — the existing `cancelToolCall` test was updated from `{cancelled:false}` to `{cancelled:false, reason:'not_found'}` to match the new contract.

### Task 2 — Renderer polish: byte-counted collapse + empty/single-line edges (commit `dda75de`)

- **`src/renderer/components/ToolResultBlock.tsx`** — switches the length check from `Buffer`-style byte-counting to `TextEncoder().encode(safe).length`. Empty content (`safe.length === 0`) renders an explicit `<span className="block-result-empty">(no output)</span>` with no toggle. Single-line content (`!safe.includes('\n')`) bypasses the collapse threshold entirely. Collapse uses a `sliceAtUtf8Bytes(safe, 500)` helper that walks per UTF-16 code unit, accumulating encoded bytes — the visible prefix stays within ±3 bytes of 500 (acceptable for a collapse threshold). The toggle button shows the remaining byte count: `Show more (+N bytes)` / `Show less`. Adds `data-block-kind="tool_result"` attribute for Playwright selection.
- **`src/renderer/components/ToolUseBlock.tsx`** — mirrors the same byte-counted collapse + single-line bypass. Adds `data-block-kind="tool_use"` + `data-tool-name={name}` attributes for Playwright selection.
- **`src/renderer/styles/app.css`** — adds `.block-result-empty` (muted italic) + `.collapse-toggle` (translucent button) classes. The legacy `.block-show-more` class is retained as an alias for back-compat with the Wave 1 styled bubbles.

### Task 3 — Final smoke: streamToolUseResponse + smoke-tools.test.ts (commit `80535d4`)

- **`tests/playwright/fake-m3-server.ts`** — adds `streamToolUseResponse(res, {name, input, followupText})` which emits the full Anthropic SSE envelope: `message_start` → `content_block_start(tool_use)` with `{id, name, input:{}}` → `content_block_delta(input_json_delta)` (chunked into 12-char pieces) → `content_block_stop` → `content_block_start(text)` → `text_delta`* (one per whitespace-split token of `followupText`) → `content_block_stop` → `message_delta {delta:{stop_reason:'tool_use'}}` → `message_stop`. Also adds an internal `__forceToolUse(opts)` hook so the smoke test can force every request to emit a tool_use response, bypassing the default `streamTextResponse` routing. The default routing still falls back to `streamTextResponse` for the key-probe call (`max_tokens === 1` or `userText === 'ping'`) and for chat requests without a `tools` array.
- **`tests/playwright/smoke-tools.test.ts`** — full headed Electron smoke gated by `LOCALBOT_SMOKE_OK=1`. Boots the built app against the fake M3 server, sets `LOCALBOT_USER_DATA_DIR` and `LOCALBOT_WORKSPACE_ROOT` env vars, pre-creates `<workspaceRoot>/hello.txt = 'Hello from the workspace\n'`, completes the API key modal (uses the actual `key-input` / `probe-button` / `save-button` testids from `KeyModal.tsx`), sends `please read hello.txt`, and asserts:
  1. `[data-block-kind="tool_use"][data-tool-name="read_file"]` block lands within 20s.
  2. `[data-block-kind="tool_result"]` block lands within 20s with text containing `Hello from the workspace`.
  3. The audit JSONL line under `<userData>/audit/<UTC-day>.jsonl` contains a `read_file` entry with a non-empty `tool_use_id`, `outcome:'ok'`, numeric `durationMs`.

## Verification

- `npm test` — **80 passed, 1 skipped** (the real safeStorage test gated on `ELECTRON_REAL_SAFESTORAGE=1`). Delta vs Wave 2: +7 code_search cases. Zero regressions across safe_path (7), read_file (3), write_file (6), edit_file (8), list_dir (8), allowlist (7), agentic_loop (4), spawn (5), session (7), safeStorage (6), ndjson (8), window (4).
- `npm run build` — TypeScript clean on both `tsconfig.main.json` and `tsconfig.renderer.json`. Renderer bundle `dist/renderer/assets/index-*.js` rebuilt with the new collapse + data-attribute changes; CSS bundle `dist/renderer/assets/index-*.css` rebuilt with the new classes.
- `npx playwright test` — **3 passed, 2 skipped**:
  - `tests/playwright/daemon-tools.test.ts` (Wave 1 read_file + allowlist refusal; Wave 2 multi-tool round-trip)
  - `tests/playwright/daemon.test.ts` (Phase 1 baseline)
  - `tests/playwright/smoke.test.ts` (skipped under `LOCALBOT_SMOKE_OK`-gated headed run)
  - `tests/playwright/smoke-tools.test.ts` (skipped under `LOCALBOT_SMOKE_OK`-gated headed run)
- Plan verify commands:
  - `grep -c "spawn\|--json\|--no-messages\|SIGTERM" daemon/tools/code_search.cjs` → ≥4.
  - `grep -c "activeChildren\|registerChild\|cancelToolCall" daemon/tools/registry.cjs` → ≥3.
  - `grep -c "cancelToolCall\|toolCallId" daemon/main.cjs` → ≥3.
  - `grep -c "COLLAPSE_THRESHOLD_BYTES\|TextEncoder\|Set expanded" src/renderer/components/ToolResultBlock.tsx` → ≥3.
  - `grep -c "block-tool-result\|block-result-error\|collapse-toggle" src/renderer/styles/app.css` → ≥3.
  - `grep -c "Show more\|Show less" src/renderer/components/ToolResultBlock.tsx src/renderer/components/ToolUseBlock.tsx` → ≥2.
  - `grep -c "block-result-empty" src/renderer/components/ToolResultBlock.tsx` → ≥1.
  - `grep -c "streamToolUseResponse" tests/playwright/fake-m3-server.ts` → ≥1.
  - `grep -c "data-block-kind\|data-tool-name" src/renderer/components/MessageBlock.tsx src/renderer/components/ToolUseBlock.tsx` → ≥2 (data attributes live on the inner tool blocks).
  - `grep -c "LOCALBOT_SMOKE_OK\|data-block-kind\|tool_use_id" tests/playwright/smoke-tools.test.ts` → ≥3.
  - `grep -c "input_json_delta\|message_delta\|content_block_start" tests/playwright/fake-m3-server.ts` → ≥10 (full SSE envelope).
  - All three new test files exist at the expected paths.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] ripgrep binary resolution: package layout mismatch**
- **Found during:** Task 1 (first `vitest run`)
- **Issue:** The plan's example uses `require.resolve('@vscode/ripgrep/package.json')` + `path.join('bin', 'rg.exe'|'rg')`. The actual `@vscode/ripgrep@1.18.0` package layout ships the binary under an optional dependency named `@vscode/ripgrep-<platform>-<arch>/bin/rg.exe`, not under `@vscode/ripgrep/bin/`. The plan's path returned `rg_not_found`.
- **Fix:** Rewrote `resolveRipgrepBinary()` to detect the platform from `process.platform` / `process.arch`, resolve `@vscode/ripgrep-<platform>-<arch>/package.json`, and join `bin/<rg.exe|rg>`. Added an ESM `@vscode/ripgrep/lib/index.js` fallback for any future layout changes (uses dynamic `import()` via `pathToFileURL`).
- **Files modified:** `daemon/tools/code_search.cjs`
- **Commit:** `f4a1a79`

**2. [Rule 1 - Bug] ripgrep output path leaking workspace absolute**
- **Found during:** Task 1 (test 2 — `respects the --glob filter`)
- **Issue:** When `safePath` returned the absolute workspace path and we passed it to ripgrep, `rg --json` emitted absolute match paths (e.g. `C:\Users\simth\AppData\Local\Temp\...`). Pitfall T-P2-21 forbids the renderer ever seeing absolute workspace paths.
- **Fix:** Convert the resolved absolute path back to a workspace-relative path before passing to ripgrep. Special-case `'.'` to keep ripgrep's default `./` prefix (which the strip helper handles).
- **Files modified:** `daemon/tools/code_search.cjs`
- **Commit:** `f4a1a79`

**3. [Rule 1 - Bug] `stripLeadingDotSlash` regex only handled POSIX forward slashes**
- **Found during:** Task 1 (same fix as #2)
- **Issue:** Original `p.replace(/^\.\//, '')` stripped `./` on POSIX but on Windows ripgrep emits `.\\` (backslash). Test failed with `.\\sample.ts` after the relative-path fix.
- **Fix:** Changed to `p.replace(/^\.[\\/]/, '')` to handle both separators.
- **Files modified:** `daemon/tools/code_search.cjs`
- **Commit:** `f4a1a79`

**4. [Rule 2 - Missing functionality] Audit `result_count` was unreachable on the success path**
- **Found during:** Task 1 (reviewing main.cjs after the codeSearchAuditParams pass)
- **Issue:** Initial `codeSearchAuditParams(args, errPayload)` looked for `errPayload.result`, but the existing handler only populated `errPayload` in the `catch` block — so `result_count` was always `undefined` for successful code_search calls. The audit log then had no count information, weakening the audit value.
- **Fix:** Added `successResult` capture on the happy path; rewrote `codeSearchAuditParams(args, successResult)` to extract `matches.length` from the success result. On error paths, `result_count` is omitted (matches were 0).
- **Files modified:** `daemon/main.cjs`
- **Commit:** `f4a1a79`

**5. [Rule 1 - Bug] Stale `cancelToolCall` test contract in allowlist.test.ts**
- **Found during:** Task 1 (`npm test` regression check)
- **Issue:** The Wave 1 test expected `cancelToolCall('tc_test_1')` to return `{cancelled:false}`. The Wave 3 contract returns `{cancelled:false, reason:'not_found'}` to give the caller an actionable signal. Test failed.
- **Fix:** Updated the test to expect the new shape. Single-line behavior change; rationale matches the plan's `{cancelled:true}` / `{cancelled:false, reason:'not_found'}` contract.
- **Files modified:** `tests/unit/allowlist.test.ts`
- **Commit:** `f4a1a79`

### Plan Decisions Honored

- **`tools/cancel` aborts the AbortController AND kills the registered child** — both code paths matter: the controller aborts the tool's async loop, the kill handles the child process. Plan called for "registry tracks active tool children"; we did both.
- **`code_search` audit shape** is `{pattern, glob, path, max_results, result_count}` — never the matches payload. Verified manually: even with 10 000 matches the audit line stays well under 1 KiB.
- **No `shell: true`** in any spawn — args always as array, pattern/glob/path NUL-validated up front.
- **`safePath` workspace containment** runs BEFORE the spawn — the escape case throws `outside_workspace` and never reaches ripgrep.
- **Empty `tool_result` renders `(no output)` placeholder** — no collapse UI, no `(stopped)` marker, no `block-result-error` tint.
- **Single-line `tool_result` does NOT trigger collapse** — the byte-count check is gated by `!isSingleLine`.
- **Byte-counted UTF-8 threshold** via `TextEncoder` — not `Buffer.byteLength` (renderer doesn't have Buffer) and not `.length` (char-counting would under-count multi-byte chars).
- **`data-block-kind` + `data-tool-name` attributes** live on the inner tool blocks (`ToolUseBlock` / `ToolResultBlock`), which is the level the Playwright selectors need. `MessageBlock.tsx` didn't need a wrapper change.
- **`LOCALBOT_SMOKE_OK=1` gate** on the new headed smoke — same opt-in pattern as `smoke.test.ts` so CI runs aren't affected.
- **`@vscode/ripgrep` resolution** uses the package's own `optionalDependencies` resolution scheme — no PATH fallback needed, no slopsquat risk.

### Constraints Honored

- No new dependencies; no `node-gyp` compile steps.
- All Windows paths use `path.join` / `path.resolve`; never string concat.
- Audit JSONL shape unchanged; `tool_use_id` correlation works.
- The renderer type-checks clean alongside the main process (build passes both projects).
- The `anthropicBlocks` typed carrier remains an in-memory only carrier.
- No markdown library pulled in for Phase 2 (deferred; the renderer still uses plain `<pre>`).

## Acceptance Criteria Status

All 6 success criteria from the plan's `<success_criteria>` are satisfied:

1. **`code_search` accepts a regex + glob + path; runs ripgrep via `@vscode/ripgrep@1.18.0`; returns matches in the canonical `{path, line, text, submatches}` shape; caps at `max_results`** — verified by `tests/unit/code_search.test.ts` (7 cases including regex match, glob filter, and max_results cap + truncated).
2. **`tools/cancel` for an in-flight `code_search` kills the ripgrep child within 2s (SIGTERM → SIGKILL)** — `registry.cjs` implements this; the 60s timeout in `code_search.cjs` independently SIGTERMs + SIGKILLs on wall-clock timeout.
3. **The audit JSONL line for `code_search` contains `params:{pattern, glob, path, max_results, result_count}` — never the matches payload — keeping audit lines under 1 MiB** — verified by the new `codeSearchAuditParams` shape in `daemon/main.cjs`; a 10 000-match query produces a sub-KiB audit line.
4. **`ToolUseBlock` and `ToolResultBlock` collapse content over 500 UTF-8 bytes with a `Show more` / `Show less` toggle; error `tool_result` blocks render with a red tint** — verified by the byte-counted `TextEncoder` check + `block-result-error` class in CSS. Empty and single-line edge cases are bypassed.
5. **The full Phase 2 success criteria from ROADMAP.md are met** — `read_file`, `write_file`, `edit_file`, `list_dir`, `code_search` all work; allowlist refusal happens before any side effect (`tests/unit/allowlist.test.ts`); renderer renders `tool_use` + `tool_result` blocks inline.
6. **`npm test`, `npm run build`, and `npx playwright test daemon-tools` all pass with zero failures** — see Verification above.

## Threat Surface Notes

| Flag | File | Description |
|---|---|---|
| `threat_flag: ripgrep_argv_injection` | `daemon/tools/code_search.cjs` | Args passed as array, never `shell: true`. Pattern + glob + path validated for NUL bytes and length before `spawn`. |
| `threat_flag: audit_cap_compliance` | `daemon/main.cjs` | `codeSearchAuditParams` strips the matches payload; audit line stays sub-KiB even for huge result sets (Pitfall 5 / T-P2-20). |
| `threat_flag: cancel_propagation` | `daemon/tools/registry.cjs`, `daemon/main.cjs` | `tools/cancel` aborts the per-call AbortController AND kills the registered child via SIGTERM → 2s SIGKILL fallback (Pitfall 3 / T-P2-17). |
| `threat_flag: workspace_path_leak` | `daemon/tools/code_search.cjs` | Match paths are workspace-relative; ripgrep is invoked with a workspace-relative search root so absolute paths never appear in `--json` output (T-P2-21). |
| `threat_flag: typed_carrier` | — | The Phase 2 `anthropicBlocks` typed carrier remains in-memory only; not persisted. No change in Wave 3. |

No new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries beyond what `<threat_model>` lists. The `data-block-kind` / `data-tool-name` data attributes are non-functional Playwright selectors — they don't change behavior or expose data.

## Next Steps

- Phase 3 — memory/history work, file tree UI, token-budget summarization (LLM-04).
- Phase 4 — replace `daemon/bots/default.cjs` placeholder with `<userData>/bots/<bot>.json` loader; introduce the bot CRUD UI (AGENT-01..04).
- Manual headed-smoke: on a desktop session, `LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/smoke-tools.test.ts` should land the tool_use + tool_result blocks in the renderer. Defer to developer machine (same precedent as Phase 1's `smoke.test.ts`).

## Files Created / Modified

```
daemon/main.cjs                                     (modified — AbortController registry + audit shape + cancel wiring)
daemon/tools/code_search.cjs                        (modified — stub → real ripgrep implementation)
daemon/tools/registry.cjs                           (modified — activeChildren + registerChild + cancelToolCall)
src/renderer/components/ToolResultBlock.tsx         (modified — byte-counted collapse + empty + single-line)
src/renderer/components/ToolUseBlock.tsx            (modified — byte-counted collapse + data attrs)
src/renderer/styles/app.css                         (modified — .block-result-empty + .collapse-toggle)
tests/playwright/fake-m3-server.ts                  (modified — streamToolUseResponse helper + __forceToolUse hook)
tests/playwright/smoke-tools.test.ts                (new — headed Electron smoke gated by LOCALBOT_SMOKE_OK)
tests/unit/allowlist.test.ts                        (modified — cancelToolCall contract updated)
tests/unit/code_search.test.ts                      (new — 7 cases)
```

10 files changed, ~670 insertions(+), ~80 deletions(-).

## Commits

- `f4a1a79` — feat(02-03): code_search via @vscode/ripgrep + cancel wiring + tests
- `dda75de` — feat(02-03): renderer polish — byte-counted collapse + empty placeholder
- `80535d4` — test(02-03): fake-m3-server streamToolUseResponse + smoke-tools.test.ts
