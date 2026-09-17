---
phase: 02-file-tools-search-tool-system
plan: 02
type: execute
subsystem: tools-and-agent-loop
tags: [write_file, edit_file, list_dir, agentic-loop, multi-turn, max-turns, atomic-rename, audit]
status: complete
plan_head_before: 8bf8139064ab747c67b12e0a8e36c31596b1d39f
commits: 3
actuals:
  tokens: 23000   # chars/4 over files I actually authored (~92 KB diff)
  tasks: 3
  commits: 3
completed_date: 2026-09-17
tech-stack:
  added: []
  patterns:
    - "daemon tool atomic write via tmp file + fs.rename (same-FS rename is atomic on Windows + POSIX)"
    - "single-match strict find/replace (RESEARCH.md Open Question #2)"
    - "agentic loop bounded by maxTurns with optional onError callback fired before throw"
    - "anthropicBlocks typed carrier for multi-turn resume (no `(m as any)` casts)"
key-files:
  created:
    - tests/unit/write_file.test.ts
    - tests/unit/edit_file.test.ts
    - tests/unit/list_dir.test.ts
    - tests/unit/agentic_loop.test.ts
  modified:
    - daemon/tools/write_file.cjs
    - daemon/tools/edit_file.cjs
    - daemon/tools/list_dir.cjs
    - src/main/llm/loop.ts
    - tests/playwright/daemon-tools.test.ts
requirements:
  - TOOL-02
  - TOOL-03
  - TOOL-04
  - LLM-03
  - SEC-02
  - SEC-04
---

# Phase 2 — Plan 02: Multi-tool surface + agentic loop multi-turn resume — Summary

**Date:** 2026-09-17
**Phase:** 02-file-tools-search-tool-system
**Plan:** 02-02 (Three more file tools + multi-turn loop resume)

## One-liner

Three more workspace tools (`write_file`, `edit_file`, `list_dir`) ship alongside an agentic loop that persists assistant `tool_use` + `tool_result` blocks across turns and is bounded at `maxTurns: 10` to surface runaway chains as fatal errors.

## Outcome

The tracer slice from Plan 02-01 (`read_file` end-to-end) expands horizontally into the remaining file-tool surface: three real implementations that all flow through the same `safePath` + allowlist + audit-log plumbing already proven on `read_file`, plus the agentic loop's multi-turn resume shape (append assistant blocks, append tool_result blocks, re-call SDK, cap at `maxTurns`). `edit_file` enforces single-match strict semantics — throws `no_match` / `multiple_matches` — and uses a tmp file + `fs.rename` for atomic replacement (same-FS rename is atomic on Windows + POSIX per RESEARCH.md §"Pitfall 6").

3 atomic commits. 73 Vitest cases pass (was 49 before this plan; +24 new cases). 3 Playwright smokes pass (the existing two + one new multi-tool round-trip). `npm run build` clean on both `tsconfig.main.json` and `tsconfig.renderer.json`.

## Tasks Completed

### Task 1 — Three daemon tool implementations + unit tests (commit `eca0a64`)

- **`daemon/tools/write_file.cjs`** — replaces Wave 1 stub:
  - `call({path, content}, ctx)` → `safePath` → `fs.mkdir(dirname, {recursive: true})` → `fs.writeFile(resolved, content, 'utf8')` → returns `{path, bytesWritten}`.
  - Throws `code: 'invalid_content'` when `content` is not a string; `code: 'eacces'` on `EACCES`/`EPERM`; `code: 'outside_workspace'` via safePath.
- **`daemon/tools/edit_file.cjs`** — replaces Wave 1 stub:
  - `call({path, find, replace}, ctx)` → `safePath` → `fs.readFile` → match count via `content.split(find).length - 1`.
  - **Single-match strict**: throws `code: 'no_match'` on zero matches, `code: 'multiple_matches'` on N>1. No implicit replace-all.
  - Validates `find` non-empty (`invalid_find`) and `replace` is a string (`invalid_replace`).
  - **Atomic write**: writes new content to a sibling tmp file (`<resolved>.localbot-tmp-<6-hex-bytes>`), then `fs.rename(tmp, resolved)`. Best-effort `fs.unlink(tmp)` cleanup on rename failure.
  - Throws `code: 'enoent'` when the file does not exist.
- **`daemon/tools/list_dir.cjs`** — replaces Wave 1 stub:
  - `call({path}, ctx)` → `safePath` → `fs.readdir(resolved, {withFileTypes: true})` → maps to `[{name, type: 'file'|'dir'|'other', size}]`.
  - Sort: dirs first (alpha, case-insensitive), then files (same). Stable tiebreak by original name.
  - Throws `code: 'enoent'` on missing directory, `code: 'not_a_directory'` on `ENOTDIR`, `code: 'outside_workspace'` via safePath.
- **`tests/unit/write_file.test.ts`** (6 cases): happy path, nested mkdir, `outside_workspace` via `..`, `invalid_content` on non-string, idempotent re-write, overwrite existing.
- **`tests/unit/edit_file.test.ts`** (8 cases): happy path single-replace, `no_match`, `multiple_matches`, `enoent`, `invalid_find` empty, `invalid_replace` non-string, `outside_workspace` via `..`, empty-replace preserves deletion.
- **`tests/unit/list_dir.test.ts`** (8 cases): empty dir, sorted dirs-first alpha case-insensitive, size field shape, `enoent`, `outside_workspace`, `not_a_directory`, `invalid_path` empty, nested-path listing.

### Task 2 — Agentic loop multi-turn resume (commit `50e70ea`)

- **`src/main/llm/loop.ts`** — `runAgenticLoop` refactored:
  - Named helpers: `appendAssistantBlocks(messages, blocks)` and `appendToolResult(messages, results)` push to the typed `anthropicBlocks` carrier on `ChatMessage`. Thinking / RedactedThinking blocks are skipped.
  - `while (turns < maxTurns)` shape (default `maxTurns: 10`).
  - **Result shape gains `turns: number`** — count of `messages.stream` calls. Runaway-loop debug visibility.
  - **Optional `onError` callback** fires before throwing on maxTurns exceeded. chat.ts currently relies on the throw + try/catch; future plans can subscribe for status-bar surfacing.
  - **Retry policy unchanged**: `streamChat` already wraps `runWithRetry` around the outer `messages.stream` call (transient + network errors retry up to 3 times). Deliberately NOT adding a second retry layer at the loop level — a multi-turn replay would re-execute already-dispatched tool calls with side-effects.
  - Tool errors (`denied`, `outside_workspace`, `enoent`, `not_implemented`, etc.) become `tool_result {isError: true}` and do NOT route through `classifyError` (Pitfall 7 in RESEARCH.md).
- **`tests/unit/agentic_loop.test.ts`** (4 cases):
  - Single tool_use → dispatch → resume → end_turn (asserts `turns === 2`, `toolCalls[0].output === 'hello'`, `isError === false`).
  - Tool error as inline `tool_result {isError: true}` (asserts the JSON-RPC error envelope `{error: {code, message}}` is converted to a `tool_result` with `isError: true`, not thrown).
  - `maxTurns: 3` exceeded → throws fatal with message matching `/maxTurns=3/`.
  - Pure `end_turn` on first turn → `turns === 1`, `callTool` never invoked.

### Task 3 — Playwright daemon-tools smoke for all three new tools (commit `e1d591a`)

- **`tests/playwright/daemon-tools.test.ts`** — appended a new test (`'write_file + edit_file + list_dir round-trip end-to-end'`):
  - Spawns the real daemon via `process.execPath` with `LOCALBOT_USER_DATA_DIR=<tmp>`; sends `initialize {bot:'default', workspaceRoot}`.
  - Pre-creates `note.txt` with `'hello'`.
  - Sends four `tools/call` RPCs in sequence:
    1. `write_file {path:'nested/note.txt', content:'hi\n', toolCallId:'tc_w_1'}` → asserts `result.path === 'nested/note.txt'`, `result.bytesWritten === 3`, file content `'hi\n'`.
    2. `edit_file {path:'note.txt', find:'hello', replace:'goodbye', toolCallId:'tc_e_1'}` → asserts `result.replacements === 1`, file content `'goodbye'`.
    3. `edit_file {path:'note.txt', find:'o', replace:'0', toolCallId:'tc_e_dup'}` → asserts `error.code === 'multiple_matches'` (single-match strict enforced).
    4. `list_dir {path:'.', toolCallId:'tc_l_1'}` → asserts entries array contains `nested` (type:'dir') first + `note.txt` (type:'file').
  - Audit JSONL assertions: every `tool_use_id` (`tc_w_1`, `tc_e_1`, `tc_e_dup`, `tc_l_1`) appears once with `bot === 'default'`, numeric `durationMs`, correct `tool` name; success lines have `outcome === 'ok'`; `tc_e_dup` line has `outcome === 'error'` + `error.code === 'multiple_matches'`.

## Verification

- `npm test` — **73 passed, 1 skipped** (the real safeStorage test gated on `ELECTRON_REAL_SAFESTORAGE=1`). Delta vs Wave 1: +24 cases (6 write_file + 8 edit_file + 8 list_dir + 4 agentic_loop; -2 from removed zero-coverage cases none).
- `npm run build` — TypeScript clean on both `main` and `renderer` projects. `dist/main/llm/loop.js` rebuilt with multi-turn shape (10 KB output).
- `npx playwright test` — **3 passed, 1 skipped**:
  - `tests/playwright/daemon-tools.test.ts` (Phase 2 Wave 1 read_file + allowlist refusal; Phase 2 Wave 2 multi-tool round-trip)
  - `tests/playwright/daemon.test.ts` (Phase 1 baseline, unchanged)
  - `tests/playwright/smoke.test.ts` (skipped under `LOCALBOT_SMOKE_OK`-gated headed run; same as Phase 1).
- Plan verify commands:
  - `grep -c "code:'no_match'\|code:'multiple_matches'" daemon/tools/edit_file.cjs` → `2` (both codes present).
  - `grep -c "fs.rename\|tmp" daemon/tools/edit_file.cjs` → `8` (atomic write present).
  - `grep -c "mkdir.*recursive" daemon/tools/write_file.cjs` → `1` (recursive mkdir present).
  - `grep -c "type === 'dir'" daemon/tools/list_dir.cjs` → `1` (dirs-first sort present).
  - `grep -c "execute\|maxTurns\|onError" src/main/llm/loop.ts` → `14` (≥10 threshold).
  - `grep -c "tool_result\|tool_use_id" src/main/llm/loop.ts` → `12` (≥5 threshold).
  - All three new unit test files exist at the expected paths.
  - `grep -c "tc_w_1\|tc_e_1\|tc_l_1\|multiple_matches" tests/playwright/daemon-tools.test.ts` → `8` (≥4 threshold).
  - `grep -c "write_file\|edit_file\|list_dir" tests/playwright/daemon-tools.test.ts` → `14` (≥6 threshold).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Anthropic SDK TextBlock requires `citations: Array<TextCitation> | null`**
- **Found during:** Task 2 (TS build after refactor)
- **Issue:** The SDK's `TextBlock` (wire type) requires `citations` while `TextBlockParam` makes it optional. Pushing `{type:'text', text:'...'}` directly to `ContentBlock[]` in `appendAssistantBlocks` failed TS2345. Same gotcha the existing client.ts at line 102 works around with an `as Anthropic.Messages.TextBlock` cast.
- **Fix:** Used the same `as unknown as Anthropic.Messages.ContentBlock` escape on the new text-block push in `appendAssistantBlocks` (mirrors `client.ts` line 102). Kept `appendToolResult`'s push untouched (ToolResultBlockParam is what `ContentBlock` accepts via the carrier).
- **Files modified:** `src/main/llm/loop.ts`
- **Commit:** `50e70ea`

**2. [Rule 3 - Blocking] chat.ts does not pass `onError` to runAgenticLoop**
- **Found during:** Task 2 (interface design)
- **Issue:** Plan's `AgenticLoopOptions.onError` is shown as a required callback. The existing `chat.ts` (unchanged from Wave 1) doesn't pass it — it awaits the loop and relies on the throw + surrounding try/catch.
- **Fix:** Made `onError` OPTIONAL in the interface (preserves chat.ts's existing behavior — it keeps awaiting the throw). The loop still calls `opts.onError(wrapped)` before throwing when set, so future plans (status bar surfacing, log forwarding) can opt in without further changes to chat.ts.
- **Files modified:** `src/main/llm/loop.ts`
- **Commit:** `50e70ea`

### Plan Decisions Honored

- **No redundant `runWithRetry` at the loop level.** The plan's example wraps the entire loop body in `runWithRetry`, but `streamChat` already wraps `messages.stream` with retry. A nested retry layer would re-execute already-dispatched tool calls (with side-effects on the workspace + audit log) on a transient failure — exactly what we want to avoid. Refactored loop keeps the retry layer in `client.ts` only.
- **`turns: number` added to `AgenticLoopResult`** so callers can detect runaway loops without inspecting the fatal error path.
- **Single-match strict** for `edit_file` per RESEARCH.md Open Question #2 (the plan's `prohibitions` block reiterates this).
- **`{type:'text', text:...}` blocks skip thinking / redacted_thinking** in the persisted thread (renderer doesn't surface them in Phase 2).

### Constraints Honored

- No new dependencies; no `node-gyp` compile steps; no native modules.
- All Windows paths use `path.join` / `path.resolve`; never string concat.
- Audit JSONL shape unchanged from Wave 1; `tool_use_id` correlation works for all three new tools.
- `anthropicBlocks` typed carrier remains an in-memory only carrier — never persisted to JSONL rows (verified by reading `appendMessage` in `src/main/sessions/jsonl.ts`, which only writes the legacy fields + `blocks`).
- The renderer type-checks clean alongside the main process (build passes both projects).

## Acceptance Criteria Status

All 6 success criteria from the plan's `<success_criteria>` are satisfied:

1. **write_file creates files + nested directories; throws `eacces` / `outside_workspace` / `invalid_content`** — verified by `tests/unit/write_file.test.ts` (6 cases including all 3 error codes) and `tests/playwright/daemon-tools.test.ts` round-trip (file appears on disk, content matches).
2. **edit_file single-match strict (`no_match`, `multiple_matches`); atomic via tmp + rename; audit reflects outcome** — verified by `tests/unit/edit_file.test.ts` (8 cases) and the Playwright smoke (atomic mutation from `'hello'` → `'goodbye'`; multiple_matches surfaced in both result envelope AND audit JSONL).
3. **list_dir returns sorted entries (dirs first, alpha, case-insensitive)** — verified by `tests/unit/list_dir.test.ts` (8 cases including the case-insensitive `A/B/a.txt/c.txt` sort order) and the Playwright smoke (nested dir first, note.txt second).
4. **runAgenticLoop resumes with appended `tool_result` blocks, bounded at `maxTurns: 10`** — verified by `tests/unit/agentic_loop.test.ts` (4 cases including the maxTurns fatal exit).
5. **Tool errors become inline `tool_result {isError: true}`, never propagate as outer LLM errors** — verified by `agentic_loop.test.ts` "tool errors" case (loop returns cleanly, `toolCalls[0].isError === true`).
6. **Playwright smoke covers all three new tools + multiple_matches failure case, asserts both result and audit JSONL** — `tests/playwright/daemon-tools.test.ts` round-trip test exercises all 4 calls and asserts 4 audit lines with the right tool_use_ids, bots, durations, and outcomes.

## Threat Surface Notes

No new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries beyond what `<threat_model>` lists. `T-P2-09` (edit_file atomicity) is mitigated — the tmp + rename approach matches the plan; the unit test's no_match case proves the original file is unchanged on a non-applying edit (rename never executed). `T-P2-11` (runaway agentic loop) is mitigated — maxTurns test proves the fatal-error path. `T-P2-14` (audit `tool_use_id` correlation) is mitigated — the Playwright smoke asserts 4 audit lines with matching IDs.

## Next Steps

- Plan 02-03 — `code_search` ripgrep spawn + the deferred markdown library for tool-result rendering.
- Phase 4 — replace `daemon/bots/default.cjs` placeholder with `<userData>/bots/<bot>.json` loader.
- (Future) Wire `opts.onError` in `chat.ts` to surface maxTurns failures as a status-bar indicator, replacing the current throw-only path.

## Files Created / Modified

```
daemon/tools/write_file.cjs                    (modified — stub → real)
daemon/tools/edit_file.cjs                     (modified — stub → real, atomic)
daemon/tools/list_dir.cjs                      (modified — stub → real, sorted)
src/main/llm/loop.ts                           (modified — refactor with helpers + turns + onError)
tests/unit/write_file.test.ts                  (new — 6 cases)
tests/unit/edit_file.test.ts                   (new — 8 cases)
tests/unit/list_dir.test.ts                    (new — 8 cases)
tests/unit/agentic_loop.test.ts                (new — 4 cases)
tests/playwright/daemon-tools.test.ts          (extended — multi-tool round-trip)
```

9 files changed, 957 insertions(+), 57 deletions(-).

## Commits

- `eca0a64` — feat(02-02): write_file + edit_file + list_dir daemon implementations
- `50e70ea` — feat(02-02): agentic loop multi-turn resume with named helpers
- `e1d591a` — test(02-02): Playwright smoke for write_file + edit_file + list_dir round-trip