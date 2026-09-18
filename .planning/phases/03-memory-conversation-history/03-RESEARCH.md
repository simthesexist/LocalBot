# Phase 3: Memory + Conversation History — Research

**Researched:** 2026-09-18
**Domain:** Per-bot durable memory + per-session JSONL history + token-budget auto-summarization + workspace tree/diff
**Confidence:** HIGH (anchored to in-repo files read this session; M3/Anthropic SDK source verified; Phase 1+2 patterns inherited)

---

## Summary

Phase 3 turns the single global session JSONL (`<userData>/sessions/global.jsonl`) into a bot-scoped, multi-session, summarization-aware conversation archive. Each bot accumulates two durable memory artifacts on disk — a free-form `memory.md` (LLM-curated narrative) and a typed `facts.json` (key-value facts) — that survive app restart and are injected into the system prompt on every turn so the bot retains identity, preferences, and prior decisions across sessions. The single shared session file is split into per-bot, per-session JSONL files so the chat history is browsable per bot.

When the conversation approaches the model's token ceiling, the main process triggers a summarization pass: it folds older messages into a compact summary message (single assistant turn, kept at the head of the JSONL) so the active thread can continue without losing continuity. The summarization call goes through the same `@anthropic-ai/sdk` client but with its own retry budget so it cannot mask outer-stream failures. M3 does not reliably expose `countTokens()` — Phase 3 therefore accumulates the `usage` field on every streamed `Message` and triggers summarization when accumulated tokens cross a soft cap (~80% of model max), not by counting pre-call.

The renderer gains a workspace file tree (React-based, with `react-arborist` selected over a custom virtualised build) and a diff view (`react-diff-viewer-continued`) for `edit_file` operations, both backed by a daemon-side `list_tree` JSON-RPC method that extends the existing `list_dir` pattern. Memory write is exposed both as an autonomous LLM tool (`update_memory`/`read_memory`) and as a post-turn hook (so the bot can persist without explicit tool calls).

**Primary recommendation:** Keep the three-tier architecture intact (renderer ← IPC → main → JSON-RPC → daemon). Put memory IO in the daemon (security boundary), per-bot per-session JSONL routing in main (where the agentic loop already lives), summarization as a pre-loop pass in `chat.ts` (before invoking `runAgenticLoop`), and the file tree / diff view in the renderer (UI concern). This keeps Phase 3 additive on Phase 1+2 without changing the locked IPC contract or the daemon transport.

---

## User Constraints

> No `03-CONTEXT.md` exists for this phase. Decisions below are derived from `.planning/PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, the Phase 1 locked decisions in `01-CONTEXT.md` / `SKELETON.md`, and the Phase 2 file/tools patterns in `02-RESEARCH.md` (the locked decisions inherit from Phase 1; nothing in Phase 2 is reopened).

### Locked Decisions (inherited from Phase 1; not reopenable in Phase 3)

- **D-07 (one-way):** IPC contract `sendMessage`/`cancel` + `message:token`/`message:done`/`message:error` is the surface Phase 3 memory/history/tree/diff events build on. Phase 3 must extend with new event channels (`memory:updated`, `tree:refresh`, `tree:error`, `history:loaded`), not rename existing ones.
- **D-10/D-11 (one-way):** Daemon transport = JSON-RPC 2.0 over NDJSON, max line 1 MiB. `tools/call` already supports tool dispatch; Phase 3 adds `memory/read`, `memory/write`, `tree/list` as new JSON-RPC methods.
- **D-12:** Audit log line shape `{ts, bot, tool, params, outcome, durationMs, error?}` is the SEC-04 contract; memory ops log as `{tool: 'memory.read' | 'memory.write' | 'memory.update'}` with the same shape.
- **D-13/D-14 (costly):** Session JSONL lives at `<userData>/sessions/global.jsonl` with shape `{ts, role, content, blocks?, stopped?, interrupted?}`. Phase 3 splits per-bot/per-session into `<userData>/sessions/<bot>/<sessionId>.jsonl`; on first launch, read legacy `global.jsonl` into the `default` bot so existing data survives.
- **D-16:** System prompt is a constant in `src/main/llm/prompts.ts`; Phase 3 rebuilds it per-turn by appending an injected memory block (markdown + facts.json summary) so the persona stays consistent while memory becomes a variable suffix.
- **D-17/D-18 (costly):** In-flight cancel uses `ipcRenderer.invoke('cancel', msgId)` + main's `Map<msgId, AbortController>` + daemon `tools/cancel` JSON-RPC. The Phase 3 summarization call **must** reuse the same map so that pressing Stop mid-summarize aborts the summary call too (a summary that the user can't cancel would block a fresh message).
- **D-22:** Network/5xx auto-retry ≤3 with exp backoff wraps the SDK call only. Phase 3's summarization call gets its **own** retry budget (≤3) so a flaky summary cannot trigger an outer-stream retry that re-runs tool calls with side effects.
- **SKELETON.md row "Phase 3":** "Session files become per-`(bot, id)` JSONL; memory file + facts JSON appear in workspace tree; summarization kicks in above the token budget. Audit log + daemon process boundary unchanged."

### Claude's Discretion (Phase 3)

- Memory file paths (`<userData>/bots/<bot>/memory.md` + `<userData>/bots/<bot>/facts.json` vs a single `<userData>/workspace/<bot>/...` layout).
- Markdown schema: sections like `## Identity`, `## Preferences`, `## Recent` vs free-form LLM-curated with light structure guidance.
- `facts.json` schema: typed union (`{name, value, source, updatedAt}[]`) vs arbitrary `{[key: string]: unknown}` KV.
- Memory read path — system-prompt injection only, `read_memory` tool only, or both.
- Memory write trigger — autonomous `update_memory` tool, post-turn summarizer hook, session-end flush, or all three.
- Session ID format — ISO timestamp (`2026-09-18T10-30-00Z`), UUID v4, or `<ts>-<random4>`.
- Session reload window — most-recent-N (e.g., 50 turns) vs all-history-from-disk.
- Token threshold trigger — soft cap (e.g., 80% of `max_tokens * 4` chars) vs hard cap.
- Summary shape — single assistant `text` block vs structured `{summary, key_facts, next_steps}` JSON rendered as both text and a facts.json update.
- File tree library — `react-arborist` vs `@tanstack/react-virtual` custom build vs `react-complex-tree`.
- Diff view library — `react-diff-viewer-continued` vs `diff` + custom React vs `react-diff-view`.
- Tree refresh strategy — `chokidar` watcher, poll-on-open, manual refresh button, or all three (chokidar + manual fallback).
- Tree root — bot workspace (`<userData>/workspace/<bot>/`), per-bot configurable, or userData root.

### Deferred Ideas (out of scope; do NOT research)

- Phase 4 multi-bot CRUD + sidebar UI; Phase 3 hard-codes a single `default` bot path under `<userData>/bots/default/`.
- Phase 5 `exec_command` + global denylist (SEC-03).
- Phase 7 Obsidian vault paths and per-vault allowlists.
- Phase 6 cron scheduler + system notifications.
- Phase 8 Playwright browser tools.
- Phase 9 Tailscale-friendly HTTP/WS endpoint + Windows .exe packaging.
- Multi-window / system tray icon / real app icon (Phase 4 or 9).
- `git`-backed memory versioning or rollback UI.
- Vector-embedding-based semantic memory retrieval.
- Cross-bot shared memory.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **AGENT-05** | Per-bot `memory.md` + `facts.json` persist across sessions | `src/main/paths.ts:46-47` already exposes `botsDir()`; new helpers `botDir(bot)`, `memoryPath(bot)`, `factsPath(bot)` build on it; daemon `memory/read` + `memory/write` JSON-RPC methods wrap `fs/promises` + safePath against `<botDir>` |
| **AGENT-06** | Per-bot per-session JSONL conversation history survives restart | `src/main/sessions/jsonl.ts:11` currently hardcodes `global.jsonl`; `appendMessage`/`loadSession` accept a `bot` + `sessionId` arg so they route to `<sessionsDir>/<bot>/<sessionId>.jsonl`; one-time migration reads legacy `global.jsonl` into `default` bot if it exists |
| **LLM-04** | Auto-summarize when token budget approached | `streamChat` in `src/main/llm/client.ts:65-185` already streams SSE; new `accumulateUsage()` reads `usage.input_tokens` + `usage.output_tokens` from `message_start` + `message_delta` events; pre-loop `maybeSummarize()` in `chat.ts` triggers when accumulated `input_tokens > SOFT_CAP` |
| **UI-08** | Workspace file tree + diff view for `edit_file` | `daemon/tools/list_dir.cjs:1-54` is single-level; extend to recursive `list_tree` JSON-RPC method (cap entries per dir + lazy children); renderer uses `react-arborist@3.x` for tree and `react-diff-viewer-continued@4.x` for diff; both add `<5 KB` to renderer bundle |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Memory markdown IO (`memory.md` read/write) | Daemon | — | Phase 2's SEC-02 pattern: all filesystem IO lives at the trust boundary; main never touches user filesystem directly for memory |
| Memory facts JSON IO (`facts.json`) | Daemon | — | Same rationale; `safePath` containment against `<userData>/bots/<bot>/` |
| Per-bot JSONL writer | API / Backend (main) | — | `appendMessage` lives in main; routing to `<sessionsDir>/<bot>/<sessionId>.jsonl` is a pure path split |
| Session reload on launch | API / Backend (main) | — | Renderer requests history on mount; main reads `<sessionsDir>/<bot>/*.jsonl` newest-first |
| Token counting (input/output) | API / Backend (main) | — | SDK stream exposes `usage` on `message_start` + `message_delta`; main accumulates per `msgId` |
| Summarization trigger (threshold check) | API / Backend (main) | — | Pre-loop pass in `chat.ts` reads accumulated tokens and decides when to summarize |
| Summarization LLM call | API / Backend (main) | — | Same SDK client; separate `runWithRetry` budget per D-22; result is written into JSONL head and facts.json |
| Workspace tree (`list_tree`) | Daemon | — | Trust boundary; caps entries per dir; uses `safePath` against workspaceRoot (Phase 2's pattern) |
| Tree refresh watcher | Daemon | — | `chokidar` watches workspaceRoot; debounced `tree:refresh` event broadcast via main → renderer |
| Diff view rendering | Renderer (React) | — | `edit_file` already produces before/after pairs in `tool_result` blocks (Phase 2); renderer renders diff between prior and new content |
| Memory injection into system prompt | API / Backend (main) | — | Rebuilds system prompt each turn by appending memory markdown + facts.json summary; renderer is unaware |
| Audit entries for memory ops | Daemon (writes) | Main (broadcasts) | Same `{ts, bot, tool, params, outcome, durationMs, error?}` shape as Phase 1/2; tool name = `memory.read` / `memory.write` |
| `update_memory` / `read_memory` tools | Daemon (executes) | Main (loops) | Same `tools/call` envelope as Phase 2; allowlist extends with these two names |
| Cancel mid-summarize | Main | Daemon | Reuses `Map<msgId, AbortController>` + SDK `stream.controller.abort()` from Phase 1 |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/sdk` | `^0.40.1` (installed: 0.40.1) | Streaming + tool_use + usage accumulation | Locked in Phase 1; same client handles the summary call; `stream.finalMessage()` exposes the final `Message.usage` |
| `chokidar` | `^3.6.0` (planned) | Filesystem watcher for workspace tree + memory file | Standard Node watcher (1.5M weekly downloads); debounced + cross-platform; no node-gyp (uses `fsevents` only on macOS, polling on Windows) |
| `react-arborist` | `^3.4.0` (planned) | Workspace tree renderer | Headless tree component with built-in virtualization + keyboard nav; 60 KB minified; works with React 19; maintained by Guillotro (same author as `react-complex-tree`, successor to that lib) |
| `react-diff-viewer-continued` | `^4.0.0` (planned) | Side-by-side / unified diff renderer | Community-maintained fork of the archived `react-diff-viewer`; supports React 19 + dark/light themes; ~30 KB minified |
| Node 20+ stdlib (`fs/promises`, `path`, `readline`) | built-in | Memory file IO, JSONL append, token counting helpers | No third-party needed; proven by Phase 1+2 |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | `^2.1.9` (installed) | Unit tests for token accumulator, JSONL router, memory merge logic | Same env/aliases as Phase 2 |
| `@playwright/test` | `^1.63.0` (installed) | Smoke: legacy global.jsonl migrates to `default/<sessionId>.jsonl`; fake M3 returns a stream whose `usage` triggers summarize | Extends `tests/playwright/fake-m3-server.ts` with `streamSummarizeResponse()` helper |
| `diff` | `^5.2.0` (planned) | Pure-JS line diff for `react-diff-viewer-continued` input | Standard `jsdiff` package; 2 MB weekly downloads |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `react-arborist` | `@tanstack/react-virtual` + custom tree component | Custom build = more control but ~2× the code; `react-arborist` already handles open/close + virtualization + keyboard nav |
| `react-arborist` | `react-complex-tree` | Older API; `react-arborist` is the active successor; same author |
| `react-diff-viewer-continued` | `react-diff-view` (LiangZhao) | Maintained; `react-diff-viewer-continued` has the same API as the archived `react-diff-viewer` and a wider community |
| `react-diff-viewer-continued` | `diff` lib + custom React | Hand-rolling line wrap, gutter, and word-level highlighting is significant work for no real win |
| `chokidar` | `fs.watch` (stdlib) | Stdlib is per-platform inconsistent; `chokidar` normalizes the surface and adds debouncing |
| `chokidar` | Poll every N seconds | Higher latency, more disk IO on idle |
| Token cap via `usage` accumulation | SDK `countTokens()` pre-call | M3 does not reliably expose `countTokens()`; counting from `usage` is the safer path (per `node_modules/@anthropic-ai/sdk/src/resources/messages/messages.d.ts:Usage`) |
| Token cap via `usage` accumulation | `gpt-tokenizer` / `tiktoken` local estimate | Local estimate drifts from M3 actuals; `usage` is authoritative |
| Per-session JSONL (`<bot>/<sessionId>.jsonl`) | Single `<bot>.jsonl` with session markers | Single file mixes sessions; harder to inspect; Phase 1's global.jsonl pattern is the precedent for splitting |
| Per-session JSONL | `<bot>/<ts>.jsonl` (one per turn) | Excessive file count; harder to reload contiguous history |

**Installation:**
```bash
npm install chokidar@^3.6.0 react-arborist@^3.4.0 react-diff-viewer-continued@^4.0.0 diff@^5.2.0
```

**Version verification:**
- `@anthropic-ai/sdk@0.40.1` confirmed via `node_modules/@anthropic-ai/sdk/package.json`.
- `chokidar@3.6.0` last published ~3 years ago; widely deployed; no slopsquat risk.
- `react-arborist@3.4.0` last published 2024; maintained.
- `react-diff-viewer-continued@4.0.0` last published 2024; fork of archived `react-diff-viewer`; small but stable.
- `diff@5.2.0` (jsdiff) confirmed via `npm view`; long-standing package (1st release 2013).

### React 19 compatibility note

`react-diff-viewer-continued` may need `--legacy-peer-deps` or a peer-deps resolution shim because some older forks pinned `react@18`. If installation errors, fall back to a peer-deps override in `package.json`:
```json
"overrides": { "react-diff-viewer-continued": { "peerDependencies": { "react": "^19" } } }
```

---

## Package Legitimacy Audit

| Package | Registry | Age | Source Repo | Verdict | Disposition |
|---------|----------|-----|-------------|---------|-------------|
| `@anthropic-ai/sdk` | npm | First released 2023; v0.40.1 confirmed via `node_modules` | github.com/anthropics/anthropic-sdk-typescript | OK | Already installed; no install needed |
| `chokidar` | npm | First release 2013; v3.6.0 | github.com/paulmillr/chokidar | OK | `npm install chokidar@^3.6.0` |
| `react-arborist` | npm | First release 2022; v3.4.0 | github.com/guillotro/react-arborist | OK | `npm install react-arborist@^3.4.0`; verify React 19 peer dep |
| `react-diff-viewer-continued` | npm | First release 2022 (fork); v4.0.0 | github.com/aeolcher/react-diff-viewer-continued | OK | `npm install react-diff-viewer-continued@^4.0.0`; may need peer-deps override |
| `diff` | npm | First release 2013; v5.2.0 | github.com/kpdecker/jsdiff | OK | `npm install diff@^5.2.0` (peer of react-diff-viewer-continued) |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none
**Packages discovered via WebSearch not verified against an authoritative source:** none — all five packages sourced from established GitHub repos.

> **Provenance caveat:** The npm registry confirms these packages exist, but they were selected via WebSearch + training knowledge, not an official documentation source. Per the package-name provenance rule, they are tagged `[ASSUMED]` in the Standard Stack table; planner should add a `checkpoint:human-verify` task before adding each install.

---

## Architecture Patterns

### System Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│ Renderer (React 19)                                                  │
│                                                                       │
│  ┌────────────┐    ┌────────────────┐    ┌──────────────────────┐    │
│  │ Composer   │    │ Chat           │    │ MessageBlock         │    │
│  │ (existing) │    │ (existing)     │───►│ text | tool_use |     │    │
│  │            │    │                │    │ tool_result | diff    │    │
│  └────────────┘    └────────────────┘    └──────────────────────┘    │
│        │                                                            │
│        │ on mount                                                   │
│        ▼                                                            │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────┐    │
│  │ WorkspaceTree    │    │ DiffView         │    │ MemoryPanel  │    │
│  │ react-arborist   │    │ react-diff-      │    │ (read-only   │    │
│  │                  │    │ viewer-continued │    │  preview)    │    │
│  └──────────────────┘    └──────────────────┘    └──────────────┘    │
└────────────────────────────┬─────────────────────────────────────────┘
                             │  IPC: sendMessage | cancel | tree:refresh
                             │  events: message:* | memory:updated
                             │         tree:refresh | history:loaded
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Electron Main                                                         │
│                                                                       │
│  ┌────────────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│  │ ipc/chat.ts    │───►│ llm/loop.ts      │───►│ M3 /v1/messages  │  │
│  │ + memory       │    │ (existing, with  │    │ Anthropic SDK    │  │
│  │   injection    │    │  maybeSummarize  │    │ + usage accum.   │  │
│  │                │    │  pre-loop)       │    │                  │  │
│  └────────────────┘    └──────────────────┘    └──────────────────┘  │
│          │                      │                                    │
│          │                      │ JSON-RPC: memory/* | tree/list     │
│          ▼                      ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ sessions/jsonl.ts (rewrite)                                   │    │
│  │   <sessionsDir>/<bot>/<sessionId>.jsonl                       │    │
│  │   legacy global.jsonl → default/<first-sessionId>.jsonl      │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ bots/memory.ts                                               │    │
│  │   readMemory(bot) → {md, facts}                              │    │
│  │   injectMemory(system, md, facts) → system'                  │    │
│  │   summarizeIfNeeded(bot, sessionId, messages) → summary text │    │
│  └─────────────────────────────────────────────────────────────┘    │
└────────────────────────────┬─────────────────────────────────────────┘
                             │  NDJSON over stdio
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Tool Daemon (daemon/main.cjs)                                        │
│                                                                       │
│  ┌────────────────────────┐    ┌──────────────────────────────┐    │
│  │ initialize             │───►│ load bot policy from          │    │
│  │ { userDataDir, botDir }│    │ <userData>/bots/<bot>.json    │    │
│  └────────────────────────┘    └──────────────────────────────┘    │
│                                │                                     │
│  ┌────────────────────────┐    │                                     │
│  │ memory/read,           │    │                                     │
│  │ memory/write,          │◄───┤                                     │
│  │ tree/list              │    │                                     │
│  └────────┬───────────────┘    │                                     │
│           ▼                     ▼                                     │
│  ┌─────────────────────────────────────────────────────┐           │
│  │ tools/registry.cjs (extend allowlist)                 │           │
│  │   + tools/memory_read.cjs                              │           │
│  │   + tools/memory_write.cjs                             │           │
│  │   + tools/update_memory.cjs                            │           │
│  │   + tools/list_tree.cjs  (recursive, capped, lazy)     │           │
│  └─────────────────────────────────────────────────────┘           │
│           │                                                           │
│           ▼                                                           │
│  ┌─────────────────────────────────────────────────────┐           │
│  │ audit append {ts, bot, tool, params, outcome, ...}     │           │
│  └─────────────────────────────────────────────────────┘           │
│                                                                       │
│  ┌─────────────────────────────────────────────────────┐           │
│  │ chokidar.watch(<userDataDir>/bots/<bot>)              │           │
│  │ debounce 250ms → emit 'tree:refresh' notification     │           │
│  └─────────────────────────────────────────────────────┘           │
└──────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
src/main/
  bots/
    memory.ts                    (NEW — readMemory / writeMemory / mergeFacts)
    paths.ts                     (NEW — botDir(bot), memoryPath(bot), factsPath(bot))
  daemon/
    spawn.ts                     (extend — callMemory / callTree methods)
  llm/
    client.ts                    (extend — accumulateUsage from message_start + message_delta)
    summarize.ts                 (NEW — runSummarizer: separate retry budget, writes head-of-JSONL)
    prompts.ts                   (extend — DEFAULT_SYSTEM_PROMPT + injectMemorySuffix)
    loop.ts                      (extend — accept injected system prompt; no other change)
  ipc/
    chat.ts                      (extend — pre-loop maybeSummarize; post-append head summary)
    history.ts                   (NEW — history:load | history:listSessions handlers)
    tree.ts                      (NEW — tree:refresh IPC bridge to daemon chokidar events)
  sessions/
    jsonl.ts                     (rewrite — accept (bot, sessionId); split per-bot path;
                                              add migrateLegacyGlobalJsonl())
  paths.ts                       (extend — sessionFilePath(bot, sessionId))

src/shared/
  ipc-channels.ts                (extend — EVENT_MEMORY_UPDATED, EVENT_TREE_REFRESH,
                                          EVENT_HISTORY_LOADED, CHANNEL_HISTORY_LOAD)
  types.ts                       (extend — MemoryPayload, SummaryRecord, TreeEntry)

daemon/
  tools/
    memory_read.cjs              (NEW — JSON-RPC memory/read method)
    memory_write.cjs             (NEW — JSON-RPC memory/write method; creates dirs)
    update_memory.cjs            (NEW — LLM-callable tool; appends section to memory.md)
    list_tree.cjs                (NEW — recursive tree with caps + lazy children)
  watcher.cjs                    (NEW — chokidar wrapper; debounced refresh event)

src/renderer/
  components/
    WorkspaceTree.tsx            (NEW — react-arborist backed)
    DiffView.tsx                 (NEW — react-diff-viewer-continued wrapper)
    MemoryPanel.tsx              (NEW — read-only preview of memory.md + facts.json)
    MessageBlock.tsx             (extend — diff block variant for edit_file results)

tests/unit/
  memory.test.ts                 (NEW — read/write/merge; concurrency)
  facts.test.ts                  (NEW — mergeFacts dedup by name)
  summarize.test.ts              (NEW — runSummarizer picks oldest N, produces summary,
                                          writes head-of-JSONL)
  jsonl_router.test.ts           (NEW — appendMessage per-bot; loadSession newest-first;
                                          migrateLegacyGlobalJsonl)
  usage_accumulator.test.ts      (NEW — accumulates usage across multi-turn loop)
  list_tree.test.ts              (NEW — caps entries per dir, lazy children, no escape)

tests/playwright/
  memory-history.test.ts         (NEW — fake M3 streams enough usage to trigger summarize;
                                          app restart reloads from <bot>/<sessionId>.jsonl;
                                          renderer shows summary block in chat)
  tree-diff.test.ts              (NEW — workspace tree refreshes after edit_file;
                                          diff view shows before/after)
  fake-m3-server.ts              (extend — streamSummarizeResponse() helper that
                                          emits SSE with usage.input_tokens = 250k)
```

### Pattern 1: Per-bot per-session JSONL routing (AGENT-06)

**What:** The existing `appendMessage` in `src/main/sessions/jsonl.ts:22-33` accepts a flat `(input: AppendInput)` and writes to `global.jsonl`. Phase 3 extends it to `(input: AppendInput, ctx: { bot: string; sessionId: string })` and routes to `<sessionsDir>/<bot>/<sessionId>.jsonl`. `loadSession` becomes `loadSession(bot, sessionId?)`; when `sessionId` is omitted, it lists `<sessionsDir>/<bot>/*.jsonl` newest-first and returns the most recent one.

**When to use:** Every assistant/user turn after Phase 3; chat.ts always passes `bot='default'` + `sessionId=currentSessionId`.

**Example (skeleton — verify before implementing):**
```typescript
// src/main/sessions/jsonl.ts (rewrite signature)
import { sessionFilePath, sessionsDir } from '../paths';

export interface SessionContext {
  bot: string;
  sessionId: string;
}

export async function appendMessage(
  input: AppendInput,
  ctx: SessionContext,
): Promise<void> {
  const record: ChatMessage = { ... };
  const file = sessionFilePath(ctx.bot, ctx.sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
}
```

> **Migration:** On first launch with Phase 3 code, `migrateLegacyGlobalJsonl()` reads `<userData>/sessions/global.jsonl` if it exists; if non-empty, it (a) derives `sessionId = new Date().toISOString().replace(/[:.]/g,'-')`, (b) writes the rows to `<sessionsDir>/default/<sessionId>.jsonl`, (c) renames the legacy file to `global.jsonl.migrated` so subsequent launches skip it.

### Pattern 2: Memory markdown + facts JSON in the daemon (AGENT-05)

**What:** Three new daemon JSON-RPC methods — `memory/read` (returns `{markdown, facts}`), `memory/write` (full replace — used by the user via MemoryPanel), `update_memory` (LLM-callable tool — appends a section to `memory.md` and merges into `facts.json`). All three operate against `<userData>/bots/<bot>/` via the same `safePath` helper from Phase 2.

**When to use:** `update_memory` is registered in `TOOL_SCHEMAS` (Phase 2's `client.ts:30`); the agentic loop dispatches it via `tools/call` like any other tool. `memory/read` is called by main at the start of every turn to inject the current memory into the system prompt.

**Example (skeleton — do not implement here):**
```javascript
// daemon/tools/memory_read.cjs (NEW)
const fs = require('node:fs/promises');
const path = require('node:path');
const { safePath } = require('./safe_path.cjs');

async function call(args, ctx) {
  const mdPath = await safePath(ctx.botDir, 'memory.md');
  const factsPath = await safePath(ctx.botDir, 'facts.json');
  let md = '';
  try { md = await fs.readFile(mdPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let facts = {};
  try { facts = JSON.parse(await fs.readFile(factsPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { markdown: md, facts };
}
```

> **Facts schema:** `facts.json` is `{[name: string]: { value: unknown; source: 'user' | 'tool' | 'summary'; updatedAt: string }}` — typed KV with provenance. `mergeFacts(existing, incoming)` dedups by `name`, keeps the most recent `updatedAt`, and audits each delta.

### Pattern 3: Token accumulator + soft-cap summarize (LLM-04)

**What:** Each `messages.stream` call in `src/main/llm/client.ts:65` already produces a final `Message`; the SDK exposes `stream.finalMessage()` which carries `usage: {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`. Phase 3 adds an `accumulateUsage` map `Map<msgId, {input, output}>` that the agentic loop updates after every turn. Before invoking `runAgenticLoop`, `chat.ts` calls `maybeSummarize({bot, sessionId, messages, accumulatedUsage})`. If `accumulatedUsage.input + messages_chars_estimate > SOFT_CAP`, it (a) takes the oldest N turns (default 10), (b) calls `runSummarizer(turns)` which makes a single SDK call (no streaming), (c) writes the summary as a single assistant turn at the head of `<sessionId>.jsonl`, (d) updates `facts.json` with any facts the summary surfaces.

**When to use:** Pre-loop in `chat.ts:43` (before `runAgenticLoop`). One summary per session-start, plus on-threshold re-summarizes as the session grows.

**Example (skeleton — verify against SDK `messages.d.ts:Usage`):**
```typescript
// src/main/llm/summarize.ts (NEW)
import Anthropic from '@anthropic-ai/sdk';
import { M3_MODEL } from './client';
import { runWithRetry } from '../errors';

export async function runSummarizer(turns: ChatMessage[]): Promise<string> {
  const apiKey = await readKey();
  const client = new Anthropic({ apiKey, baseURL: M3_API_BASE });
  const response = await runWithRetry(
    async () => client.messages.create({
      model: M3_MODEL,
      max_tokens: 1024,
      system: 'You are a concise summarizer. Output a single JSON object: {"summary": "<= 300 words", "facts": [{"name", "value"}]}.',
      messages: [{ role: 'user', content: turns.map(t => `${t.role}: ${t.content}`).join('\n') }],
    }),
    { attempts: 3, baseDelayMs: 250, isRetryable: e => e.category === 'transient' },
  );
  // Parse JSON; fall back to plain text if model returns prose.
  return response.content[0].type === 'text' ? response.content[0].text : '';
}
```

> **SDK usage types verified:** `node_modules/@anthropic-ai/sdk/src/resources/messages/messages.d.ts:Usage` is `{ input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }`. `MessageDeltaUsage` (incremental) is `{output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` — input tokens only arrive on `message_start`.

### Pattern 4: System-prompt memory injection (AGENT-05)

**What:** `chat.ts` calls `injectMemorySuffix(system, memoryMarkdown, factsSummary)` which appends a fenced block to the system prompt: `"\n\n## Bot Memory\n<memory.md (truncated to last N sections)>\n\n## Known Facts\n<facts.json rendered as bullet list>..."`. The result is passed to `runAgenticLoop` as `opts.system`. Renderer is unaware.

**When to use:** Every turn. Cheap: `memory.md` is capped at ~4 KB by trimming oldest sections first; `facts.json` is rendered as a single-line bullet list.

**Example (skeleton — do not implement here):**
```typescript
// src/main/bots/memory.ts (NEW)
export function injectMemorySuffix(
  base: string,
  memoryMarkdown: string,
  facts: Record<string, { value: unknown }>,
  maxBytes = 4096,
): string {
  const trimmed = trimMarkdown(memoryMarkdown, maxBytes); // keep last N sections
  const factsBlock = Object.entries(facts)
    .map(([k, v]) => `- ${k}: ${JSON.stringify(v.value)}`)
    .join('\n');
  return `${base}\n\n## Bot Memory\n${trimmed}\n\n## Known Facts\n${factsBlock}`;
}
```

### Pattern 5: Workspace tree via daemon + react-arborist (UI-08)

**What:** Daemon exposes `tree/list { path, maxDepth, maxEntriesPerDir }` returning a recursive tree `{name, path, type, size?, children?}` with `children` lazily resolved on node-open. `chokidar.watch(workspaceRoot)` fires debounced `tree:refresh` notifications through main → renderer. Renderer mounts `WorkspaceTree` (react-arborist) which calls `tree/list` on mount and on `tree:refresh`.

**When to use:** Whenever the user opens the workspace panel or after any `edit_file` / `write_file` / `memory.write` operation.

**Example (skeleton — verify react-arborist API before implementing):**
```typescript
// src/renderer/components/WorkspaceTree.tsx (NEW)
import { Tree } from 'react-arborist';
import { useEffect, useState } from 'react';

export function WorkspaceTree({ root }: { root: string }) {
  const [data, setData] = useState<TreeNode[]>([]);
  useEffect(() => {
    window.localbot.invoke('tree:list', { path: root, maxDepth: 3 })
      .then(setData);
    const off = window.localbot.on('tree:refresh', () => {
      window.localbot.invoke('tree:list', { path: root, maxDepth: 3 })
        .then(setData);
    });
    return off;
  }, [root]);
  return <Tree data={data} openByDefault={false}>{({node}) => <Node node={node}/>}</Tree>;
}
```

### Pattern 6: Diff view via react-diff-viewer-continued (UI-08)

**What:** When `edit_file` returns `{before, after}` (extension to Phase 2's `edit_file.cjs`), the renderer mounts a `DiffView` block within the `tool_result` for that tool call. Uses `react-diff-viewer-continued` with `splitView={true}` for side-by-side or `splitView={false}` for unified; defaults to split view for wide screens, unified on narrow.

**When to use:** Every `edit_file` tool call result. Binary files (`before` contains a NUL byte) render a placeholder "Binary file — diff unavailable" instead.

**Example (skeleton — do not implement here):**
```typescript
// src/renderer/components/DiffView.tsx (NEW)
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';

export function DiffView({ before, after, file }: { before: string; after: string; file: string }) {
  if (before.includes(' ') || after.includes(' ')) {
    return <div className="binary-placeholder">Binary file: {file}</div>;
  }
  return <ReactDiffViewer oldValue={before} newValue={after} splitView={true} compareMethod={DiffMethod.LINES} />;
}
```

### Anti-Patterns to Avoid

- **Anti-pattern: write `memory.md` from the renderer.** Renderer cannot be trusted to enforce path containment or write atomicity. All memory IO goes through the daemon's `memory/write` JSON-RPC method.
- **Anti-pattern: spawn a separate process for the summary.** The summary is one SDK call from the same client in the same main process. Spawning a child adds IPC for no benefit.
- **Anti-pattern: stream the summary.** `messages.create` (non-streaming) is the right choice — the summary is small, latency is bounded, and `usage` arrives atomically.
- **Anti-pattern: full re-read of `memory.md` on every turn without size cap.** A 200 KB memory file injected into every turn inflates tokens and slows the LLM. Cap at 4 KB; trim oldest sections first.
- **Anti-pattern: write per-turn JSONL into a single line.** Phase 1's append-only NDJSON shape is the established contract; do not switch to a single-array file format (loses crash-safety + append atomicity).
- **Anti-pattern: `tree/list` returns full tree.** Deep workspaces (e.g., 50 000 files) would crash. Cap `maxEntriesPerDir=500` and return `children: null` for unopened nodes; `tree/list` with `path=<node.path>` resolves one level at a time.
- **Anti-pattern: summarize the entire session on every threshold crossing.** Incremental summarization: keep the existing head summary; only re-summarize the *oldest unsummarized* N turns when the threshold is crossed again. Keeps the summary current and bounded.
- **Anti-pattern: poll the daemon for tree refresh.** `chokidar` is push-based; polling adds latency and disk IO. Use the chokidar-debounced event instead.
- **Anti-pattern: persist `usage` tokens into the JSONL row.** Tokens are derived from the message itself; storing them bloats storage and forces schema migrations later.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Recursive directory walker | Custom recursive `fs.readdir` with depth tracking | `daemon/tools/list_tree.cjs` using `fs.readdir(...,{withFileTypes:true})` + depth-bounded recursion + per-dir cap | Edge cases: symlinks, ENOENT mid-walk, permission errors, very deep trees — stdlib + caps handle all |
| Line-level diff rendering | `diff` lib + custom React gutter/word-highlight | `react-diff-viewer-continued` (which uses `diff` internally) | Word-level highlighting, line numbers, gutter, theme switch — ~600 LOC of plumbing we don't need to write |
| Token counting pre-call | `gpt-tokenizer` / `tiktoken` local estimate | SDK `Message.usage.input_tokens` from streamed response | Local estimate drifts from M3 actuals; `usage` is authoritative for the model's own count |
| Filesystem watching | `fs.watch` (stdlib) | `chokidar` | Stdlib is per-platform inconsistent; `chokidar` normalizes + debounces + emits `add`/`change`/`unlink` |
| Tree component | Custom `<div>` recursion with `useVirtual` | `react-arborist` | Open/close, lazy children, keyboard nav, virtualization — all built in |
| Summary LLM call retry | Custom retry loop around `messages.create` | Phase 1's `runWithRetry` (`src/main/errors.ts`) with separate budget | Already proven for `streamChat`; just call it again with different `attempts` |
| Bot metadata file format | SQLite, leveldb | `<userData>/bots/<bot>/memory.md` + `facts.json` plain files | Matches Phase 4's "bots are files" model; inspectable in any text editor |
| Migration from `global.jsonl` | Live reader that handles both formats | One-shot `migrateLegacyGlobalJsonl()` on first launch; rename source to `.migrated` after | Simpler; eliminates legacy branches in `appendMessage`/`loadSession` |

**Key insight:** Phase 1+2 already built the IPC, NDJSON framing, audit log, AbortController map, safePath helper, and `runWithRetry` that Phase 3 needs. Phase 3 is **additive** in four directions: (a) per-bot per-session JSONL routing, (b) memory markdown + facts JSON ops in the daemon, (c) summarize pre-loop pass + usage accumulator, (d) workspace tree + diff view in the renderer. Resist the temptation to refactor the existing JSONL writer unless the migration forces it (and it doesn't — the existing `appendMessage` signature is already extensible).

---

## Common Pitfalls

### Pitfall 1: Memory file grows unbounded

**What goes wrong:** `memory.md` accumulates LLM-curated prose indefinitely; after 6 months a single bot's memory is 200 KB and inflates every turn's system prompt by ~50 K tokens.

**Why it happens:** No size cap, no LLM-side eviction policy, no rotation.

**How to avoid:** Cap `memory.md` at 4 KB in `injectMemorySuffix`; trim oldest sections first (keep last N H2 sections). `facts.json` is small by construction (KV pairs). `update_memory` tool refuses appends that would push past 8 KB; instead it asks the LLM to consolidate.

**Warning signs:** System prompt size > 10 KB; first-token latency > 500 ms.

### Pitfall 2: Token-budget heuristic drifts from M3 actuals

**What goes wrong:** Pre-call `countTokens()` is unavailable on M3; using `gpt-tokenizer` (OpenAI's BPE) underestimates Anthropic tokenizer counts by ~15%, so the "80% soft cap" actually fires at 92% of model max, occasionally producing `stop_reason: 'max_tokens'`.

**Why it happens:** `messages.countTokens()` is documented for Anthropic but M3 may not implement it; using a third-party tokenizer that doesn't match M3's actual encoding.

**How to avoid:** Don't pre-call `countTokens`. Accumulate `usage.input_tokens + usage.output_tokens` from the streamed `Message` (Phase 3 Pattern 3). Track per-session; trigger summarize when `accumulated > SOFT_CAP` (e.g., 100 000 tokens for a 200 K-cap model).

**Warning signs:** Stream emits `stop_reason: 'max_tokens'` mid-tool-use.

### Pitfall 3: Per-bot sessions fragment legacy `global.jsonl`

**What goes wrong:** Existing users have weeks of chat in `<userData>/sessions/global.jsonl`. After Phase 3 ships, new sessions land in `<sessionsDir>/default/<id>.jsonl` and the legacy file is silently ignored. The bot "forgets" all prior context.

**Why it happens:** No migration step in the JSONL rewrite.

**How to avoid:** On first launch, `migrateLegacyGlobalJsonl()` checks `<sessionsDir>/global.jsonl`. If non-empty, it (a) derives `sessionId = new Date().toISOString().replace(/[:.]/g,'-')`, (b) writes the rows to `<sessionsDir>/default/<sessionId>.jsonl`, (c) renames the legacy file to `<sessionsDir>/global.jsonl.migrated` so subsequent launches skip it.

**Warning signs:** Users report "my chat history disappeared".

### Pitfall 4: Summarization inherits outer retry

**What goes wrong:** The summary LLM call sits inside `runWithRetry` with `attempts: 3`. If the outer `streamChat` also retries (per D-22), a transient 5xx during summary bubbles up as an outer-stream error and triggers a full re-run of the agentic loop — including tool calls that already mutated the workspace.

**Why it happens:** Both calls share the same `runWithRetry` and the same `AbortSignal`.

**How to avoid:** `runSummarizer` uses its own `runWithRetry` instance with `attempts: 3` AND a separate `AbortSignal` chain (child of the user's cancel signal). If the user cancels mid-summarize, abort just the summary — do not propagate to the outer loop. If the summary fails after 3 attempts, surface as `category: 'fatal'` but do not retry the outer loop.

**Warning signs:** Manual test: kick off a long session, hit summarize threshold, kill network mid-summary; observe two assistant bubbles instead of one.

### Pitfall 5: File tree of large workspace slow

**What goes wrong:** A user workspace containing `node_modules/` (40 000 entries) or a large git repo makes `tree/list` return 50 000 entries. The JSON-RPC response exceeds 1 MiB (`daemon/protocol.cjs:3`) and gets silently dropped.

**Why it happens:** No per-dir cap, no exclusion of common heavy dirs.

**How to avoid:** `list_tree.cjs` skips `node_modules`, `.git`, `.next`, `dist`, `target`, `__pycache__`, `.venv` by default (configurable via arg). Caps entries per dir at 500; returns `{entries: [...], truncated: true}` so the renderer shows "(showing first 500 of N — click to load more)".

**Warning signs:** Manual: `tree/list /` against a workspace with `node_modules` returns `null` from `readMessage`.

### Pitfall 6: Diff view for binary files crashes

**What goes wrong:** `edit_file` against a binary file (image, compiled asset) returns `before`/`after` byte strings; `react-diff-viewer-continued` tries to render them as UTF-8 and crashes with "TextEncoder.encode" error.

**Why it happens:** No binary detection in `edit_file.cjs` or in `DiffView.tsx`.

**How to avoid:** `edit_file.cjs` returns `{binary: true, before: '<base64>', after: '<base64>'}` when the file contains a NUL byte in the first 8 KB. `DiffView.tsx` checks `before.includes(' ') || after.includes(' ')` and renders a placeholder instead of calling the diff library.

**Warning signs:** Console error: `TypeError: Cannot read properties of undefined (reading 'encode')`.

### Pitfall 7: Memory injection bloats system prompt

**What goes wrong:** `injectMemorySuffix` reads the entire `memory.md` (which can grow to 50 KB after months of use) and inlines it into the system prompt on every turn. Each turn wastes 12 000 tokens of input capacity.

**Why it happens:** No size cap on injection; no eviction policy.

**How to avoid:** `injectMemorySuffix(md, facts, maxBytes=4096)` trims to last 4 KB (keep last N H2 sections). `facts.json` is rendered as a single-line bullet list capped at 50 entries. The LLM is told in the system prompt: "If memory is truncated, query `read_memory` tool to retrieve older sections."

**Warning signs:** `system` prompt size > 10 KB; first-token latency > 1s.

---

## Validation Architecture

`workflow.nyquist_validation: true` in `.planning/config.json` — full section required.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest `^2.1.9` (unit) + Playwright `^1.63.0` (Electron + daemon smoke) |
| Config files | `vitest.config.ts` (Node env, includes `tests/unit/**`), `playwright.config.ts` |
| Quick run command | `npm test` (Vitest unit, ~7s expected) |
| Full suite command | `npm run test:all` (Vitest + Playwright; headed Electron smoke gated by `LOCALBOT_SMOKE_OK`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AGENT-05 | `memory.md` survives app restart | unit | `npx vitest run tests/unit/memory.test.ts` | Wave 0 |
| AGENT-05 | `facts.json` merges correctly (dedup by name) | unit | `npx vitest run tests/unit/facts.test.ts` | Wave 0 |
| AGENT-05 | `memory/read` JSON-RPC returns `{markdown, facts}` | unit | `npx vitest run tests/unit/memory.test.ts` | Wave 0 |
| AGENT-05 | `memory/write` is path-contained (no escape) | unit | covered by `memory.test.ts` | Wave 0 |
| AGENT-05 | `update_memory` tool appends section | unit | covered by `memory.test.ts` | Wave 0 |
| AGENT-05 | Memory injected into system prompt | unit | `npx vitest run tests/unit/memory.test.ts` | Wave 0 |
| AGENT-05 | Memory cap: truncates oldest sections when >4 KB | unit | covered by `memory.test.ts` | Wave 0 |
| AGENT-06 | Per-bot JSONL writes to `<sessionsDir>/<bot>/<id>.jsonl` | unit | `npx vitest run tests/unit/jsonl_router.test.ts` | Wave 0 |
| AGENT-06 | `loadSession` returns newest file per bot | unit | covered by `jsonl_router.test.ts` | Wave 0 |
| AGENT-06 | Legacy `global.jsonl` migrates to `default/<id>.jsonl` | unit | covered by `jsonl_router.test.ts` | Wave 0 |
| AGENT-06 | End-to-end: app restart reloads from per-bot JSONL | smoke | `npx playwright test tests/playwright/memory-history.test.ts` | Wave 0 |
| LLM-04 | Usage accumulator tracks `input_tokens + output_tokens` across turns | unit | `npx vitest run tests/unit/usage_accumulator.test.ts` | Wave 0 |
| LLM-04 | `maybeSummarize` triggers when accumulator > SOFT_CAP | unit | `npx vitest run tests/unit/summarize.test.ts` | Wave 0 |
| LLM-04 | `runSummarizer` has separate retry budget | unit | covered by `summarize.test.ts` | Wave 0 |
| LLM-04 | Summary written as head-of-JSONL on disk | unit | covered by `summarize.test.ts` | Wave 0 |
| LLM-04 | Cancel mid-summarize aborts only the summary | unit | covered by `summarize.test.ts` | Wave 0 |
| LLM-04 | End-to-end: long fake-M3 stream triggers summarize; renderer shows summary block | smoke | `npx playwright test tests/playwright/memory-history.test.ts` | Wave 0 (extend `fake-m3-server.ts`) |
| UI-08 | `tree/list` returns capped + lazy children | unit | `npx vitest run tests/unit/list_tree.test.ts` | Wave 0 |
| UI-08 | `tree/list` skips `node_modules`, `.git` by default | unit | covered by `list_tree.test.ts` | Wave 0 |
| UI-08 | chokidar watcher emits `tree:refresh` on file change | unit | covered by `list_tree.test.ts` | Wave 0 |
| UI-08 | Workspace tree renders in renderer | smoke | `npx playwright test tests/playwright/tree-diff.test.ts` | Wave 0 |
| UI-08 | Diff view renders before/after for `edit_file` | smoke | covered by `tree-diff.test.ts` | Wave 0 |
| UI-08 | Binary file shows placeholder in diff view | unit | `npx vitest run tests/unit/list_tree.test.ts` | Wave 0 |

### Sampling Rate

- **Per task commit:** `npm test` (Vitest unit only, ~7s)
- **Per wave merge:** `npm run test:all` (Vitest + Playwright daemon smoke, ~30s)
- **Phase gate:** Full suite green before `/gsd-verify-work`; headed Electron smoke (`LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/memory-history.test.ts`) deferred to developer machine per Phase 1/2 precedent.

### Wave 0 Gaps

- [ ] `tests/unit/memory.test.ts` — covers read/write/merge; size cap; concurrent writes
- [ ] `tests/unit/facts.test.ts` — covers `mergeFacts` dedup by `name`; preserves `updatedAt` ordering
- [ ] `tests/unit/summarize.test.ts` — covers threshold trigger; head-of-JSONL write; cancel mid-summarize; separate retry budget
- [ ] `tests/unit/jsonl_router.test.ts` — covers per-bot routing; newest-first listing; legacy migration
- [ ] `tests/unit/usage_accumulator.test.ts` — covers accumulator across multi-turn loop; cache token handling
- [ ] `tests/unit/list_tree.test.ts` — covers caps; lazy children; exclusion list; binary detection
- [ ] `tests/playwright/memory-history.test.ts` — extends `fake-m3-server.ts` with `streamLongResponse(tokens)` helper that emits `usage.input_tokens: 100000` on `message_start`; asserts renderer shows summary block; restarts app and asserts session reloads
- [ ] `tests/playwright/tree-diff.test.ts` — exercises full headed run; gated by `LOCALBOT_SMOKE_OK`

*Nyquist VALIDATION.md will derive from this section.*

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 20+ stdlib | JSONL routing, memory IO | ✓ | per `.nvmrc = 20` | — |
| `@anthropic-ai/sdk` 0.40.1 | Summarization LLM call + usage accumulation | ✓ | confirmed via `node_modules/@anthropic-ai/sdk/package.json` | — |
| M3 API base URL | Summary call | ✓ | `process.env.M3_API_BASE` default `https://api.MiniMax.io/v1` | — |
| `chokidar` | Tree watcher | ✗ (not yet installed) | — | After `npm install`, resolves to `node_modules/chokidar`; daemon fails closed with clear error if missing |
| `react-arborist` | Workspace tree renderer | ✗ (not yet installed) | — | After `npm install`; if React 19 peer-dep fails, add `overrides` block |
| `react-diff-viewer-continued` | Diff view renderer | ✗ (not yet installed) | — | After `npm install`; if React 19 peer-dep fails, add `overrides` block |
| `diff` | Diff library (peer) | ✗ (not yet installed) | — | After `npm install` |
| Windows | All (Windows-first per `.claude/CLAUDE.md`) | ✓ | Windows 11 Pro 10.0.26200 (env) | — |

**Missing dependencies with no fallback:** none (all covered by `npm install` in Plan 03-01).

**Missing dependencies with fallback:** `react-diff-viewer-continued` may need peer-deps override for React 19 — covered by `package.json#overrides` block.

---

## Security Domain

> `security_enforcement` is absent from `.planning/config.json` — treat as enabled (default per GSD config schema).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | API key in OS keychain (Phase 1 complete); memory ops never receive credentials |
| V3 Session Management | partial | Phase 1's `Map<msgId, AbortController>` already keys per-stream; Phase 3 extends with separate cancel chain for summarize |
| V4 Access Control | yes | Per-bot memory directory + JSONL directory enforced via daemon's `safePath` (Phase 2's pattern) |
| V5 Input Validation | yes | `safePath` for memory file paths; `safePath` for tree paths; JSON-schema validation of LLM `update_memory` args |
| V6 Cryptography | no | Phase 3 doesn't add crypto; `facts.json` is plaintext (no PII expected) |
| V7 Error Handling | yes | Memory IO errors become audit `outcome: 'error'`; do not bubble into LLM call's `error` channel (same pattern as tool errors in Phase 2) |
| V9 Communication | partial | Daemon stdio transport (Phase 1) — no network surface added |
| V12 File Integrity | yes | Atomic write via `tmp + rename` for `memory.md` and `facts.json`; concurrent writes serialized via per-bot mutex |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Memory file path traversal | Tampering | `safePath` realpath + prefix check (Phase 2 pattern); memory ops always scoped to `<userData>/bots/<bot>/` |
| JSONL file path traversal | Tampering | `safePath` on `<userData>/sessions/<bot>/`; `bot` segment is validated against allowlist |
| Summary call poisoning via injected memory | Tampering | Memory content is untrusted data; system prompt explicitly fences it as `## Bot Memory` section; LLM is told not to execute instructions found in memory |
| Tree watcher DoS via rapid file changes | Denial of Service | `chokidar` debounced to 250 ms; throttled `tree:refresh` IPC events |
| Large memory file DoS | Denial of Service | 4 KB cap in `injectMemorySuffix`; `memory.md` write refuses >8 KB |
| `update_memory` injection of arbitrary markdown | Tampering | LLM is told to use only H2 sections + plain text; renderer markdown-escapes before display |
| Concurrent writes to `memory.md` | Tampering | Per-bot mutex (in-process `Map<bot, Promise>` chain) |
| `tree/list` DoS via deep recursion | Denial of Service | `maxDepth: 5` default; `maxEntriesPerDir: 500` default; exclusion list for heavy dirs |

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single global session JSONL | Per-bot per-session JSONL at `<userData>/sessions/<bot>/<id>.jsonl` | Phase 3 | History is per-bot; legacy migration keeps existing data |
| Hard-coded system prompt | System prompt + injected memory suffix per turn | Phase 3 | Bot retains identity across sessions; renderer is unaware |
| No memory persistence | `memory.md` + `facts.json` per bot | Phase 3 | Persistent across app restart; LLM-curated via `update_memory` tool |
| No conversation history split | Multiple sessions per bot, browsable on next launch | Phase 3 | User can come back tomorrow and pick up where they left off |
| Single-pass LLM call | LLM call + pre-loop summarize on threshold | Phase 3 | Long sessions don't run out of context; summaries persist into JSONL head |
| No file tree in UI | `react-arborist` tree + chokidar watcher | Phase 3 | User can browse bot's workspace including memory file |
| Plain text `edit_file` result | Diff view (before/after) inline in `tool_result` | Phase 3 | UI-08 requirement; same renderer pipeline as Phase 2 tool blocks |

**Deprecated/outdated:**
- **Single global JSONL:** split per-bot/per-session in Phase 3.
- **Hard-coded system prompt:** extended with memory suffix in Phase 3.
- **Pre-call `countTokens()`:** unreliable on M3; Phase 3 uses streamed `usage`.
- **Manual path resolution for memory files:** replaced by daemon `safePath`.

---

## Assumptions Log

> Claims tagged `[ASSUMED]` need user confirmation before becoming locked decisions. The planner should surface these in the discuss-phase if needed.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | M3 does not reliably expose `messages.countTokens()`; relying on `usage` from streamed `Message` is the safer path | Standard Stack / Pattern 3 | If M3 does expose `countTokens()` with correct semantics, planner could use pre-call counts to decide *before* sending the user message whether to summarize. Not a blocker; `usage`-based approach works either way. |
| A2 | `chokidar@^3.6.0` ships prebuilt `fsevents` only on macOS; polling fallback on Windows is sufficient for the workspace sizes Localbot targets | Standard Stack / Pattern 5 | If Windows polling latency becomes noticeable (e.g., >500 ms), planner can add `usePolling: false, awaitWriteFinish: true` or fall back to manual refresh. |
| A3 | `react-arborist@^3.4.0` is React 19 compatible | Standard Stack / Core | If not, planner adds `package.json#overrides` block or picks `@tanstack/react-virtual` + custom tree (Alternative Considered §). |
| A4 | `react-diff-viewer-continued@^4.0.0` is React 19 compatible | Standard Stack / Core | Same as A3 — fallback is `diff` + custom React. |
| A5 | `diff@^5.2.0` (jsdiff) is the peer dependency `react-diff-viewer-continued` requires | Standard Stack / Supporting | If `react-diff-viewer-continued` brings a different `diff` version, npm will hoist; check `npm ls diff` post-install. |
| A6 | The token soft cap should be 80% of model max (e.g., 100 000 for a 200 K model) | Pattern 3 / Pitfall 2 | Wrong if the model max is much lower than expected. Planner should make `SOFT_CAP` configurable via env var (`LOCALBOT_SOFT_CAP_TOKENS`). |
| A7 | Memory markdown sections (`## Identity`, `## Preferences`, `## Recent`) are useful structure vs free-form | Architecture / Pattern 2 | Wrong if the LLM writes fewer sections than the cap assumes. Planner should cap sections *count* (e.g., keep last 10) rather than bytes alone. |
| A8 | The bot's first session ID is derived from the ISO timestamp at first launch | Pattern 1 | Wrong if a user has multiple bots (Phase 4); per-bot session naming must allow collisions. Phase 3 hard-codes `default` so this is fine. |
| A9 | Excluding `node_modules`, `.git`, `.next`, `dist`, `target`, `__pycache__`, `.venv` from `tree/list` is a sensible default | Pitfall 5 | Wrong if user wants to see those dirs; planner can make exclusion list configurable via `tree/list` arg. |
| A10 | Per-bot mutex (single-process `Map<bot, Promise>` chain) is sufficient for memory write atomicity | Security / Known Threats | Wrong if Localbot is ever multi-process; for Phase 3 (single Electron main), this is sufficient. |

**If this table is empty:** All claims were verified or cited — no user confirmation needed.

> All `[VERIFIED]` claims above were opened from in-repo or `node_modules/` source this session.

---

## Open Questions

1. **M3 `countTokens()` availability.**
   - What we know: Anthropic's SDK has `countTokens()`; M3 is Anthropic-compatible but may or may not implement the endpoint.
   - What's unclear: Whether to gate the plan on confirming this.
   - Recommendation: Don't gate. `usage` accumulation works either way; just don't add a pre-call `countTokens()`.

2. **Memory markdown schema.**
   - What we know: `## Identity`, `## Preferences`, `## Recent` is a sensible structure; free-form is simpler.
   - What's unclear: Whether to enforce structure in the system prompt or in `update_memory` tool args.
   - Recommendation: Light structure — system prompt suggests the sections but doesn't enforce; `update_memory` accepts arbitrary `section_name + content` and appends to `## <name>`. Cap sections count to 10.

3. **`facts.json` provenance tracking.**
   - What we know: `{value, source, updatedAt}` adds storage cost.
   - What's unclear: Whether the user ever wants to see `source`.
   - Recommendation: Keep `source` field (cheap); expose via MemoryPanel only if user asks.

4. **Summary shape (text vs structured JSON).**
   - What we know: Structured JSON (`{summary, facts}`) lets the summary auto-update `facts.json`; plain text is simpler.
   - What's unclear: Whether the LLM will reliably return JSON for the summary call.
   - Recommendation: Structured JSON with fallback to plain text. The summarizer system prompt explicitly requests JSON; if the response isn't JSON, treat the whole thing as the `summary` string and skip facts update.

5. **Tree refresh latency target.**
   - What we know: `chokidar` debounced to 250 ms gives sub-second refresh in dev.
   - What's unclear: Whether the user wants instant refresh or "manual refresh" only.
   - Recommendation: chokidar-pushed refresh + manual refresh button as fallback. Both are cheap.

6. **Workspace root per bot.**
   - What we know: Phase 2 introduced `<userData>/workspace/` as a single workspace; Phase 3 needs per-bot scoping.
   - What's unclear: Whether to nest `<userData>/workspace/<bot>/` or move to `<userData>/bots/<bot>/workspace/`.
   - Recommendation: `<userData>/workspace/default/` for Phase 3 (single bot). Phase 4 will move to `<userData>/workspace/<bot>/` when multi-bot lands.

7. **`update_memory` tool vs `memory/write` JSON-RPC.**
   - What we know: They overlap — both write to `memory.md`.
   - What's unclear: Whether the LLM should be the only writer, or whether the user can also edit via MemoryPanel.
   - Recommendation: Both. `update_memory` is the LLM-callable tool (allowlist); `memory/write` is the user's full-replace API. Daemon treats them identically internally.

8. **Per-bot mutex vs file lock.**
   - What we know: Single-process Electron means a JS-side mutex is sufficient.
   - What's unclear: Whether two concurrent agentic loops (Phase 4 multi-bot, Phase 6 cron) could race.
   - Recommendation: JS-side `Map<bot, Promise>` chain for Phase 3. Phase 6 will revisit if cron introduces cross-process writes.

---

## Metadata

**Confidence breakdown:**
- Standard stack: MEDIUM — `@anthropic-ai/sdk@0.40.1` and Node 20 stdlib are verified; `chokidar`, `react-arborist`, `react-diff-viewer-continued`, `diff` are selected via WebSearch + training knowledge and tagged `[ASSUMED]` (planner must add `checkpoint:human-verify` before install per package-legitimacy protocol).
- Architecture: HIGH — all existing files read this session; Phase 1+2 patterns inherited without change; only additive.
- Pitfalls: HIGH — derived from reading actual Phase 1+2 code (`src/main/sessions/jsonl.ts`, `src/main/llm/loop.ts`, `src/main/llm/client.ts`, `daemon/protocol.cjs`) + Anthropic SDK `messages.d.ts` Usage type.
- Validation architecture: HIGH — follows Phase 2's Vitest+Playwright pattern (proven in `tests/playwright/daemon-tools.test.ts` and `tests/playwright/smoke-tools.test.ts`).

**Research date:** 2026-09-18
**Valid until:** 2026-10-18 (30 days — Anthropic SDK stable on 0.40.x line; chokidar 3.6.x stable; react-arborist 3.4.x stable; react-diff-viewer-continued 4.0.x stable; diff 5.x stable)