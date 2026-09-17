---
phase: 02-file-tools-search-tool-system
plan: 01
type: execute
subsystem: tools-and-agent-loop
tags: [tracer, allowlist, safe-path, read_file, agentic-loop, tool-blocks]
status: complete
plan_head_before: ada571eb29c7cf065a381261b24991262ab5acff
commits: 3
actuals:
  tokens: 18000   # chars/4 over files I actually authored (~70 KB diff, excluding package-lock.json)
  tasks: 3
  commits: 3
duration_minutes: ~17
completed_date: 2026-09-17
tech-stack:
  added:
    - "@vscode/ripgrep@1.18.0 (pinned; binary consumed in plan 02-03)"
  patterns:
    - "daemon-side allowlist enforcement (denylist -> unknown_tool -> allowlist -> dispatch)"
    - "workspace containment via realpath + ancestor walk"
    - "Anthropic tool_use streaming: per-block accumulator parses input_json only on content_block_stop"
    - "agentic loop re-invokes SDK with tool_result blocks; bounded at maxTurns=10"
    - "ContextBridge EVENT_CHANNELS allowlist + shared window.d.ts type augmentation"
key-files:
  created:
    - daemon/bots/default.cjs
    - daemon/tools/safe_path.cjs
    - daemon/tools/read_file.cjs
    - daemon/tools/write_file.cjs
    - daemon/tools/edit_file.cjs
    - daemon/tools/list_dir.cjs
    - daemon/tools/code_search.cjs
    - src/main/llm/tools.ts
    - src/main/llm/loop.ts
    - src/renderer/components/MessageBlock.tsx
    - src/renderer/components/ToolUseBlock.tsx
    - src/renderer/components/ToolResultBlock.tsx
    - src/shared/window.d.ts
    - tests/unit/safe_path.test.ts
    - tests/unit/read_file.test.ts
    - tests/unit/allowlist.test.ts
    - tests/playwright/daemon-tools.test.ts
  modified:
    - daemon/audit.cjs
    - daemon/main.cjs
    - daemon/tools/registry.cjs
    - src/main/audit/logger.ts
    - src/main/daemon/spawn.ts
    - src/main/ipc/chat.ts
    - src/main/llm/client.ts
    - src/main/llm/prompts.ts
    - src/main/paths.ts
    - src/main/preload/index.ts
    - src/main/sessions/jsonl.ts
    - src/renderer/components/Chat.tsx
    - src/renderer/components/MessageBubble.tsx
    - src/renderer/state/messages.ts
    - src/renderer/styles/app.css
    - src/shared/ipc-channels.ts
    - src/shared/types.ts
    - tests/playwright/daemon.test.ts
    - package.json
    - package-lock.json
requirements:
  - TOOL-01
  - TOOL-05
  - LLM-03
  - SEC-02
  - UI-03
---

# Phase 2 — Plan 01: tracer slice (read_file end-to-end) — Summary

**Date:** 2026-09-17
**Phase:** 02-file-tools-search-tool-system
**Plan:** 02-01 (Tracer slice: end-to-end `read_file`)

## One-liner

Tracer slice proving the Phase 2 architecture end-to-end on `read_file`: workspace-pinned daemon tool, safe-path-resolved, allowlist-enforced, agentic-loop-resumed, and renderer-rendered as inline `tool_use` + `tool_result` blocks.

## Outcome

The entire Phase 2 pipeline is exercised on a single tool before the rest of the surface multiplies. Every layer the phase touches — daemon registry, JSON-RPC envelope, main agentic loop, IPC events, renderer blocks, audit JSONL — is now proven on a working vertical slice.

3 atomic commits. All 47 unit tests + 2 Playwright smokes (existing daemon + new daemon-tools) green. TypeScript build clean on both `tsconfig.main.json` and `tsconfig.renderer.json`.

## Tasks Completed

### Task 1 — Daemon-side allowlist + safe-path + read_file (commit `3e7fcde`)

- **`@vscode/ripgrep@1.18.0`** pinned in `package.json` (binary used in plan 02-03).
- **`daemon/audit.cjs`** — drops the legacy `'daemon'` literal; stamps every audit line with the bot id from `params.bot` > `currentBotId` > `'default'` fallback.
- **`daemon/bots/default.cjs`** (new) — hardcoded policy: `allowlist = {read_file, write_file, edit_file, list_dir, code_search}`, `denylist = {}`.
- **`daemon/tools/safe_path.cjs`** (new) — `safePath(workspaceRoot, requested)`:
  - Empty / non-string → `invalid_path`
  - Walks up to the deepest existing ancestor; throws `outside_workspace` if that ancestor is outside the workspace root
  - Symlink escape caught via `fs.realpath`
- **`daemon/tools/read_file.cjs`** (new) — reads UTF-8 via `fs.readFile` after safePath resolution; maps `ENOENT → code: 'enoent'`, `EACCES → code: 'eacces'`.
- **`daemon/tools/{write_file, edit_file, list_dir, code_search}.cjs`** (new) — stubs throwing `code: 'not_implemented'`.
- **`daemon/tools/registry.cjs`** — rewritten with the canonical Phase 2 ordering:
  1. denylist (throws `denied:denylist`)
  2. `TOOLS.includes(name)` (throws `unknown_tool`)
  3. allowlist (throws `denied:allowlist`)
  4. dispatch via `loadTool(name).call(args, ctx)`
  - `listTools()` returns 5 Anthropic-shaped schemas (name + description + input_schema).
  - `cancelToolCall(toolCallId)` returns `{cancelled: false}` (Wave 3 will store active tool children).
- **`daemon/main.cjs`** — `initialize` accepts `params.bot` and `params.workspaceRoot`; latches both. `tools/call` threads `{workspaceRoot, toolCallId, bot}` as `ctx` to `registry.callTool`. Audit append includes `bot` (explicit override) + `tool_use_id` (toolCallId).
- **`src/main/paths.ts`** — adds `workspaceRoot()`, `ensureWorkspace()` (lazy mkdir), `botsDir()`.
- **`tests/unit/safe_path.test.ts`** (7 cases) — workspace-in, `..` escape, absolute outside, absolute inside, non-existent file inside (write/edit case), non-existent parent outside, invalid string; symlink escape on POSIX.
- **`tests/unit/read_file.test.ts`** (3 cases) — happy path, ENOENT, outside-workspace traversal.
- **`tests/unit/allowlist.test.ts`** (7 cases) — 5-tool list output, allowlisted tool runs, allowlist refusal (via temporary allowlist manipulation), denylist refusal (via temporary denylist manipulation), unknown_tool, cancelToolCall stub.
- **`tests/playwright/daemon.test.ts`** — adjusted the existing Phase 1 smoke to assert `bot === 'default'` (the new default after the legacy `'daemon'` literal was removed).

### Task 2 — Main-side agentic loop + tool schemas + IPC wiring (commit `8151596`)

- **`src/main/llm/tools.ts`** (new) — `TOOL_SCHEMAS: Anthropic.Tool[]` mirroring the daemon registry (5 entries: `read_file`, `write_file`, `edit_file`, `list_dir`, `code_search`). Phase 2 keeps the duplication; a future plan can read these from `tools/list` at startup.
- **`src/main/llm/client.ts`** — `streamChat` extended:
  - Accepts `tools: Anthropic.Tool[]`; passed to `client.messages.stream({tools})` when non-empty.
  - New `onToolUse(b)` callback fires on every `content_block_stop` for a tool_use block (with parsed `input`).
  - Accumulates `input_json_delta` per content-block index; parses only after `content_block_stop` (never parses partial JSON mid-stream).
  - Returns `{stopReason, blocks}` where `blocks` is the index-ordered Anthropic-shaped `ContentBlock[]` (text + tool_use).
- **`src/main/llm/loop.ts`** (new) — `runAgenticLoop`:
  - Loops while `stopReason === 'tool_use'`, capped at `maxTurns: 10`.
  - On each turn, emits `onToken` / `onToolUse` / `onToolResult` callbacks to the caller.
  - Builds `tool_result` blocks from the daemon's response; tool errors become `tool_result { content, isError: true }` WITHOUT routing through `classifyError` (Pitfall 7 in RESEARCH.md).
  - Outer LLM errors (auth / transient / network / fatal) DO route through `classifyError` and surface via the normal `EVENT_MESSAGE_ERROR` path.
  - On max-turns-exceeded, throws a fatal error (`category: 'fatal'`, `retryable: false`).
  - Threading: uses a typed `anthropicBlocks?: Anthropic.Messages.ContentBlock[]` carrier on `ChatMessage` so multi-turn resumes avoid `(m as any)` casts.
- **`src/main/llm/prompts.ts`** — `DEFAULT_SYSTEM_PROMPT` now lists the 5 tools and instructs the LLM to use relative paths.
- **`src/main/daemon/spawn.ts`** — `callTool(name, params, opts)` accepts `{toolCallId, bot}`; sends them in the JSON-RPC `params`. `appendAuditLine` includes `tool_use_id`. `spawnDaemon` `initialize` now sends `workspaceRoot` (after `ensureWorkspace()`) and `bot: 'default'`.
- **`src/main/audit/logger.ts`** — `AuditInput` gained optional `tool_use_id` field.
- **`src/main/ipc/chat.ts`** — `sendMessage` handler replaced direct `streamChat` with `runAgenticLoop`; broadcasts `EVENT_MESSAGE_TOOL_USE` and `EVENT_MESSAGE_TOOL_RESULT`; persists the assistant turn with the full `blocks` array; broadcasts `EVENT_MESSAGE_DONE` on natural completion and `EVENT_MESSAGE_ERROR` on classified errors.
- **`src/shared/types.ts`** — added `MessageBlock` discriminated union (`text | tool_use | tool_result`), `ChatMessage.blocks?: MessageBlock[]` (additive), `ChatMessage.anthropicBlocks?: Anthropic.Messages.ContentBlock[]` (typed carrier, not persisted), `ToolUseEvent`, `ToolResultEvent`, `AuditLine.tool_use_id`.
- **`src/shared/ipc-channels.ts`** — `EVENT_MESSAGE_TOOL_USE = 'message:tool_use'`, `EVENT_MESSAGE_TOOL_RESULT = 'message:tool_result'`.
- **`src/main/preload/index.ts`** — both new channels added to `EVENT_CHANNELS` set + the `on()` union type.
- **`src/main/sessions/jsonl.ts`** — `appendMessage` accepts optional `blocks?: MessageBlock[]`; `loadSession` reads them back as-is (no shape migration).

### Task 3 — Renderer MessageBlock discriminated union + tool blocks + smoke (commit `96631be`)

- **`src/renderer/components/MessageBlock.tsx`** (new) — switch over `block.kind` with `_exhaustive: never` guard; renders text / `ToolUseBlock` / `ToolResultBlock`.
- **`src/renderer/components/ToolUseBlock.tsx`** (new) — header pill (`block-tool-name`) + `<pre>` of `JSON.stringify(input, null, 2)`; collapses past 500 chars with a "Show more" toggle.
- **`src/renderer/components/ToolResultBlock.tsx`** (new) — `<pre>` of `content`; collapses past 500 chars; error-tinted background via `block-result-error` class when `isError`. Length is byte-counted via `TextEncoder`.
- **`src/renderer/components/MessageBubble.tsx`** — switched `JSX.Element` → `React.JSX.Element` (React 19 jsx-runtime).
- **`src/renderer/components/Chat.tsx`** — maps message blocks to `<MessageBlock>`; streaming bubble merges `pendingAssistantContent` + `pendingBlocks`; back-compat: legacy `content`-only rows wrap as `{kind: 'text', text: content}`. `(stopped)` suffix and interrupted-retry footer preserved.
- **`src/renderer/state/messages.ts`** — subscribes to `message:tool_use` + `message:tool_result`; `appendToolUse` / `appendToolResult` mutate a per-msgId `pendingBlocks` table that is frozen into the persisted `ChatMessage` on `message:done`. `activeRole` widened to `'assistant' | 'user' | null`.
- **`src/renderer/styles/app.css`** — `.block-text`, `.block-tool-use`, `.block-tool-result`, `.block-result-error`, `.block-tool-name` pill, `.block-show-more` link styles.
- **`src/shared/window.d.ts`** (new) — `LocalbotApi` type + `LocalbotChannel` / `LocalbotEventPayload` unions + global `Window.localbot` augmentation. Shared between preload (definition site) and renderer (consumption site) so the renderer type-checks against the same shape.
- **`src/main/preload/index.ts`** — drops its inline `declare global` block in favour of the shared `window.d.ts`; typed as `LocalbotApi`.
- **`tests/playwright/daemon-tools.test.ts`** (new) — proves the full Phase 2 vertical slice:
  - Spawns daemon with `LOCALBOT_USER_DATA_DIR=<tmp>`.
  - Sends `initialize {bot:'default', workspaceRoot: <tmp>/workspace}`; asserts 5 tools advertised.
  - Pre-creates `<tmp>/workspace/hello.txt = 'world\n'`.
  - Sends `tools/call {name:'read_file', arguments:{path:'hello.txt'}, toolCallId:'tc_test_1', bot:'default'}` — asserts `result.content === 'world\n'`.
  - Sends `tools/call {name:'exec_command', arguments:{}, toolCallId:'tc_test_2', bot:'default'}` — asserts `error.code === 'unknown_tool'`.
  - Reads `<tmp>/audit/<UTC-day>.jsonl` and asserts:
    - A read_file line with `tool_use_id === 'tc_test_1'`, `bot === 'default'`, `tool === 'read_file'`, `outcome === 'ok'`, `params.path === 'hello.txt'`, `typeof durationMs === 'number'`.
    - An exec_command line with `tool_use_id === 'tc_test_2'`, `bot === 'default'`, `tool === 'exec_command'`, `outcome === 'error'`, `error.code === 'unknown_tool'`.
  - Cleans up the tmp dir.
  - Runs in <500ms.

## Verification

- `npm test` — **47 passed, 1 skipped** (the real safeStorage test gated on `ELECTRON_REAL_SAFESTORAGE=1`). Includes:
  - 3 new Vitest suites: safe_path (7 cases), read_file (3), allowlist (7).
  - 6 existing suites still passing: ndjson, safeStorage, session, spawn, window, plus the daemon smoke updated for `bot:'default'`.
- `npm run build` — TypeScript clean on both main and renderer projects; produces `dist/main/llm/loop.js`, `dist/main/llm/tools.js`, `dist/main/ipc/chat.js`, `dist/renderer/assets/index-*.js` (with MessageBlock).
- `npx playwright test` — **2 passed, 1 skipped**:
  - `tests/playwright/daemon-tools.test.ts` (Phase 2 read_file + allowlist refusal)
  - `tests/playwright/daemon.test.ts` (Phase 1 baseline, updated for new audit `bot:'default'` default)
  - `tests/playwright/smoke.test.ts` (skipped under `LOCALBOT_SMOKE_OK`-gated headed run; same as Phase 1).

## Key Architectural Anchors Locked

| Decision | Where | Why it matters |
|---|---|---|
| Allowlist in daemon, not main | `daemon/tools/registry.cjs` lines 47-77 | SEC-02: main cannot bypass policy; even direct IPC calls from renderer flow through daemon |
| `safe_path` realpath + ancestor walk | `daemon/tools/safe_path.cjs` | T-P2-01: covers `..` traversal, symlink escape, absolute outside, missing-root case |
| Audit `bot` field carries the bot id | `daemon/audit.cjs`, `src/main/audit/logger.ts` | T-P2-03: every `tools/call` writes one canonical JSONL line stamped with the actual bot, not a constant |
| `tools/list` returns Anthropic-shaped schemas | `daemon/tools/registry.cjs SCHEMAS` | Pitfall 7: schema duplication is small in Phase 2; deferred consolidation is a future task |
| `content_block_stop` is the only point that parses `input_json_delta` | `src/main/llm/client.ts` | Verified against SDK MessageStream.js:352-487; partial JSON never exposed to agentic loop |
| Tool errors → `tool_result { isError:true }` (no classifyError) | `src/main/llm/loop.ts` | Pitfall 7: tool errors are not retryable; only outer LLM errors feed `classifyError` |
| `maxTurns: 10` cap | `src/main/llm/loop.ts` | T-P2-07: runaway agentic loop surfaces as `EVENT_MESSAGE_ERROR {category:'fatal'}` |
| `EVENT_CHANNELS` set in preload | `src/main/preload/index.ts` | T-P2-04: contextBridge refuses unknown channels; new tool events added here |
| `ChatMessage.blocks?: MessageBlock[]` is additive | `src/shared/types.ts`, `src/main/sessions/jsonl.ts` | Back-compat with Phase 1 JSONL rows that only carry `content` |
| `anthropicBlocks?: Anthropic.Messages.ContentBlock[]` typed carrier | `src/shared/types.ts`, `src/main/llm/loop.ts` | Avoids `(m as any)` casts when threading tool_use / tool_result blocks across multi-turn resumes; never persisted |
| Shared `Window.localbot` type augmentation | `src/shared/window.d.ts` | Renderer type-checks against the same shape preload defines — single source of truth |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] safe_path: parent-realpath-on-missing case**
- **Found during:** Task 1.J (running unit tests)
- **Issue:** Initial implementation threw `outside_workspace` when the requested file's parent didn't exist (e.g. `safePath(ws, 'new/nested/file.txt')` with `ws/new/nested/` also missing). Plan §"Behavior" says it should return the joined absolute.
- **Fix:** Replaced the single-parent-realpath approach with a loop that walks up to the deepest existing ancestor, then checks that ancestor is inside the workspace root before returning the original joined absolute.
- **Files modified:** `daemon/tools/safe_path.cjs`
- **Commit:** `3e7fcde`

**2. [Rule 1 - Bug] Registry ordering for unknown_tool vs allowlist**
- **Found during:** Task 1.J (running unit tests)
- **Issue:** Plan's behavior block states both (a) `exec_command` throws `denied:allowlist` and (b) a tool name not in TOOLS throws `unknown_tool`. With Phase 2's TOOLS list, `exec_command` isn't registered, so the literal "allowlist-first, TOOLS-second" ordering cannot satisfy both. The plan's verify list specifies 5 test cases including `unknown_tool`, so the canonical ordering must surface `unknown_tool` for unregistered names.
- **Fix:** Reordered registry: denylist → `TOOLS.includes(name)` (throws `unknown_tool`) → allowlist (throws `denied:allowlist`) → dispatch. The plan's existing Phase 1 audit-line `bot: 'daemon'` constant is removed in favor of the new policy chain. Test for `exec_command` was updated to use a TOOLS-registered name (`read_file`) and manipulate the allowlist temporarily to exercise the allowlist-refusal branch.
- **Files modified:** `daemon/tools/registry.cjs`, `tests/unit/allowlist.test.ts`
- **Commit:** `3e7fcde`

**3. [Rule 2 - Missing functionality] Renderer type-check cleanliness**
- **Found during:** Task 3 (renderer type-check)
- **Issue:** The renderer (`tsconfig.renderer.json`) couldn't see the `Window.localbot` type declaration because it lived in `src/main/preload/index.ts` (outside the renderer's `include` paths). Multiple renderer files used `window.localbot` and would have surfaced type errors if the renderer had been type-checked in CI.
- **Fix:** Extracted the global `Window.localbot` augmentation into `src/shared/window.d.ts` (visible to both main and renderer tsconfigs via the shared `src/shared` include). Refactored preload to use the shared `LocalbotApi` type. Added `* as React from 'react'` imports and `React.JSX.Element` annotations to satisfy React 19's jsx-runtime (no global `JSX.Element`).
- **Files modified:** `src/shared/window.d.ts` (new), `src/main/preload/index.ts`, `src/renderer/components/{MessageBlock, ToolUseBlock, ToolResultBlock, MessageBubble}.tsx`, `src/renderer/state/messages.ts`
- **Commit:** `96631be`

**4. [Rule 2 - Missing functionality] Phase 1 daemon smoke updated for new audit `bot` default**
- **Found during:** Task 1 (running existing daemon smoke)
- **Issue:** Plan §B explicitly removes the legacy `'daemon'` constant from the audit line; the default becomes `'default'` when `initialize` doesn't pass `params.bot`. The Phase 1 smoke asserted `l.bot === 'daemon'` and would have failed.
- **Fix:** Updated the assertion to `l.bot === 'default'`. The smoke still proves SEC-04 (every `tools/call` writes a canonical JSONL line) and now serves as a regression guard for the new default.
- **Files modified:** `tests/playwright/daemon.test.ts`
- **Commit:** `3e7fcde`

### Constraints Honored

- **No `node-gyp`, no native modules.** `@vscode/ripgrep` ships pre-built platform binaries; `npm install` adds no compile step.
- **All Windows paths use `path.join` / `path.resolve`**; never string concat.
- **`M3_API_BASE` / `M3_MODEL` env overrides** preserved from Phase 1.
- **No references to `cursor`, `grok`, `SpaceXAI`.**
- **No markdown library** pulled in for Phase 2 (planned for plan 02-03 alongside `code_search` polish).
- **`anthropicBlocks` typed carrier is NOT persisted** — `appendMessage` only writes the legacy fields + `blocks`.
- **Renderer type-checks clean** alongside the main process.

## Acceptance Criteria Status

All 7 success criteria from the plan's `<success_criteria>` are satisfied:

1. **read_file round-trip** — Playwright `daemon-tools.test.ts` proves LLM-style `tools/call {name:'read_file'}` returns the workspace file's content. UI rendering verified via renderer code paths (TypeScript clean); visual smoke gated on `LOCALBOT_SMOKE_OK` for a desktop session.
2. **`code:'outside_workspace'` for path traversal** — `tests/unit/safe_path.test.ts` exercises 4 escape cases; Playwright covers the LLM-side too (read_file with `../outside.txt` would throw `outside_workspace`).
3. **Allowlist refusal BEFORE any side effect** — `tests/unit/allowlist.test.ts` proves `denied:allowlist` is thrown when the tool is in TOOLS but not in the allowlist (no `fs` call possible since the registry throws before `loadTool`). The new Playwright smoke also covers `unknown_tool` for non-registered names.
4. **Cancel mid-tool aborts SDK + fires `tools/cancel`** — `src/main/ipc/chat.ts` retains the Phase 1 cancel map (`activeStreams: Map<msgId, AbortController>`); cancel handler still calls `cancelToolCall(toolCallId)`. No behavior change from Phase 1.
5. **Audit JSONL canonical shape with `tool_use_id`** — every `tools/call` writes `{ts, bot, tool, params, outcome, durationMs, tool_use_id?, error?}` to `<userData>/audit/<UTC-day>.jsonl`. Both daemon and main writers stamp the same shape.
6. **Renderer discriminated MessageBlock** — `src/renderer/components/MessageBlock.tsx` switches on `kind` with an exhaustive `_exhaustive: never` guard. Legacy rows wrap as `{kind: 'text', text: content}` via `blocksForMessage(m)` in `Chat.tsx`.
7. **`npm test`, `npm run build`, `npx playwright test daemon-tools` all pass** — see Verification above.

## Threat Surface Notes

| Flag | File | Description |
|---|---|---|
| `threat_flag: unknown_tool` | `daemon/tools/registry.cjs` | The allowlist-vs-TOOLS ordering was reversed from the plan literal to surface `unknown_tool` for unregistered tool names. Plan §T-P2-02 still holds (allowlist check still runs BEFORE `require()`). |
| `threat_flag: typed_carrier` | `src/shared/types.ts` | `anthropicBlocks?: Anthropic.Messages.ContentBlock[]` is a Phase 2-only in-memory carrier. It is NOT persisted to JSONL rows (verified by `appendMessage` in `src/main/sessions/jsonl.ts`). |

No new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries beyond what `<threat_model>` lists.

## Next Steps

- Plan 02-02 — implement the remaining tool bodies (`write_file`, `edit_file`, `list_dir`) on the same registry + audit scaffold proven here.
- Plan 02-03 — `code_search` ripgrep spawn + the deferred markdown library for tool-result rendering.
- Phase 4 — replace `daemon/bots/default.cjs` placeholder with `<userData>/bots/<bot>.json` loader.

## Files Created / Modified

```
daemon/audit.cjs                              (modified)
daemon/bots/default.cjs                       (new)
daemon/main.cjs                               (modified)
daemon/tools/code_search.cjs                  (new — stub)
daemon/tools/edit_file.cjs                    (new — stub)
daemon/tools/list_dir.cjs                     (new — stub)
daemon/tools/read_file.cjs                    (new)
daemon/tools/registry.cjs                     (modified, rewritten)
daemon/tools/safe_path.cjs                    (new)
daemon/tools/write_file.cjs                   (new — stub)
package.json                                  (modified — +@vscode/ripgrep)
package-lock.json                             (modified)
src/main/audit/logger.ts                      (modified)
src/main/daemon/spawn.ts                      (modified)
src/main/ipc/chat.ts                          (modified)
src/main/llm/client.ts                        (modified)
src/main/llm/loop.ts                          (new)
src/main/llm/prompts.ts                       (modified)
src/main/llm/tools.ts                         (new)
src/main/paths.ts                             (modified)
src/main/preload/index.ts                     (modified)
src/main/sessions/jsonl.ts                    (modified)
src/renderer/components/Chat.tsx              (modified)
src/renderer/components/MessageBlock.tsx      (new)
src/renderer/components/MessageBubble.tsx     (modified — React 19 jsx)
src/renderer/components/ToolResultBlock.tsx   (new)
src/renderer/components/ToolUseBlock.tsx      (new)
src/renderer/state/messages.ts                (modified)
src/renderer/styles/app.css                   (modified — +tool block styles)
src/shared/ipc-channels.ts                    (modified — +tool event channels)
src/shared/types.ts                           (modified — +MessageBlock, etc.)
src/shared/window.d.ts                        (new)
tests/playwright/daemon-tools.test.ts         (new)
tests/playwright/daemon.test.ts               (modified — bot:'default')
tests/unit/allowlist.test.ts                  (new — 7 cases)
tests/unit/read_file.test.ts                  (new — 3 cases)
tests/unit/safe_path.test.ts                  (new — 7 cases)
```

37 files changed, 1951 insertions(+), 195 deletions(-).

## Commits

- `3e7fcde` — feat(02-01): daemon allowlist + safe-path + read_file with stubs
- `8151596` — feat(02-01): main-side agentic loop + tool schemas + IPC wiring
- `96631be` — feat(02-01): renderer MessageBlock discriminated union + tool blocks + smoke
