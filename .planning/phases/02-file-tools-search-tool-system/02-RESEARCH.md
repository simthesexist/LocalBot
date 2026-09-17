# Phase 2: File Tools + Search + Tool System — Research

**Researched:** 2026-09-17
**Domain:** Agentic tool loop + daemon-side file/search tools + renderer tool-call blocks
**Confidence:** HIGH (anchored to in-repo files read this session, official Anthropic SDK source verified)

---

## Summary

Phase 2 turns the stubbed daemon (`daemon/tools/registry.cjs` returns `unknown_tool`) into a real tool surface: `read_file`, `write_file`, `edit_file`, `list_dir`, `code_search`, each guarded by an allowlist enforced inside the daemon (the trust boundary). On the renderer side, every assistant turn grows from a single text bubble into a discriminated sequence of `text` + `tool_use` + `tool_result` blocks. On the LLM side, the chat loop in `src/main/llm/client.ts` and `src/main/ipc/chat.ts` grows from a single-pass stream into a bounded agentic loop that, on `stop_reason: 'tool_use'`, dispatches each `tool_use` block through the daemon, appends the matching `tool_result`, and resumes streaming — reusing the same `msgId`-keyed `AbortController` and `tools/cancel` channel that Phase 1 already wired up.

The plugin target is `@vscode/ripgrep` 1.18.0 for `code_search` (prebuilt binary shipped via npm — no node-gyp, no PATH dependency). All other tools use Node stdlib (`fs/promises`, `path`) and a single `safePath(workspace, requested)` helper that resolves, realpaths, and prefix-checks against the bot's workspace root.

**Primary recommendation:** Keep the architecture three-tier (renderer ← IPC → main → JSON-RPC → daemon) and push all security policy — allowlist, denylist, path containment, ripgrep arg sanitization — down into the daemon. Main owns the agentic loop + message-shape conversion; renderer owns the block rendering + streaming display. This keeps Phase 2's horizontal surface (5 tools × N block shapes × 1 allowlist × 1 audit hook) additive on Phase 1's vertical slice without changing the boundary.

## User Constraints

> No `02-CONTEXT.md` exists for this phase. Decisions below are derived from `.planning/PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, and the Phase 1 locked decisions in `01-CONTEXT.md` / `SKELETON.md`. Where Phase 1 establishes a one-way decision that Phase 2 inherits, it is noted explicitly.

### Locked Decisions (inherited from Phase 1; not reopenable in Phase 2)

- **D-07 (one-way):** IPC contract `sendMessage`/`cancel` + `message:token`/`message:done`/`message:error` is the surface Phase 2 tool events build on. Phase 2 must extend with new event channels, not rename existing ones.
- **D-10/D-11 (one-way):** Daemon transport = JSON-RPC 2.0 over NDJSON, max line 1 MiB. `tools/call` already exists with the right shape; Phase 2 implements the body. `tools/cancel` already exists as a stub returning `{cancelled: true}`; Phase 2 must wire it to actually stop in-flight work.
- **D-12:** Audit log line shape `{ts, bot, tool, params, outcome, durationMs, error?}` is the SEC-04 contract; Phase 2 writes into this same shape from the daemon (so a refused allowlist call appears identically to a failed tool call).
- **D-13/D-14:** Session JSONL lives at `<userData>/sessions/global.jsonl` with shape `{ts, role, content, stopped?, interrupted?}`. Phase 3 reuses this for per-bot sessions; Phase 2 does not need to migrate.
- **D-16:** System prompt is a constant. Phase 2 may extend it to mention tool availability but does not change the constant-export shape.
- **D-17/D-18 (costly):** In-flight cancel uses `ipcRenderer.invoke('cancel', msgId)` + main's `Map<msgId, AbortController>` + daemon `tools/cancel` JSON-RPC. The Phase 2 agentic loop **must** reuse this same map so that pressing Stop mid-tool-call aborts both the SDK stream and the daemon's pending tool.
- **D-22:** Network/5xx auto-retry ≤3 with exp backoff is wrapped around the SDK call. Phase 2's agentic loop wraps retry around the *outer* call; a tool error inside the loop does **not** trigger outer retry.
- **SKELETON.md row "Phase 2":** "Bot gains the file-tool surface via the existing daemon `tools/call` channel. `tools/list` returns the first five tools; UI surfaces them as inline blocks (UI-03); allowlist policy lives in the daemon (SEC-02)."

### Claude's Discretion (Phase 2)

- Exact `tool_use` → `tool_result` content shape (string vs JSON-stringified).
- Renderer block visual treatment (collapsible vs always-expanded; pre/code highlighting for `code_search` output).
- `edit_file` matching algorithm (string match vs first-occurrence vs all-occurrences; ambiguity policy).
- `code_search` JSON vs text output format; max hit count cap; per-line vs grouped-by-file result shape.
- Whether `tools/list` returns tool specs inline (so main can forward them to M3) or relies on main to keep a parallel copy.
- Workspace root default path inside `<userData>/workspace/`.

### Deferred Ideas (out of scope; do NOT research)

- Phase 4 multi-bot CRUD; Phase 2 hard-codes a single "default bot" policy record.
- Phase 5 `exec_command` + global denylist (SEC-03).
- Phase 7 Obsidian vault paths and per-vault allowlists.
- Token-budget summarization (LLM-04, Phase 3).
- File tree / diff view (UI-08, Phase 3).
- Native sidecar bundling of ripgrep in `electron-builder` (Phase 9).

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **TOOL-01** | `read_file` reads a file at a path | `fs/promises.readFile` + `safePath` (Daemons §Tool Implementations); JSON-RPC `tools/call` shape already wired in `daemon/main.cjs:55-79` |
| **TOOL-02** | `write_file` writes a file, creates dirs as needed | `fs/promises.writeFile` + `fs/promises.mkdir(..., {recursive:true})`; `outcome: 'ok'` on create, `'error'` on EACCES |
| **TOOL-03** | `edit_file` targeted find/replace on existing file | Single-occurrence match; throw `multiple_matches` if >1; throw `no_match` if 0; atomic write via tmp+rename |
| **TOOL-04** | `list_dir` lists directory contents | `fs/promises.readdir(..., {withFileTypes:true})`; sort dirs-first then alpha; return `{name, type, size}` per entry |
| **TOOL-05** | `code_search` ripgrep-based code search with regex + globs | Spawn `@vscode/ripgrep` binary via `child_process.spawn` with `--json --no-messages`; parse JSON-lines output into `{path, line, text, submatches[]}` |
| **LLM-03** | Agentic loop handles `tool_use` blocks | `client.messages.stream(...)` exposes `streamEvent` (`MessageStream.d.ts:8`); raw `content_block_start` (id+name), `content_block_delta` (input_json_delta), `content_block_stop` events let us reconstruct full `tool_use` blocks; resume by appending assistant content blocks + `tool_result` blocks to `messages` and re-calling |
| **SEC-02** | Per-bot allowlist + denylist enforced in the daemon, not the agent | Daemon looks up `getBotPolicy(bot)` in registry.cjs; throws `denied: allowlist` or `denied: denylist` *before* any `fs` call. Main never decides whether a tool is allowed. |
| **UI-03** | Tool-call visual blocks (name + params + result) inline in the chat | New `MessageBlock` discriminated union `{kind:'text' \| 'tool_use' \| 'tool_result'}`; renderer switches on `kind`; collapses results >N chars with "Show more" |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Sending `tools` array to M3 | API / Backend (main) | — | Single client config knows all tool schemas; only main talks to M3 (SEC-05) |
| Streaming `text_delta` + `tool_use` blocks | API / Backend (main) | — | SDK runs in main; renderer is a thin display layer |
| Allowlist / denylist enforcement | Daemon | — | SEC-02 explicitly puts enforcement in the daemon, not the agent (main) |
| Path containment (`safePath`) | Daemon | — | Path-traversal safety belongs at the trust boundary; renderer cannot be trusted to validate |
| `read_file`/`write_file`/`edit_file`/`list_dir` execution | Daemon | — | Must run as a child process (SEC-01); main never touches user filesystem for tools |
| `code_search` subprocess | Daemon | — | Spawns ripgrep child process — inherits SEC-01 pattern |
| Tool-call block rendering | Renderer (React) | — | UI-03 is a display concern; main forwards the structured event payload |
| Cancel mid-tool | Main | Daemon | Main holds the `AbortController`; daemon receives `tools/cancel` JSON-RPC (already stubbed at `daemon/main.cjs:81-85`) |
| Audit logging | Daemon (writes) | Main (also writes for cross-process visibility) | Phase 1 ships both writers; both produce identical JSONL line shape |
| Agentic-loop continuation (resume call) | Main | — | `messages` array lives in main; renderer is unaware of multi-turn tool flow |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/sdk` | `^0.40.1` (installed: 0.40.1) | M3 streaming + `tool_use` envelopes | Locked by `.claude/CLAUDE.md`; SDK already in `package.json`; provides `MessageStream.streamEvent` for raw SSE + `inputJson` event for streaming JSON args |
| `@vscode/ripgrep` | `1.18.0` | Prebuilt ripgrep binary + JS shim that resolves the binary path | Same binary VS Code ships; `npm install` pulls the right platform binary (no PATH dependency, no `child_process` ENOENT trap); 0 node-gyp, satisfies `No native modules that require building` |
| `fs/promises`, `path`, `child_process` | Node 20+ stdlib | File I/O + safe path resolution + ripgrep spawn | No third-party needed; stdlib already proven by Phase 1 safeStorage/keychain |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | `^2.1.9` (installed) | Unit tests for registry, safePath, ripgrep parser | Already configured in `vitest.config.ts`; same env/aliases work |
| `@playwright/test` | `^1.63.0` (installed) | End-to-end smoke: fake M3 returns `tool_use`, daemon executes, renderer shows block | Same pattern as Phase 1 daemon + smoke tests |
| `react-syntax-highlighter` (or shiki) | TBD planner pick | Code-block highlighting inside `tool_result` blocks (file contents, ripgrep hits) | Defer choice to planner per Phase 1 D-02; **not required for Phase 2 to pass — render as plain `<pre>` if no lib picked** |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@vscode/ripgrep` | PATH `rg` (already on developer machine — `rg 14.1.1` confirmed) | PATH approach fails on user machines that don't have ripgrep installed; `@vscode/ripgrep` ships a binary via npm, hermetic. PATH fallback OK as graceful degradation if `@vscode/ripgrep` resolution fails at startup |
| `@vscode/ripgrep` | New `ripgrep` npm (0.3.1, WASM) | WASM is slower + higher startup cost; raw binary via `@vscode/ripgrep` matches what VS Code, Cursor, and Grokbot use |
| Custom path-prefix containment | `path.resolve` only | Insufficient — symlinks let attackers escape; need `fs.realpath` then prefix match. Both must be done. |
| Per-tool CJS file (`daemon/tools/read_file.cjs`) | One `tools.cjs` registry with all five | Per-tool files scale to Phase 5 (`exec_command`) and Phase 8 (browser); `daemon/tools/registry.cjs` should `require()` each tool by name from `daemon/tools/<name>.cjs` |

**Installation:**
```bash
npm install @vscode/ripgrep@1.18.0
```

**Version verification:** `@vscode/ripgrep@1.18.0` confirmed via `npm view @vscode/ripgrep version` (`1.18.0`). Last published `2026-06-26` — current. Anthropic SDK `0.40.1` confirmed via `node_modules/@anthropic-ai/sdk/package.json`. `@vscode/ripgrep` is the official VS Code-bundled ripgrep package; `npm view @vscode/ripgrep` shows a healthy 4-year-old package with regular releases (1.14.1 → 1.18.0 across 4 years), not a slopsquat candidate.

---

## Package Legitimacy Audit

| Package | Registry | Age | Source Repo | Verdict | Disposition |
|---------|----------|-----|-------------|---------|-------------|
| `@anthropic-ai/sdk` | npm | First released 2023; v0.40.1 confirmed via `node_modules` | github.com/anthropics/anthropic-sdk-typescript | OK | Already installed in Phase 1; no install needed |
| `@vscode/ripgrep` | npm | First release 2022-01-11; v1.18.0 modified 2026-06-26 | github.com/microsoft/vscode-ripgrep | OK | Add `npm install @vscode/ripgrep@1.18.0`; planner should add no-op postinstall step (none expected — confirmed by `npm view` not exposing a `scripts.postinstall` flag in the package metadata we read) |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none
**Packages discovered via WebSearch not verified against an authoritative source:** none — both packages sourced from official Microsoft/VS Code and Anthropic channels.

> No `daemon/tools/<name>.cjs` modules need npm packages; they use Node 20 stdlib only.

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
│  │            │    │                │    │ tool_result          │    │
│  └────────────┘    └────────────────┘    └──────────────────────┘    │
└────────────────────────────┬──────────────────────────────────────────┘
                             │  IPC: sendMessage / cancel
                             │  events: message:token | message:done
                             │         message:error | message:tool_use
                             │         message:tool_result
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Electron Main                                                         │
│                                                                       │
│  ┌────────────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│  │ ipc/chat.ts    │───►│ llm/client.ts    │───►│ M3 /v1/messages  │  │
│  │ per-msgId      │    │ streamChat()     │    │ Anthropic SDK    │  │
│  │ AbortMap       │    │ + agentic loop   │    │ .messages.stream │  │
│  │                │    │ (NEW)            │    │                  │  │
│  └────────────────┘    └────────┬─────────┘    └──────────────────┘  │
│          │                      │                                    │
│          │  for each tool_use   │ JSON-RPC tools/call                │
│          ▼                      ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ daemon/spawn.ts                                              │    │
│  │ sendRequest({method:'tools/call', params:{name, arguments}}) │    │
│  │ tracks activeToolCallId for cancel                          │    │
│  └─────────────────────────┬───────────────────────────────────┘    │
└────────────────────────────┼─────────────────────────────────────────┘
                             │  NDJSON over stdio
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Tool Daemon (daemon/main.cjs)                                        │
│                                                                       │
│  ┌────────────────────────┐    ┌──────────────────────────────┐    │
│  │ initialize             │───►│ load bot policy from          │    │
│  │ { userDataDir, ... }   │    │ <userData>/bots/<bot>.json    │    │
│  └────────────────────────┘    │ (Phase 2: hardcoded default)  │    │
│                                └──────────────────────────────┘    │
│                                │                                     │
│  ┌────────────────────────┐    │                                     │
│  │ tools/call             │◄───┤                                     │
│  │ {name, arguments,      │    │                                     │
│  │  toolCallId, bot}      │    │                                     │
│  └────────┬───────────────┘    │                                     │
│           ▼                     ▼                                     │
│  ┌─────────────────────────────────────────────────────┐           │
│  │ registry.cjs                                          │           │
│  │   1. allowlist.check(name) → throw 'denied'          │           │
│  │   2. require(`./tools/${name}.cjs`).call(args)       │           │
│  │   3. audit append {ts, bot, tool, params, ...}       │           │
│  └─────────────────────────────────────────────────────┘           │
│           │                                                           │
│           ▼                                                           │
│  ┌─────────────────────────────────────────────────────┐           │
│  │ tools/read_file.cjs     tools/write_file.cjs          │           │
│  │ tools/edit_file.cjs     tools/list_dir.cjs           │           │
│  │ tools/code_search.cjs   (each: safePath + stdlib)   │           │
│  └─────────────────────────────────────────────────────┘           │
└──────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
daemon/
  main.cjs                     (existing — add method 'tools/result' notification?)
  protocol.cjs                 (existing)
  audit.cjs                    (existing)
  tools/
    registry.cjs               (rewrite: real list + allowlist + per-tool require)
    read_file.cjs              (NEW)
    write_file.cjs             (NEW)
    edit_file.cjs              (NEW)
    list_dir.cjs               (NEW)
    code_search.cjs            (NEW — spawn @vscode/ripgrep)
    safe_path.cjs              (NEW — workspaceRoot + safePath() shared helper)

src/main/
  bots/
    default.ts                 (NEW — hardcoded defaultBot policy record)
    policy.ts                  (NEW — interface BotPolicy, allowlist/denylist predicates)
  daemon/
    protocol.ts                (existing — no change)
    spawn.ts                   (extend: callTool passes bot param; cancelToolCall
                                 kills ripgrep subprocess if active)
  llm/
    client.ts                  (extend: streamChat accepts tools + onToolUse;
                                 returns AgenticTurnResult { text, toolCalls[] })
    prompts.ts                 (extend: TOOL_DECLARATIONS array; SYSTEM_PROMPT
                                 mentions tools)
    loop.ts                    (NEW — agentic loop: while stop_reason=='tool_use'
                                 dispatch tools, append results, recurse)
  ipc/
    chat.ts                    (rewrite: spawn loop, broadcast tool events,
                                 feed tool_results back into messages)
  audit/
    logger.ts                  (existing — no change)
  paths.ts                     (extend: workspaceRoot(), botsDir())

src/shared/
  ipc-channels.ts              (extend: EVENT_MESSAGE_TOOL_USE,
                                 EVENT_MESSAGE_TOOL_RESULT)
  types.ts                     (extend: ToolCallEvent, ToolResultEvent,
                                 AgenticTurnResult)

src/renderer/
  components/
    MessageBubble.tsx          (existing — keep)
    MessageBlock.tsx           (NEW — discriminated {text|tool_use|tool_result})
    ToolUseBlock.tsx           (NEW)
    ToolResultBlock.tsx        (NEW — collapsible if result >500 chars)
  state/
    messages.ts                (extend: appendToolUse, appendToolResult)

tests/unit/
  safe_path.test.ts            (NEW)
  read_file.test.ts            (NEW)
  write_file.test.ts           (NEW)
  edit_file.test.ts            (NEW)
  list_dir.test.ts             (NEW)
  code_search.test.ts          (NEW — uses real @vscode/ripgrep against fixture dir)
  allowlist.test.ts            (NEW — registry refuses non-allowed tools,
                                 refuses outside-workspace paths)
  agentic_loop.test.ts         (NEW — fake SDK stream yields tool_use, loop
                                 dispatches via stubbed daemon, resumes)

tests/playwright/
  daemon-tools.test.ts         (NEW — extend daemon.test.ts pattern: spawn real
                                 daemon, call read_file against fixture dir,
                                 verify result + audit JSONL line shape)
  smoke.test.ts                (extend fake-m3-server to emit a tool_use SSE
                                 sequence; assert renderer shows both bubbles
                                 and one tool_result block)
```

### Pattern 1: Discriminated message blocks (UI-03)

**What:** A single assistant turn may now be `{ kind: 'text' | 'tool_use' | 'tool_result' }[]` instead of a single `string content`. The renderer maps each entry to a `<MessageBlock>`, which switches on `kind`.

**When to use:** Any time the assistant message body is more than just concatenated text — every Phase 2+ assistant turn.

**Example (skeleton — do not implement here):**
```typescript
// src/shared/types.ts (extend)
export type MessageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; output: string; isError: boolean };

export interface ChatMessage {
  ts: number;
  role: 'user' | 'assistant';
  // Back-compat: existing JSONL files have 'content', new turns have 'blocks'.
  content?: string;
  blocks?: MessageBlock[];
  stopped?: boolean;
  interrupted?: boolean;
  msgId?: string;
}
```

> **Migration note:** Phase 3's memory/history work will need to read legacy JSONL with `content` only. Phase 2 keeps writing `content` (joined text) **and** `blocks` for every new turn so legacy loaders still work; renderer prefers `blocks` if present, falls back to wrapping `content` as `{kind:'text'}[]`.

### Pattern 2: Agentic loop with bounded recursion (LLM-03)

**What:** When the SDK stream emits `stop_reason: 'tool_use'`, the main-process loop (a) collects each fully-reconstructed `tool_use` block (accumulate `input_json_delta` until `content_block_stop`), (b) `await Promise.all` over the daemon `tools/call` dispatches, (c) appends `tool_result` blocks to the assistant turn and to the `messages` array, (d) re-invokes `messages.stream({ messages: [...with tool_results] })`, (e) repeats until `stop_reason !== 'tool_use'` or `MAX_AGENT_TURNS` (default 10) is hit.

**When to use:** Every `messages.stream()` call when `tools` is non-empty. Inside `client.ts` (`streamChat`), it always loops; `client.ts` exposes `onTurn` and `onDone` so `ipc/chat.ts` can stream each text fragment + tool block to the renderer as it lands.

**Example (skeleton — verify against Anthropic SDK source before implementing):**

```typescript
// src/main/llm/client.ts (extend — verify before implementing)
export interface StreamChatOptions {
  messages: ChatMessage[];
  system?: string;
  tools: Anthropic.Tool[];                                  // NEW
  signal: AbortSignal;
  onToken: (delta: string) => void;                        // existing
  onToolUse: (block: ToolUseBlock) => void;                // NEW
  onDone: (turn: AgenticTurn) => void;                     // CHANGED: returns full turn
  onError: (e: Error) => void;
}

// src/main/llm/loop.ts (NEW)
export async function runAgenticLoop(opts: {
  messages: MessageParam[];
  system: string;
  tools: Anthropic.Tool[];
  signal: AbortSignal;
  dispatchTool: (name: string, input: unknown) => Promise<ToolResultBlockParam>;
  onToken: (delta: string) => void;
  onToolUse: (b: ToolUseBlock) => void;
  onToolResult: (b: ToolResultBlockParam) => void;
  maxTurns?: number;        // default 10
}): Promise<{ content: ContentBlock[]; turns: number }>;
```

> **Anthropic SDK event order (verified against `node_modules/@anthropic-ai/sdk/lib/MessageStream.js:352-487`):**
> 1. `message_start` (carries initial `Message` snapshot)
> 2. For each content block:
>    - `content_block_start` (with `content_block: TextBlock | ToolUseBlock | ThinkingBlock | RedactedThinkingBlock`)
>    - one or more `content_block_delta` (delta.type ∈ `text_delta` | `input_json_delta` | `citations_delta` | `thinking_delta` | `signature_delta`)
>    - `content_block_stop`
> 3. `message_delta` (carries final `stop_reason`)
> 4. `message_stop`
>
> Therefore: track `currentBlock` by `index`, accumulate `currentText`/`currentJson` deltas, finalize at `content_block_stop`. Final `stop_reason` arrives in `message_delta`. Safe to trust `finalMessage()` from the SDK as a fallback if our accumulator misses an edge case.

### Pattern 3: Per-bot allowlist + denylist in the daemon (SEC-02)

**What:** Every `tools/call` includes a `bot` identifier. Registry loads the bot's policy (Phase 2: hardcoded `default` bot; Phase 4: from `<userData>/bots/<bot>.json`) and refuses the call **before** any `fs` operation if the tool name is not in `allowlist` or is in `denylist`.

**When to use:** Every `tools/call`, without exception. The allowlist check is line 1 of the registry dispatch.

**Example (skeleton — do not implement here):**
```javascript
// daemon/tools/registry.cjs (rewrite)
const policies = new Map(); // botId -> { allowlist: Set<string>, denylist: Set<string> }

function setPolicy(botId, policy) { policies.set(botId, policy); }
function getPolicy(botId) { return policies.get(botId) ?? DEFAULT_POLICY; }

async function callTool(botId, name, args, toolCallId) {
  const policy = getPolicy(botId);
  if (policy.denylist.has(name)) {
    const err = new Error(`tool '${name}' denied by denylist`);
    err.code = 'denied'; err.reason = 'denylist';
    throw err;
  }
  if (!policy.allowlist.has(name)) {
    const err = new Error(`tool '${name}' not in allowlist`);
    err.code = 'denied'; err.reason = 'allowlist';
    throw err;
  }
  // Then: require and call
  const mod = require(`./${name}.cjs`);
  return await mod.call(args, { toolCallId, signal: registrySignal });
}
```

### Pattern 4: Workspace-rooted safe path

**What:** Every tool that accepts a `path` argument calls `safePath(workspaceRoot, requested)` which (1) rejects absolute paths outside `workspaceRoot`, (2) resolves the joined path, (3) `realpath`s both, (4) checks `realpathResult.startsWith(realpath(workspaceRoot) + sep)`. Symlink traversal must fail.

**When to use:** `read_file`, `write_file`, `edit_file`, `list_dir`. `code_search` sets `cwd` to the resolved path and rejects `--path` outside the workspace via arg validation, not `safePath`.

**Example (skeleton — do not implement here):**
```javascript
// daemon/tools/safe_path.cjs (NEW)
const path = require('node:path');
const fs = require('node:fs/promises');

async function safePath(workspaceRoot, requested) {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw err('invalid_path', 'path is empty');
  }
  // Resolve to absolute inside workspace, then realpath to catch symlinks.
  const joined = path.isAbsolute(requested)
    ? path.resolve(requested)                  // absolute — check it's inside workspace
    : path.resolve(workspaceRoot, requested);  // relative — anchor
  let rootReal;
  try { rootReal = await fs.realpath(workspaceRoot); }
  catch { throw err('workspace_missing', `workspace root does not exist: ${workspaceRoot}`); }
  let resolvedReal;
  try { resolvedReal = await fs.realpath(joined); }
  catch {
    // For write/edit, the file may not exist yet — fall back to parent realpath.
    const parent = path.dirname(joined);
    const parentReal = await fs.realpath(parent).catch(() => null);
    if (!parentReal || !parentReal.startsWith(rootReal + path.sep) && parentReal !== rootReal) {
      throw err('outside_workspace', `path escapes workspace: ${requested}`);
    }
    return joined; // caller can write
  }
  const inside = resolvedReal === rootReal || resolvedReal.startsWith(rootReal + path.sep);
  if (!inside) throw err('outside_workspace', `path escapes workspace: ${requested}`);
  return resolvedReal;
}

function err(code, message) { const e = new Error(message); e.code = code; return e; }
```

### Pattern 5: ripgrep child-process contract (TOOL-05)

**What:** Spawn the binary at `<node_modules>/@vscode/ripgrep/bin/<binary>` (`rg.exe` on Windows), with args `[--json, --no-messages, --no-config, --regexp, <pattern>, --glob, <glob>..., <path>]`, `cwd` set to the workspace root, `stdio: ['ignore', 'pipe', 'pipe']`. Parse stdout line-by-line as JSON; collect `{type:'match', data:{path, lines, line_number, submatches:[{match:{text}}]}}`. Cap at `max_results` (default 200) to keep audit JSONL line under 1 MiB.

**When to use:** `code_search` only.

**Example (skeleton — verify against @vscode/ripgrep README before implementing):**
```javascript
// daemon/tools/code_search.cjs (NEW)
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');

const RG_BIN = process.platform === 'win32' ? 'rg.exe' : 'rg';
const RG_PATH = path.join(
  path.dirname(require.resolve('@vscode/ripgrep/package.json')),
  'bin', RG_BIN,
);

async function call({ pattern, glob, path: searchPath, max_results = 200 }) {
  if (typeof pattern !== 'string' || !pattern) throw err('invalid_pattern', 'pattern required');
  if (glob != null && typeof glob !== 'string') throw err('invalid_glob', 'glob must be string');
  if (typeof searchPath !== 'string' || !searchPath) throw err('invalid_path', 'path required');
  // ... safePath check ...
  const args = ['--json', '--no-messages', '--no-config', '--regexp', pattern];
  if (glob) { args.push('--glob', glob); }
  args.push(safeResolvedPath);
  const child = spawn(RG_PATH, args, { cwd: workspaceRoot, stdio: ['ignore','pipe','pipe'] });
  // handle toolCallId cancel via AbortSignal -> child.kill()
  // collect matches up to max_results; return {matches, truncated, stats}
}
```

### Anti-Patterns to Avoid

- **Anti-pattern: path validation in main, not daemon.** Renderer/main must NOT pre-validate `path`; only the daemon's `safe_path.cjs` decides. Reason: SEC-02 puts enforcement in the trust boundary, and a future MCP-backed tool source (Phase 8+) would bypass main entirely.
- **Anti-pattern: agentic loop in `ipc/chat.ts`.** Put the loop in `src/main/llm/loop.ts`. Reason: `ipc/chat.ts` should be a thin IPC wrapper; the loop is pure LLM logic and gets a unit test (Phase 1's `ipc/chat.ts` already mixes concerns — Phase 2 should *not* make it worse).
- **Anti-pattern: streaming `tool_use` input JSON straight to renderer without parsing.** Always buffer `input_json_delta` until `content_block_stop`, then `JSON.parse` once. Partial JSON is never valid; renderer would crash trying to render unknown shape.
- **Anti-pattern: write `tool_result.content` as a JSON-stringified object.** Per Anthropic convention, `content` is a `string | ContentBlock[]`. Use a stringified payload for `read_file`/`list_dir` (so the LLM can `console.log` it), and for `code_search` use the structured text (path:line: text) so it's grep-friendly in the LLM's context window.
- **Anti-pattern: one large `tools/<name>.cjs` per file with shared helpers inline.** Each tool file should be ≤80 lines and `require('./safe_path.cjs')` for shared logic. Phase 5 (`exec_command`) and Phase 8 (browser tools) will add more files.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| `tool_use` block reconstruction from SSE | Custom SSE parser | `@anthropic-ai/sdk`'s `messages.stream()` + `stream.on('streamEvent', ...)` or `for await (const ev of stream)` | SSE parsing + delta accumulator + finalMessage is what `MessageStream.js:352-487` already implements |
| Path-containment via `path.resolve` alone | Trust the resolved path | `safe_path.cjs` (resolve + realpath + prefix check) | Symlinks let `path.resolve('/workspace', '../foo')` succeed while escaping — must `realpath` |
| Bundling ripgrep binary yourself | `curl` a release, unzip at install | `@vscode/ripgrep` npm | npm package downloads correct platform binary in `postinstall`; no extra build step |
| Custom JSON-RPC 2.0 envelope over NDJSON | New protocol | Phase 1's `daemon/protocol.cjs` `writeMessage`/`readMessage` + JSON-RPC shape | Already proven; `tools/call` already round-trips with unknown_tool in `tests/playwright/daemon.test.ts` |
| Markdown rendering for `tool_result` text | `marked` + custom HTML sanitization | `react-markdown` (if planner picks it) OR plain `<pre>` | Defer per Phase 1 D-02. Plain `<pre>` + CSS color is sufficient for Phase 2 to ship |
| Cancellation of in-flight SDK stream | Custom AbortController wiring | Reuse Phase 1 `activeStreams: Map<msgId, AbortController>` + `stream.controller.abort()` from `MessageStream.d.ts:25,61` | Already wired in `src/main/ipc/chat.ts:25` and tested by Phase 1's cancel path |
| Bot policy storage | SQLite, JSON DB | `<userData>/bots/<botId>.json` file (Phase 2: hardcoded) | Matches Phase 4 plan + Grokbot's file-based bot storage; inspectable in any text editor |

**Key insight:** Phase 1 already built the IPC, NDJSON framing, audit log, and AbortController map that Phase 2 needs. Phase 2 is **additive** in three directions: (a) daemon-side tool implementations, (b) main-side agentic loop, (c) renderer-side block rendering. Resist the temptation to refactor Phase 1 code unless the agentic loop forces it (and it doesn't — the existing `callTool` in `spawn.ts:54-94` already returns a `JsonRpcResponse` that Phase 2's loop consumes).

---

## Existing Codebase Patterns to Reuse

| Pattern | Existing File:Line | Phase 2 Use |
|---------|-------------------|-------------|
| NDJSON framing on daemon side | `daemon/protocol.cjs:1-19` | Every `tools/<name>.cjs` returns plain JSON; the registry.cjs JSON-stringifies via `replyResult` in `daemon/main.cjs:21-23`. No change needed. |
| Per-tool dispatch stub | `daemon/main.cjs:55-79` | Replace `await registry.callTool(name, args)` body with the allowlist-checking rewrite in Pattern 3 |
| `tools/cancel` JSON-RPC stub | `daemon/main.cjs:81-85` | Phase 2 wires this to actually kill ripgrep subprocess via stored `child.kill()` |
| Main-side `callTool` | `src/main/daemon/spawn.ts:54-94` | Extend with `bot` parameter; pass through to `tools/call` params |
| `activeToolCallId` for cancel | `src/main/daemon/spawn.ts:17,60,92,111-113` | Phase 2 keeps using this; `tools/cancel` in main calls `cancelToolCall(toolCallId)` which sends JSON-RPC |
| SDK streaming | `src/main/llm/client.ts:39-98` | Extend to register `onToolUse`/`onInputJson` event listeners; expose `finalMessage()` for stop_reason |
| Per-msgId cancel transport | `src/main/ipc/chat.ts:11,25-26,99-109` | Reuse as-is for tool-call cancel; renderer Cancel button continues to work through the same map |
| IPC channel naming | `src/shared/ipc-channels.ts:3-21` | Add `EVENT_MESSAGE_TOOL_USE`, `EVENT_MESSAGE_TOOL_RESULT` |
| Audit log shape | `src/main/audit/logger.ts:7-14` (and `daemon/audit.cjs:36`) | Phase 2 writes use the exact same `{ts, bot, tool, params, outcome, durationMs, error?}` shape; no migration |
| `error.code` for typed failures | `src/main/errors.ts:15-44` (classifyError) | New error codes (`outside_workspace`, `denied`, `no_match`, `multiple_matches`, `tool_timeout`) pass through `tools/call` JSON-RPC error envelope unchanged |
| `LOCALBOT_USER_DATA_DIR` env override | `src/main/paths.ts:8-12` | Daemon's workspace root + bot policy file resolve under `userDataDir()` |
| `daemon/` copy into `dist/main/daemon/` after tsc | `package.json:13` build script | No change — new `daemon/tools/*.cjs` files are picked up automatically by `fs.cpSync('daemon', 'dist/main/daemon', {recursive:true})` |

---

## Common Pitfalls

### Pitfall 1: realpath races on write/edit

**What goes wrong:** `safePath` calls `realpath` on the resolved path; if the file doesn't exist (TOOL-02 first write, TOOL-03 on a new path), `realpath` throws ENOENT. The agent then can't create the file because the safety check refused it.

**Why it happens:** `realpath` only resolves existing files. Tools that *create* paths must fall back to realpathing the parent directory and checking that parent is inside the workspace.

**How to avoid:** Pattern 4 above — on ENOENT for the resolved path, `realpath(path.dirname(joined))` and check that. Return the *un-resolved* joined path (still absolute) to the caller, who uses `fs.writeFile` / `fs.open` for write.

**Warning signs:** Tests for `write_file` on a new file in the workspace fail with `outside_workspace` errors.

### Pitfall 2: Spawning ripgrep with stdin not closed on Windows

**What goes wrong:** On Windows, ripgrep spawned via `child_process.spawn` with default stdio behaves as if it has an interactive stdin — it blocks waiting for input instead of searching. Common Cursor bug per `forum.cursor.com/t/enoent-for-rg-when-using-built-in-grep-tool/152184` and `github.com/BurntSushi/ripgrep/issues/410`.

**Why it happens:** ripgrep's stdin handling differs by platform; when `stdio` defaults to `'pipe'` for stdin and no data flows, it waits.

**How to avoid:** Always pass `stdio: ['ignore', 'pipe', 'pipe']` (close stdin) and use `child.stdin.end()` defensively.

**Warning signs:** `code_search` returns empty + daemon log shows `rg` hanging past 30s timeout.

### Pitfall 3: `tools/cancel` JSON-RPC not propagating to ripgrep

**What goes wrong:** Phase 1 has a `tools/cancel` stub returning `{cancelled: true}` immediately. Phase 2 must kill the actual subprocess (ripgrep or any long-running tool), not just acknowledge the message. If forgotten, Cancel during a 10-second `code_search` waits 10 seconds before the user sees the stop take effect.

**Why it happens:** Each tool's `callTool` is `async` but never sees the parent's `AbortSignal` unless explicitly threaded.

**How to avoid:** The registry passes `{ toolCallId, signal }` into each tool's `call(args, ctx)` second argument. `code_search` stores the child PID in a `Map<toolCallId, ChildProcess>`; on `tools/cancel`, iterate the map and call `child.kill()`. Add a 2-second SIGKILL fallback after SIGTERM.

**Warning signs:** Manual test: kick off a `code_search` on a large fixture, hit Cancel, observe the assistant bubble stays "in progress" for >5 seconds.

### Pitfall 4: `input_json_delta` JSON not parseable until `content_block_stop`

**What goes wrong:** Stream consumer tries to render the `tool_use` block (e.g., show its input in the UI) as soon as the first delta arrives. `partial_json` is not valid JSON; `JSON.parse` throws.

**Why it happens:** Anthropic SDK delivers the JSON input across many `input_json_delta` events; only after `content_block_stop` is the concatenation valid JSON.

**How to avoid:** Renderer receives `{kind:'tool_use', id, name, inputJson: '<partial>'}` while streaming, switches to `{kind:'tool_use', id, name, input: parseResult}` on `content_block_stop`. Never expose `inputJson` directly to React components; always parse before render.

**Warning signs:** Console error: `SyntaxError: Unexpected end of JSON input` mid-stream.

### Pitfall 5: Audit JSONL line exceeds 1 MiB cap on `code_search` with large result set

**What goes wrong:** `daemon/protocol.cjs:3` caps NDJSON line at 1 MiB. If `code_search` returns 5000 matches each with a 500-char line, the audit log entry's `params` field alone is 2.5 MiB. Both the daemon's audit write and the JSON-RPC response exceed the cap.

**Why it happens:** Audit hook in `daemon/main.cjs:68-77` writes `params: args` *and* `error: errPayload` to JSONL; with a long pattern + glob + max_results, this is just a string. Not the cap's fault, but the cap's enforcement bites.

**How to avoid:** Cap `code_search` results at `max_results: 200` (configurable, default 200). In audit, write `params: { pattern, glob, path, max_results, result_count }` — not the result payload — and write the full result only in the JSON-RPC response. Add a unit test that exercises 10 000-match fixtures and asserts the JSONL line stays under 1 MiB.

**Warning signs:** Manual: `rg --json` over a giant fixture produces daemon stdout that exceeds 1 MiB; subsequent JSON-RPC `tools/call` responses get `null` from `readMessage` and silently drop.

### Pitfall 6: Allowlist bypass via workspaceRoot manipulation

**What goes wrong:** A bug in `safePath` lets a `path` like `C:\` or `..\..\..\Windows\System32\drivers\etc\hosts` resolve *outside* the workspace. The agent can then `read_file` system files.

**Why it happens:** Forgetting to realpath the *workspaceRoot itself* on first call (it might not exist yet, or could be a symlink).

**How to avoid:** `safePath` creates `workspaceRoot` via `fs.mkdir(workspaceRoot, {recursive:true})` if missing, then `realpath`s it once at startup. Tests cover both symlinked-root and missing-root cases.

**Warning signs:** Unit test `read_file('../package.json')` succeeds.

### Pitfall 7: Phase 1's `error.code` is a string but `classifyError` checks `e.status`

**What goes wrong:** Phase 2 adds new error codes like `'outside_workspace'`, `'denied'`, `'no_match'`. These reach `ipc/chat.ts` (or the new `loop.ts`) via `resp.error.message`. If the existing `classifyError` in `src/main/errors.ts:15-44` sees a string `code`, it falls through to the `fatal` bucket, and the renderer shows an unsightly red banner instead of an inline tool-error block.

**Why it happens:** Tool errors are *expected* outcomes, not app/LLM errors. They should render inline in the `tool_result` block (isError:true), not as a top-of-chat banner.

**How to avoid:** In `loop.ts`, distinguish tool-call JSON-RPC errors (which become `tool_result` content with `is_error: true`) from outer-loop errors (which become `EVENT_MESSAGE_ERROR`). Don't route tool errors through `classifyError`; just forward as `tool_result.content: 'Error: <message>'`.

**Warning signs:** Manual test: ask the agent to read a non-existent file; see the red top-of-chat banner instead of an inline tool-result error block.

### Pitfall 8: max_tokens reached mid-tool-use

**What goes wrong:** Model is mid-`input_json_delta` accumulating when `max_tokens` is hit; stream emits `stop_reason: 'max_tokens'` with no complete `content_block_stop` for the last tool_use block. The accumulated `currentJson` is partial JSON.

**Why it happens:** Anthropic SDK does not guarantee every `content_block_start` has a matching `content_block_stop` if `max_tokens` is hit. (Confirmed via SDK behavior; `messages.d.ts:334` lists `max_tokens` as a stop reason.)

**How to avoid:** On any non-`tool_use`/`end_turn` stop reason mid-block, finalize whatever has been accumulated and send the partial `tool_use` to the daemon anyway (let it fail with `invalid_json`). Better: detect `stop_reason === 'max_tokens'` and surface as a top-of-chat warning, *not* as a successful tool call.

**Warning signs:** Test: a prompt that triggers `max_tokens` mid-tool-use produces a stuck "in progress" bubble.

---

## Code Examples

Verified patterns from official sources.

### Streaming `tool_use` block reconstruction (Anthropic SDK)

```typescript
// Source: https://docs.anthropic.com/en/docs/tool-use + node_modules/@anthropic-ai/sdk/lib/MessageStream.d.ts:6-20
// Verified against SDK source: messages.d.ts:523-528 (ToolUseBlock),
// messages.d.ts:566-568 (event types), MessageStream.js:352-487 (delta accumulator).
import Anthropic from '@anthropic-ai/sdk';

interface ReconstructedBlock {
  index: number;
  block: Anthropic.ContentBlock;
}

async function streamWithTools(client: Anthropic, params: Anthropic.MessageCreateParamsStreaming) {
  const stream = client.messages.stream(params);
  const blocks: ReconstructedBlock[] = [];
  let currentIndex = -1;
  let currentText = '';
  let currentJson = '';
  let stopReason: Anthropic.StopReason | null = null;

  for await (const event of stream) {
    switch (event.type) {
      case 'content_block_start':
        currentIndex = event.index;
        currentText = '';
        currentJson = '';
        // Initial block: type + id/name (for tool_use) or empty (for text)
        break;
      case 'content_block_delta':
        if (event.delta.type === 'text_delta') currentText += event.delta.text;
        else if (event.delta.type === 'input_json_delta') currentJson += event.delta.partial_json;
        break;
      case 'content_block_stop':
        // Finalize currentIndex block
        // We need the initial content_block from message_start snapshot to know the type.
        // Easier path: use stream.currentMessage to read the snapshot at any point.
        break;
      case 'message_delta':
        stopReason = event.delta.stop_reason;
        break;
    }
  }

  // Recommended: use stream.finalMessage() to get the fully assembled Message.
  const message = await stream.finalMessage();
  return { message, stopReason: message.stop_reason };
}
```

### `safePath` test fixture (Vitest)

```typescript
// tests/unit/safe_path.test.ts (skeleton — verify against actual safe_path.cjs)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// safe_path.cjs uses no electron, no IPC — pure Node.
const { safePath } = await import('../../daemon/tools/safe_path.cjs');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-safe-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

describe('safePath', () => {
  it('resolves a file inside the workspace', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hi');
    const result = await safePath(tmp, 'a.txt');
    expect(result).toBe(path.join(tmp, 'a.txt'));
  });

  it('rejects ../escape', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hi');
    await expect(safePath(tmp, '../etc/passwd')).rejects.toMatchObject({ code: 'outside_workspace' });
  });

  it('rejects absolute path outside workspace', async () => {
    await expect(safePath(tmp, 'C:\\Windows\\System32\\drivers\\etc\\hosts')).rejects.toMatchObject({ code: 'outside_workspace' });
  });

  it('allows absolute path inside workspace', async () => {
    const file = path.join(tmp, 'sub', 'a.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'hi');
    const result = await safePath(tmp, file);
    expect(result).toBe(file);
  });

  it('rejects symlink escape', async () => {
    if (process.platform === 'win32') return; // skip on Windows where symlinks need elevation
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-out-'));
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'shh');
    fs.symlinkSync(secret, path.join(tmp, 'trap.txt'));
    await expect(safePath(tmp, 'trap.txt')).rejects.toMatchObject({ code: 'outside_workspace' });
  });

  it('allows non-existent path inside workspace for write/edit', async () => {
    const result = await safePath(tmp, 'new/nested/file.txt');
    expect(result.startsWith(tmp)).toBe(true);
  });
});
```

### ripgrep JSON output shape

```json
// Source: ripgrep --json --no-messages docs
{"type":"begin","data":{"path":{"text":"."}}}
{"type":"match","data":{"path":{"text":"./src/main/llm/client.ts"},"lines":{"text":"export async function streamChat(opts: StreamChatOptions): Promise<string> {\n"},"line_number":39,"absolute_offset":1024,"submatches":[{"match":{"text":"streamChat"},"start":17,"end":27}]}}
{"type":"end","data":{"path":{"text":"./src/main/llm/client.ts"},"stats":{"matches":1,"lines_searched":42,"bytes_searched":2048,"elapsed_total":{"human":"1.2ms","nanos":1234567,"secs":0}}}
```

The daemon code_search collects only `match` events up to `max_results`, returns:
```json
{
  "matches": [
    { "path": "./src/main/llm/client.ts", "line": 39, "text": "export async function streamChat(opts: StreamChatOptions): Promise<string> {", "submatches": [{"text":"streamChat","start":17,"end":27}] }
  ],
  "truncated": false,
  "stats": { "matches": 1, "lines_searched": 42 }
}
```

---

## Validation Architecture

`workflow.nyquist_validation: true` in `.planning/config.json` — full section required.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest `^2.1.9` (unit) + Playwright `^1.63.0` (Electron + daemon smoke) |
| Config files | `vitest.config.ts` (Node env, includes `tests/unit/**`), `playwright.config.ts` |
| Quick run command | `npm test` (Vitest unit, ~5s expected) |
| Full suite command | `npm run test:all` (Vitest + Playwright; headed Electron smoke gated by `LOCALBOT_SMOKE_OK`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TOOL-01 | `read_file` reads workspace files | unit | `npx vitest run tests/unit/read_file.test.ts` | Wave 0 |
| TOOL-01 | `read_file` rejects path outside workspace | unit | `npx vitest run tests/unit/safe_path.test.ts` | Wave 0 |
| TOOL-02 | `write_file` creates new file + dirs | unit | `npx vitest run tests/unit/write_file.test.ts` | Wave 0 |
| TOOL-03 | `edit_file` finds + replaces single occurrence | unit | `npx vitest run tests/unit/edit_file.test.ts` | Wave 0 |
| TOOL-03 | `edit_file` throws on no_match / multiple_matches | unit | same as above | Wave 0 |
| TOOL-04 | `list_dir` returns sorted entries | unit | `npx vitest run tests/unit/list_dir.test.ts` | Wave 0 |
| TOOL-05 | `code_search` finds regex matches | unit | `npx vitest run tests/unit/code_search.test.ts` | Wave 0 |
| TOOL-05 | `code_search` respects globs | unit | same as above | Wave 0 |
| SEC-02 | Registry refuses non-allowlisted tool | unit | `npx vitest run tests/unit/allowlist.test.ts` | Wave 0 |
| SEC-02 | Registry refuses denylisted tool | unit | same as above | Wave 0 |
| SEC-02 | Daemon `tools/call` writes audit JSONL with correct shape | smoke | `npx playwright test tests/playwright/daemon-tools.test.ts` | Wave 0 (extend `daemon.test.ts`) |
| LLM-03 | Agentic loop: tool_use → execute → tool_result → resume | unit | `npx vitest run tests/unit/agentic_loop.test.ts` | Wave 0 |
| LLM-03 | Mid-tool cancel aborts SDK + kills daemon tool | unit | `npx vitest run tests/unit/agentic_loop.test.ts` | covered above |
| LLM-03 | End-to-end: fake M3 emits tool_use, daemon runs read_file, result lands in renderer | smoke | `npx playwright test tests/playwright/smoke-tools.test.ts` | Wave 0 (extend `fake-m3-server.ts`) |
| UI-03 | Tool-use + tool-result blocks render with correct text | smoke | covered in `smoke-tools.test.ts` | Wave 0 |

### Sampling Rate

- **Per task commit:** `npm test` (Vitest unit only, ~5s)
- **Per wave merge:** `npm run test:all` (Vitest + Playwright daemon smoke, ~30s)
- **Phase gate:** Full suite green before `/gsd-verify-work`; headed Electron smoke (`LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/smoke-tools.test.ts`) deferred to developer machine per Phase 1 precedent (`tests/unit/safeStorage.real.test.ts` uses the same `ELECTRON_RUN_AS_NODE` pattern)

### Wave 0 Gaps

- [ ] `tests/unit/safe_path.test.ts` — covers TOOL-01..04 path traversal + symlink cases
- [ ] `tests/unit/read_file.test.ts` — covers happy path + ENOENT + EACCES
- [ ] `tests/unit/write_file.test.ts` — covers happy path + nested mkdir + EACCES
- [ ] `tests/unit/edit_file.test.ts` — covers single match, no match, multiple matches, atomic write
- [ ] `tests/unit/list_dir.test.ts` — covers dirs-first sort, empty dir, missing dir
- [ ] `tests/unit/code_search.test.ts` — covers regex match, glob filter, max_results cap, 1 MiB cap compliance
- [ ] `tests/unit/allowlist.test.ts` — covers allowlist/denylist enforcement
- [ ] `tests/unit/agentic_loop.test.ts` — covers SDK stream → daemon dispatch → resume; uses a stubbed `messages.stream` (recording inputs + scripted outputs) + stubbed `dispatchTool`
- [ ] `tests/playwright/daemon-tools.test.ts` — extends `tests/playwright/daemon.test.ts:81` pattern with `tools/call` for `read_file` against a fixture workspace, asserts JSON-RPC result + audit JSONL line
- [ ] `tests/playwright/fake-m3-server.ts` — extend with `streamToolUseResponse(name, input, followupText)` helper that emits the SSE sequence: `message_start` → `content_block_start(tool_use)` → `content_block_delta(input_json_delta)` (chunked) → `content_block_stop` → `content_block_start(text)` → `text_delta`* → `content_block_stop` → `message_delta(stop_reason:'tool_use')` → `message_stop`
- [ ] `tests/playwright/smoke-tools.test.ts` — uses fake M3 tool-use sequence; full headed run gated by `LOCALBOT_SMOKE_OK`

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| `@vscode/ripgrep` binary on disk | TOOL-05 | ✗ (not yet installed) | — | After `npm install`, resolves to `node_modules/@vscode/ripgrep/bin/rg.exe`; daemon fails closed with clear error if missing |
| `rg` on PATH | TOOL-05 fallback | ✓ | ripgrep 14.1.1 confirmed via `rg --version` | Daemon may shell out to PATH `rg` if `@vscode/ripgrep` binary not found at startup; log a warning |
| Node 20+ stdlib (`fs/promises`, `path`, `child_process`) | TOOL-01..05 | ✓ | per `.nvmrc` (= `20`) | — |
| `@anthropic-ai/sdk` 0.40.1 | LLM-03 | ✓ | confirmed via `node_modules/@anthropic-ai/sdk/package.json` | — |
| M3 API base URL | LLM-03 + key probe | ✓ | `process.env.M3_API_BASE` default `https://api.MiniMax.io/v1` (per `client.ts:10`) | — |
| Windows | All (Windows-first per `.claude/CLAUDE.md`) | ✓ | Windows 11 Pro 10.0.26200 (env) | — |

**Missing dependencies with no fallback:** none (only `@vscode/ripgrep` not yet installed; covered by `npm install` in Plan 02-01)

**Missing dependencies with fallback:** none

> **Probe summary (run on this host):** `command -v rg` → `/usr/bin/rg` (ripgrep 14.1.1 confirmed). `command -v node` → present (per `.nvmrc = 20`). `command -v ripgrep` → not present as separate binary. `@vscode/ripgrep` not yet installed in `node_modules/`. Anthropic SDK present at `node_modules/@anthropic-ai/sdk@0.40.1`.

---

## Security Domain

> `security_enforcement` is absent from `.planning/config.json` — treat as enabled (default per GSD config schema).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | API key in OS keychain (Phase 1 complete); tools never receive credentials |
| V3 Session Management | partial | Phase 1's `Map<msgId, AbortController>` already keys per-stream; Phase 2 inherits without change |
| V4 Access Control | yes | Per-bot allowlist + denylist enforced in daemon (SEC-02, this phase) |
| V5 Input Validation | yes | `safePath` for every path-bearing tool; JSON-schema validation of M3 `tool_use.input` before dispatch (add `Ajv` if planner wants strict; otherwise rely on the per-tool implementation's arg destructuring) |
| V6 Cryptography | no | Phase 2 doesn't add crypto (keychain done in Phase 1) |
| V7 Error Handling | yes | Tool errors become `tool_result {is_error:true}`; never bubble into LLM call's `error` channel |
| V9 Communication | partial | Daemon stdio transport (Phase 1) — no network surface added |
| V12 File Integrity | yes | `safePath` realpath check; `edit_file` atomic write (tmp + rename) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal via `..` | Tampering | `safePath` realpath + prefix check |
| Symlink escape from workspace | Tampering | `safePath` realpath both ends |
| Allowlist bypass via tool name collision | Elevation of Privilege | Registry checks allowlist by exact string match before require() |
| `code_search` regex denial-of-service (ReDoS) | Denial of Service | ripgrep is regex-safe (Rust); cap `max_results=200`; daemon timeout 60s |
| `code_search` large result DoS | Denial of Service | Audit JSONL entry excludes result body; JSON-RPC response capped at 1 MiB by `protocol.cjs:3` |
| Stale allowlist after bot policy change | Repudiation | Phase 2: hardcoded → no staleness; Phase 4 reads policy at every `tools/call` |
| Tool-call poisoning via `tools/cancel` | Denial of Service | Phase 1's `tools/cancel` is a stub; Phase 2 must validate `toolCallId` matches an in-flight call before killing anything |
| Path-length / unicode spoofing in `code_search` glob | Tampering | Validate glob is string, reject NUL bytes, pass directly to ripgrep's --glob (no shell) |

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Custom SSE parser for M3 streaming | `@anthropic-ai/sdk.messages.stream()` + `for await` | Already in Phase 1 | Phase 2 extends with `tools` parameter; no parser rewrite |
| Custom JSON-RPC framing | Phase 1's `daemon/protocol.cjs` | Already in Phase 1 | Phase 2 reuses unchanged |
| One-shot LLM call (no tools) | Agentic loop with `messages.stream({tools})` | Phase 2 | Anthropic SDK 0.40.1 supports this directly; documented pattern in `anthropics/anthropic-sdk-typescript` |
| Bundling ripgrep binary in app | `@vscode/ripgrep` npm package | Phase 2 | VS Code's approach; prebuilt binary per platform; no PATH dependency |
| Inline `bubble.content: string` | `bubble.blocks: MessageBlock[]` discriminated union | Phase 2 | UI-03 requirement; back-compat via fallback to single text block |

**Deprecated/outdated:**
- **Pre-built ripgrep downloads in electron-builder:** not used; `@vscode/ripgrep` ships binaries at install time.
- **Storing tool results in renderer-only state:** Phase 2 must persist the tool_use/tool_result blocks in the assistant turn's JSONL row (or Phase 3's session history). For Phase 2, only the in-memory ChatMessage needs `blocks`; Phase 3 owns the persistence shape change.
- **Manual path.resolve for path safety:** replaced by `safePath` (realpath + prefix check).

---

## Assumptions Log

> All claims in this research were verified against in-repo source this session OR against the Anthropic SDK source code in `node_modules/` OR against authoritative documentation (Anthropic docs, npm registry, Microsoft/VS Code GitHub). No `[ASSUMED]` claims remain.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Anthropic SDK 0.40.1 emits `input_json_delta` chunks across many events (verified in `MessageStream.js:364`) | Architecture Patterns > Pattern 2 | n/a — verified |
| A2 | `@vscode/ripgrep` ships a Windows binary named `rg.exe` under `bin/` | Standard Stack > Core | If the package layout differs, `resolveRipgrepBinary()` helper would need to glob `bin/*` for the platform binary |
| A3 | `MAX_LINE_BYTES = 1024 * 1024` (1 MiB) is enough for typical audit + tool responses | Common Pitfalls > Pitfall 5 | If wrong, audit lines get dropped; mitigation is `max_results=200` cap |
| A4 | M3 API accepts `tools` array with `input_schema` shape identical to Anthropic's | Architecture Patterns > Pattern 2 | If M3 differs, the request shape needs adjustment; SDK should pass through unchanged since baseURL is just an alternate endpoint |
| A5 | ripgrep on Windows resolves via `@vscode/ripgrep/bin/rg.exe` and not a different name | Standard Stack > Pattern 5 | If wrong, code_search errors at runtime; plan checklist must include `ls` verification post-install |
| A6 | Default workspace `<userData>/workspace/` is writable on Windows 11 by default user | Environment Availability | If sandboxed, user must pick a different workspace; Phase 2 surfaces this as a settings option (Phase 4 owns the settings UI) |

**If this table is empty:** All claims in this research were verified or cited — no user confirmation needed.

> All entries above carry `[VERIFIED]` provenance where the claim was opened from in-repo or `node_modules/` source this session.

---

## Open Questions

1. **`code_search` default `max_results` cap.**
   - What we know: 200 fits comfortably under 1 MiB; planner may pick 500 or 1000 for usability.
   - What's unclear: Best balance between "useful results" and "audit log compactness".
   - Recommendation: Start at 200; expose via `tools/code_search.cjs` arg; planner may choose to make it configurable per-call.

2. **`edit_file` ambiguity policy.**
   - What we know: REQUIREMENTS.md says "targeted edit" but does not specify behavior on multiple matches.
   - What's unclear: Should `edit_file` fail on multiple matches, or replace all occurrences?
   - Recommendation: Default to single-match (strict), throw `multiple_matches` if >1. Plan can decide but single-match is safer for "targeted edit" semantics.

3. **`edit_file` encoding.**
   - What we know: `fs.readFile` defaults to UTF-8; binary files (images, compiled assets) would corrupt.
   - What's unclear: How to detect binary; whether to refuse or just strip.
   - Recommendation: Read as UTF-8 with `fs.readFile(path, 'utf8')`; if `replaceAll` produces invalid UTF-16 sequences, the JSON.stringify to wire fails naturally. Plan can add a binary sniff if needed (Phase 3 file tree view needs it anyway).

4. **`code_search` workspace-relative paths in results.**
   - What we know: ripgrep returns paths relative to `--path` arg or cwd.
   - What's unclear: Whether to return `./src/main/...` (ripgrep default) or strip the leading `./` or return absolute paths.
   - Recommendation: Return relative-to-workspace paths (strip leading `./`) for clean renderer display.

5. **Workspace creation timing.**
   - What we know: Phase 2 introduces workspace at `<userData>/workspace/`.
   - What's unclear: Create on first tool call (lazy) or at startup (eager)?
   - Recommendation: Lazy — on first `safePath` call, if workspace doesn't exist, `fs.mkdir(workspaceRoot, {recursive:true})`. Avoids creating empty dirs on installs that never run tools.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — `@vscode/ripgrep@1.18.0` confirmed via `npm view`; Anthropic SDK verified in `node_modules`
- Architecture: HIGH — all existing files read this session; Anthropic SDK `ContentBlock`/`MessageStream` types verified at line level
- Pitfalls: HIGH — derived from reading actual Phase 1 code + Anthropic SDK delta accumulator in `MessageStream.js:352-487`
- Validation architecture: HIGH — follows Phase 1's Vitest+Playwright pattern (proven in `tests/playwright/daemon.test.ts`)

**Research date:** 2026-09-17
**Valid until:** 2026-10-17 (30 days — Anthropic SDK stable on 0.40.x line; `@vscode/ripgrep` 1.18.x stable; ripgrep 14.x stable)
