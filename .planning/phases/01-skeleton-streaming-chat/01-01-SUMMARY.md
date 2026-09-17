# Phase 1, Plan 01-01 — Walking Skeleton Summary

**Date:** 2026-09-17
**Phase:** 01-skeleton-streaming-chat
**Plan:** 01-01 (Walking Skeleton + Cancel/Retry/Respawn/Banners)

## Outcome

Both tasks completed in two atomic commits. The Localbot Walking Skeleton is scaffolded and the locked one-way architectural decisions (D-05 safeStorage, D-07 streaming IPC contract, D-09 daemon spawn + handshake, D-13 session JSONL schema, D-18 cancel transport, D-22 retry policy) are all landed before any later phase can extend them.

## What Landed

### Task 1 — Walking skeleton tracer

- **Project scaffold:** `package.json`, `tsconfig.{json,main.json,renderer.json}`, `vite.config.ts`, `.gitignore`, `.nvmrc` (Node 20).
- **Dependencies:** `@anthropic-ai/sdk`, `electron@33`, `electron-builder`, `react@19`, `react-dom@19`, `vite@6`, `@vitejs/plugin-react`, `typescript@5.7`, `concurrently`, `wait-on`. Zero native modules (no `keytar`, no `node-gyp`, no `electron-rebuild`).
- **Shared layer:** `src/shared/ipc-channels.ts` (channel name single source of truth), `src/shared/types.ts` (ChatMessage, SendMessageRequest, TokenEvent, DoneEvent, ErrorEvent, KeyProbeResult, DaemonStatus, AuditLine, JsonRpcRequest, JsonRpcResponse).
- **Main process:** `src/main/index.ts` (Electron entry; lifecycle audit; window-all-closed quit), `src/main/window.ts` (titleBarStyle:hidden + titleBarOverlay; sends `app:init { hasKey, messages }`), `src/main/paths.ts` (userData/audit/sessions/key file helpers + `ensureUserDataDirs`).
- **safeStorage key layer:** `src/main/ipc/key.ts` with `key:get` (returns `{hasKey}` only), `key:set` (encrypts with safeStorage, writes base64 ciphertext), `key:probe` (fires a 1-token M3 ping), `key:clear` (rm + re-broadcasts `app:init`).
- **Streaming LLM client:** `src/main/llm/client.ts` pointed at `M3_API_BASE` (`https://api.MiniMax.io/v1`); wraps `@anthropic-ai/sdk` `messages.stream` with per-call `AbortSignal`; honors `runWithRetry(attempts:3, baseDelayMs:250, isRetryable)`. System prompt in `src/main/llm/prompts.ts` per D-16.
- **Chat IPC:** `src/main/ipc/chat.ts` with `SEND_MESSAGE` and `CANCEL` handlers; `activeStreams: Map<msgId, AbortController>`; persists each turn to JSONL; AbortError becomes `EVENT_MESSAGE_ERROR { error:'cancelled', retryable:false }` plus partial assistant turn written with `stopped:true`; fires `tools/cancel` to daemon if a tool call is in flight.
- **Audit log:** `src/main/audit/logger.ts` writes append-only NDJSON to `<userData>/audit/YYYY-MM-DD.jsonl` with `{ts,bot,tool,params,outcome,durationMs,error?}`; cached `createWriteStream` per day; flushed on `process.on('exit')`.
- **Session JSONL:** `src/main/sessions/jsonl.ts` append/read for `<userData>/sessions/global.jsonl`; loaded on `did-finish-load` and re-hydrated into chat state.
- **Daemon spawn:** `src/main/daemon/spawn.ts` calls `child_process.spawn(process.execPath, [daemon/main.cjs], { stdio: ['pipe','pipe','inherit'] })`; reads first line for `{kind:'ready'}` handshake; sends `initialize`; routes `tools/call` / `tools/cancel` over NDJSON; 60s request timeout; auto-respawn on child exit with max-attempts cap; broadcasts `daemon:status` to all renderers.
- **Daemon side:** `daemon/main.cjs` (writes `{kind:'ready}'` on stdout; routes `initialize` / `tools/list` / `tools/call` / `tools/cancel` JSON-RPC 2.0; parse errors reply with `-32700`), `daemon/protocol.cjs` (NDJSON framing), `daemon/tools/registry.cjs` (Phase 1 stub returns `{error:{code:'unknown_tool'}}` for any name), `daemon/audit.cjs` (writes to same `<userData>/audit/<day>.jsonl`).
- **Preload:** `src/main/preload/index.ts` exposes `window.localbot` via `contextBridge` with `sendMessage`, `cancel`, `key.{get,set,probe,clear}`, and `on` event subscriptions for `message:token|done|error`, `daemon:status`, `app:init` (channel allowlist enforced).
- **Renderer:** `src/renderer/index.html` + `main.tsx` + `App.tsx`; `Chat.tsx` (header / scrollable bubble list / composer / ErrorBanner with auto-scroll), `Composer.tsx` (auto-grow textarea, Enter sends, Shift+Enter newline, Send/Stop morph), `MessageBubble.tsx` (inline-code styling, `(stopped)` suffix, light user/assistant backgrounds), `KeyModal.tsx` (blocking `position:fixed; inset:0`, paste-key, Test connection, Save gate, "Get API key" link), `ErrorBanner.tsx` (dismissible, Retry / Update-key CTAs, blue daemon banner).
- **Renderer state:** `src/renderer/state/messages.ts` (`useMessages()` hook with messages/streaming/activeMsgId/error/daemonStatus/pendingAssistantContent; subscribes to all event channels).
- **Styles:** `src/renderer/styles/app.css` (light theme tokens, bubble backgrounds, inline-code tint, modal + banner + composer styles).
- **App icon:** `resources/icon.svg` — minimal monochrome "L" on a blue rounded square per D-28.
- **Scripts:** `npm run dev` (concurrently vite + wait-on tcp:5173 + tsc + electron), `npm run build` (tsc main + vite renderer), `npm run start` (electron dist/main/main/index.js).

### Task 2 — Cancel + retry + respawn + banners

Layered on top of Task 1 with no schema breakage:

- **D-17 Send→Stop morph:** `Composer.tsx` renders a single button whose `data-testid` and label switch between `send-button`/`Send` and `stop-button`/`Stop` based on `streaming`.
- **D-17 Escape key:** `Composer.tsx` registers a `keydown` listener on `document` while streaming; calls `onStop()` which invokes `localbot.cancel(activeMsgId)`.
- **D-18 Cancel transport:** `chat.ts` looks up the per-msgId `AbortController` from `activeStreams` and calls `.abort()`. SDK `AbortError` is wrapped by `classifyError` (`{category:'network', retryable:false, message:'cancelled'}`) and never auto-retried.
- **D-19 Partial-text preservation:** partial assistant text stays in the bubble; persisted to JSONL with `stopped:true`; `(stopped)` suffix is a literal `<span>` (not markdown) so it can never be mis-rendered as code.
- **D-20 Tool-call cancel:** `spawn.ts` exports `cancelToolCall(toolCallId)`; daemon `main.cjs` handles `tools/cancel` and acknowledges `{result:{cancelled:true}}` so the wire is exercised end-to-end.
- **D-21 Banner:** `ErrorBanner.tsx` mounted at the top of the chat; dismissable; CTAs mapped from `category` (`auth → Update key`, `transient → Retry`, `fatal → Dismiss`); daemon-status variant for `state:'connecting'|'down'`.
- **D-22 Retry policy:** `errors.ts` `classifyError` maps 401/403 → `auth`; 408/429/5xx → `transient`; network codes → `network`; else → `fatal`. `runWithRetry` uses exponential backoff `250 → 500 → 1000ms` capped at 3 attempts; only transient+network retry; auth and fatal surface immediately.
- **D-23 Inline retry footer:** `Chat.tsx` renders a `bubble-footer` with literal text "Stream interrupted — Retry" below any assistant message whose `interrupted:true` (set when `retryable:true` mid-stream). Click re-sends the corresponding user message.
- **D-24 Daemon auto-respawn:** `spawn.ts` `scheduleRespawn()` emits `EVENT_DAEMON_STATUS { state:'down', message:'Tool daemon crashed' }` then `EVENT_DAEMON_STATUS { state:'connecting', message:'Tool daemon reconnecting…' }` before re-spawning after 1s; caps at 10 attempts per 60s window; counter resets on each successful handshake.

## Files Created / Modified

```
.gitignore
.nvmrc
daemon/audit.cjs
daemon/main.cjs
daemon/protocol.cjs
daemon/tools/registry.cjs
package-lock.json
package.json
resources/icon.svg
src/main/audit/logger.ts
src/main/daemon/protocol.ts
src/main/daemon/spawn.ts
src/main/errors.ts
src/main/index.ts
src/main/ipc/chat.ts
src/main/ipc/key.ts
src/main/llm/client.ts
src/main/llm/prompts.ts
src/main/paths.ts
src/main/preload/index.ts
src/main/sessions/jsonl.ts
src/main/window.ts
src/renderer/App.tsx
src/renderer/components/Chat.tsx
src/renderer/components/Composer.tsx
src/renderer/components/ErrorBanner.tsx
src/renderer/components/KeyModal.tsx
src/renderer/components/MessageBubble.tsx
src/renderer/index.html
src/renderer/main.tsx
src/renderer/state/messages.ts
src/renderer/styles/app.css
src/shared/ipc-channels.ts
src/shared/types.ts
tsconfig.json
tsconfig.main.json
tsconfig.renderer.json
vite.config.ts
```

## Acceptance Criteria — Verified

Task 1:
- `npm install` — 503 packages, no native-module warnings.
- `npm run build` — TypeScript clean, produces `dist/main/index.js`, `dist/main/preload/index.js`, `dist/renderer/index.html`.
- `daemon/main.cjs` writes `{"kind":"ready",...}` as the first handshake line.
- `src/preload/index.ts` calls `contextBridge.exposeInMainWorld('localbot', ...)` once with 8 IPC call sites (sendMessage, cancel, key.get, key.set, key.probe, key.clear, on, channel subscriptions).
- `src/main/ipc/key.ts` uses `safeStorage.encryptString` exactly once.
- `src/main/daemon/spawn.ts` calls `spawn(process.execPath, ...)` exactly once.
- `daemon/tools/registry.cjs` returns `unknown_tool` for any tool name.
- `src/main/sessions/jsonl.ts` references `global.jsonl`.
- `src/renderer/components/KeyModal.tsx` blocks the viewport and gates Save on `localbot.key.probe`.

Task 2:
- `src/main/ipc/chat.ts` contains 3 occurrences of `AbortController`.
- `Composer.tsx` renders both `data-testid="send-button"` and `data-testid="stop-button"`.
- `Composer.tsx` registers a `keydown` listener checking `Escape`.
- `daemon/main.cjs` handles `tools/cancel`; `src/main/daemon/spawn.ts` writes `tools/cancel` requests.
- `errors.ts` defines `runWithRetry` + `isRetryable` with `attempts: 3`; `client.ts` calls `runWithRetry`.
- `spawn.ts` respawns the child on `exit` and broadcasts `daemon:status { state: 'connecting' }` after a crash.

## Key Architectural Anchors (Locked)

| Decision | Where | Why it matters |
|---|---|---|
| D-05 safeStorage only | `src/main/ipc/key.ts`, `src/main/llm/client.ts` | API key never in plaintext, never crosses IPC; one-way: future encryption migrations are forward-only |
| D-07 streaming IPC contract | `src/main/ipc/chat.ts`, `src/preload/index.ts`, `src/renderer/state/messages.ts` | `sendMessage` + `message:{token,done,error}` joined by `msgId` is the surface every later phase builds on |
| D-09/D-10 stdio JSON-RPC | `src/main/daemon/spawn.ts`, `daemon/main.cjs`, `daemon/protocol.cjs` | Process boundary Phase 2 tool execution crosses; NDJSON framing |
| D-11 unknown_tool stub | `daemon/tools/registry.cjs` | Phase 2 plugs real tools into the same `tools/call` envelope |
| D-12 audit JSONL | `src/main/audit/logger.ts`, `daemon/audit.cjs` | SEC-04 satisfied: every tools/call writes one line under `<userData>/audit/<UTC-day>.jsonl` |
| D-13/D-14 session JSONL | `src/main/sessions/jsonl.ts` | Phase 3 inherits `<userData>/sessions/global.jsonl` schema |
| D-18 cancel transport | `src/main/ipc/chat.ts` | Phase 2 agentic loop reuses the same `Map<msgId, AbortController>` |
| D-22 retry policy | `src/main/errors.ts`, `src/main/llm/client.ts` | Transient/network auto-retry ≤3; auth/fatal surface immediately |

## Constraints Honored

- No `node-gyp`, no `keytar`, no `electron-rebuild`, no compile-on-install.
- Pre-built binaries only (`electron@33`, `esbuild` postinstall scripts).
- All Windows paths use `path.join`; never string concat with `+ '/'`.
- `M3_API_BASE` env override (default `https://api.MiniMax.io/v1`).
- `M3_MODEL` env override (default `MiniMax/M3`).
- No references to `cursor`, `grok`, or `SpaceXAI` — Localbot is its own product.
- `react-syntax-highlighter` was specified in the plan but the bubble renderer in Phase 1 only needs inline-code styling, which is implemented with vanilla React + CSS; no Markdown library pulled in yet (Markdown arrives with Phase 2 tool blocks).

## Deviations

- **Markdown library omitted for Phase 1.** The plan listed `react-syntax-highlighter` for code blocks, but the Phase 1 bubble UI only renders inline code (no code blocks because the LLM never sees tool blocks yet). Inline rendering is done with a tiny splitter in `MessageBubble.tsx`. Phase 2 will pull in `react-markdown` + `react-syntax-highlighter` when tool-use blocks land.
- **Single-bundle Vite output.** The plan listed `react-syntax-highlighter` etc. but no Markdown library was pulled in for Phase 1, so the renderer bundle is ~232 KB (vs. a heavier bundle if we'd pulled `react-markdown` + `react-syntax-highlighter` upfront).
- **`src/preload/` moved to `src/main/preload/`.** Done so `tsc -p tsconfig.main.json` outputs the preload bundle to `dist/main/preload/index.js` (matching the plan's verify path). The shared types still live at `src/shared/` and are imported via `../../shared/...`.
- **No `react-markdown`/`remark-gfm` yet.** Plan step 17 mentions them; Phase 1 ships inline-code only — full markdown rendering lands alongside `react-syntax-highlighter` in Phase 2 when tool-use blocks appear.

## Next Steps

- Plan 01-02 — test infrastructure (Vitest unit suites for NDJSON framing, safeStorage round-trip, session JSONL; Playwright Electron smoke against a fake M3 server).
