# Phase 1: Skeleton + Streaming Chat - Context

**Gathered:** 2026-09-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver a runnable Electron desktop app where the user can chat with the MiniMax M3 API and watch tokens stream back in real time, with the API key in the OS-level keychain and a separate tool-daemon child process stubbed in place (even though zero tools exist yet). This phase ships the chat shell + IPC plumbing + audit-log scaffolding + session-message persistence; bots, tools, memory/persona, schedules, Obsidian, browser, and Tailscale are explicitly out of scope here.

**In scope:** Electron + React 19 desktop shell, M3 streaming chat with a single global conversation, API key onboarding (modal + safeStorage), renderer ↔ main streaming IPC, tool-daemon child-process scaffold with JSON-RPC + NDJSON + audit log, JSONL session persistence on disk (shape Phase 3 inherits).

**Out of scope (Phase 4+):** bot CRUD, sidebar, settings pages, per-persona system prompts, file tools, memory, scheduler, Obsidian, browser automation, Tailscale/WS endpoint, packaging.

</domain>

<decisions>
## Implementation Decisions

### 1. Chat UI Layout & Style (UI-02)
- **D-01:** Light chat-bubble style (light background, subtle color distinction between user and assistant bubbles).
- **D-02:** Highlighted code blocks in assistant bubbles (shiki or react-syntax-highlighter); inline `code` gets a subtle background tint. — **Reversibility:** costly — rationale: downstream phases (UI-03 tool blocks, UI-08 file diffs) inherit the markdown renderer selection; swapping to a different highlighter later means rerendering all legacy JSONL sessions.
- **D-03:** User and assistant messages are both left-aligned; distinguished only by subtle background color (user: tinted bg, assistant: white/neutral).
- **D-04:** Composer is an auto-growing text input pinned to the bottom of the window, always visible; Enter sends, Shift+Enter inserts newline.

### 2. API Key Onboarding & Keychain (LLM-05, SEC-05)
- **D-05:** API key stored via Electron `safeStorage` (Windows DPAPI / macOS Keychain / Linux libsecret under the hood); encrypted blob lives in `app.getPath('userData')`, OS holds the master key. — **Reversibility:** one-way — rationale: on first store, safeStorage picks the strongest backend the OS offers; migrating to a different store later means re-encrypting every existing key. No plain-text key ever touches disk.
- **D-06:** First-launch shows a blocking modal that prevents chat use until the key is entered, validated, and persisted; modal includes a "Get API key" link to the M3 dashboard.
- **D-07:** Streaming IPC contract: `ipcRenderer.invoke('sendMessage', { content, msgId })` from renderer → main reads key from safeStorage, opens `@anthropic-ai/sdk` stream, forwards events back via `webContents.send('message:token', { msgId, delta })` / `('message:done', { msgId })` / `('message:error', { msgId, error })`. Renderer joins events by `msgId`. — **Reversibility:** one-way — rationale: this IPC contract is the surface every later phase (tool calls, cancel, errors) builds on; changing it later means migrating every renderer handler in lockstep.
- **D-08:** Key validation: "Test connection" button in the modal fires a tiny M3 probe (`messages.create({ max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })`); "Save" only persists to safeStorage on a successful probe. Inline error if 401 / network / 5xx.

### 3. Tool Daemon Bootstrap & Audit Log (SEC-01, SEC-04)
- **D-09:** Main spawns the daemon with `child_process.spawn(process.execPath, ['daemon/main.cjs'])` from the project root. Daemon prints a JSON `{ kind: 'ready' }` line on stdout (handshake); main reads it, sends a JSON-RPC `initialize` request, awaits the `ok` response. Daemon dies with main. — **Reversibility:** one-way — rationale: this is the process boundary every Phase 2+ tool execution crosses; changing the spawn model later means rebuilding the security perimeter.
- **D-10:** JSON-RPC on stdio uses newline-delimited JSON (NDJSON) — one complete JSON message per line. — **Reversibility:** reversible while no real consumers exist.
- **D-11:** Daemon's `tools/call` JSON-RPC method exists in Phase 1 and returns `{ error: { code: 'unknown_tool', message: 'no tools registered' } }` so the dispatch + audit-hook paths are exercised end-to-end before Phase 2 plugs real tools in. — **Reversibility:** reversible — Phase 2 replaces this with real tool dispatch.
- **D-12:** Audit log: append-only JSON Lines at `<userData>/audit/YYYY-MM-DD.jsonl` (UTC day rotation); each line: `{ ts, bot, tool, params, outcome, durationMs, error? }`. Failed and refused calls log `outcome: "error"` with the error code. — **Reversibility:** reversible while the only consumer is the SEC-04 success criteria.

### 4. Session Message Buffering
- **D-13:** Each turn is appended to a single global JSONL file at `<userData>/sessions/<sessionId>.jsonl` (shape: `{ ts, role, content, stopped?, interrupted? }`). Phase 3 inherits this format when it owns per-session history. — **Reversibility:** one-way — rationale: existing JSONL on disk uses this schema; adding required fields later is a forward-only migration.
- **D-14:** Phase 1 uses one global session file across the app's lifetime (no "New Chat" button in the UI). Phase 3 redefines session boundaries.
- **D-15:** On app launch, all messages from the JSONL are loaded into the chat pane; chat auto-scrolls to the bottom.
- **D-16:** Hard-coded default system prompt: "You are Localbot, a local-first coding/dev assistant running on the user's PC. Be concise, use tools when useful, and don't pretend to know things you haven't verified." Phase 4 per-bot personas override this.

### 5. In-flight Cancel / Abort
- **D-17:** UI: while a stream is active, the Send button morphs into a Stop button (same position, different label/color); Esc key also stops. — **Reversibility:** reversible until Phase 2 introduces tool-loop cancel semantics tied to the same affordance.
- **D-18:** Renderer → main cancel transport: `ipcRenderer.invoke('cancel', msgId)`. Main holds an `AbortController` per active `msgId` (created when the stream starts). On cancel, main calls `.abort()` on the SDK stream and sends a `tools/cancel` JSON-RPC to the daemon if a tool call is currently in flight. — **Reversibility:** costly — rationale: phase 2's agentic loop uses the same `msgId`-keyed cancel map; renaming the channel requires touching every tool-loop continuation path.
- **D-19:** On cancel, the partial text already streamed is preserved in the assistant bubble; a small "(stopped)" marker is appended at the end so the JSONL history and future readers can tell the message didn't complete naturally.
- **D-20:** If a daemon `tools/call` is in flight when cancel fires, main sends a `tools/cancel` JSON-RPC with the active `toolCallId`; daemon stops the in-flight tool and reports a partial result or `cancelled` error back to main, which forwards it into the LLM context as a `tool_result` with a cancellation marker.

### 6. Error Surface & Recovery
- **D-21:** App-level and LLM errors (key invalid, M3 unreachable, daemon died) render as a dismissable banner at the top of the chat pane. Tool-level errors (Phase 2+) render inline below the offending assistant message.
- **D-22:** Network errors and M3 5xx auto-retry with exponential backoff up to 3 attempts before surfacing as an error. 401 and all non-transient errors surface immediately with a "Retry" or "Update key" button.
- **D-23:** Mid-stream interruption: partial text is preserved; an inline "Stream interrupted — Retry" footer appears below the assistant bubble; clicking Retry re-sends the same user message and preserves the prior partial as history.
- **D-24:** Daemon process death: main auto-respawns a fresh child process; while reconnecting, a top-of-chat banner reads "Tool daemon reconnecting…"; banner clears once the new daemon's `ready` handshake completes.

### 7. App Windowing & Tray
- **D-25:** Phase 1 launches exactly one window (the chat pane); closing it quits the app. Multi-window arrives with bots in Phase 4. — **Reversibility:** reversible while Phase 1 is the only consumer.
- **D-26:** No system tray icon in Phase 1; tray features land with bots (Phase 4) or as part of Tailscale work (Phase 9).
- **D-27:** Window chrome uses `titleBarStyle: 'hidden'` with `titleBarOverlay` enabled on Windows — content extends to the top of the window with native min/max/close on the right; the chat header hosts a small "Localbot" label.
- **D-28:** App icon is a minimal monochrome "L" mark in a colored rounded square, shipped as a placeholder; swappable later when a real icon arrives.

### 8. Phase 1 Test Scope
- **D-29:** Vitest unit tests for the pieces with explicit contracts: JSON-RPC NDJSON framing (parse/write, error envelopes), safeStorage round-trip (encrypted-at-rest, decrypted on read), session-JSONL serialization. — **Reversibility:** reversible (test code, not user-facing).
- **D-30:** One Playwright smoke test that launches the Electron app, completes the API-key modal against a fake M3, sends a message, and asserts a streamed token appears in the chat. Plus a focused smoke that fires `tools/call` against the real spawned daemon and asserts the JSONL audit line was written under a temp directory. — **Reversibility:** reversible (test code).
- **D-31:** Tests mock M3 with an in-process fake HTTP/SSE server bound to `127.0.0.1:<random port>`; tests start the server and override `M3_API_BASE` env var. Real `@anthropic-ai/sdk` is exercised (catches SDK-level regressions). — **Reversibility:** reversible while only Phase 1 tests exist.
- **D-32:** Vitest for unit/IPC-contract tests; Playwright for the Electron smoke test. Both in `devDependencies`.

### Claude's Discretion

- **D-04 (composer):** Selected the auto-grow pinned-bottom option on user's behalf when the user replied "you choose"; the recommended option was adopted as the locked decision.
- Within D-21 / D-23 banner wording is illustrative; implementation may use phrasings that fit the light-bubble aesthetic.
- shiki vs. react-syntax-highlighter for D-02 is left to the planner — both are acceptable; pick whichever is lighter given the no-node-gyp constraint.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project context
- `.planning/PROJECT.md` — What Localbot is, core value, constraints (Electron + React 19 + TS + Node 20+, no node-gyp, M3 API as the only network dependency, Windows-first). 52 v1 requirements mapped across 8 categories.
- `.planning/REQUIREMENTS.md` — Full v1 requirement list (52 REQ-IDs). For Phase 1, the relevant IDs are LLM-01, LLM-02, LLM-05, SEC-01, SEC-04, SEC-05, UI-02.
- `.planning/ROADMAP.md` — 9 phases; Phase 1 success criteria are the testable outcomes the phase must hit (chat launches, tokens stream, key in keychain, daemon as child process, audit log writes).
- `.planning/STATE.md` — Project state, accumulated context; updated at session boundaries.

### Reference architecture
- `research/ARCHITECTURE.md` — Reverse-engineered Grokbot architecture. Most useful for Phase 1: §1 (process topology), §4 (IPC bus channel naming), §6 (MCP-first plugin model — informs the JSON-RPC daemon shape). Localbot deliberately drops the cloud "box" layer; pattern to adapt is the stdio local daemon (Local-Exec Daemon in the Grokbot extract).

### External APIs / SDKs (canonical product sources)
- MiniMax M3 API — Anthropic-compatible `/v1/messages` endpoint. Spec is shared with Anthropic Messages API. Planner should consult Anthropic's Messages + streaming docs for the exact SSE event shape and `tool_use` envelope; the official `@anthropic-ai/sdk` package wraps these correctly and is the chosen client.
- Electron `safeStorage` — Electron's built-in API is the spec for D-05.
- Electron `BrowserWindow` options (`titleBarStyle`, `titleBarOverlay`) — spec for D-27.

### Test tooling
- Vitest — chosen for unit tests (D-32).
- Playwright — chosen for the Electron smoke test (D-32).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

This is a greenfield codebase — no existing Localbot source files exist yet. There is no `src/`, no `package.json`, no previous Phase 1 implementation. Planners start from a blank tree.

### Established Patterns

None yet — first implementation phase. The architectural patterns established here (Electron main/renderer split, stdio JSON-RPC daemon, NDJSON framing, NDJSON session log, per-day NDJSON audit log, `ipcRenderer.invoke('sendMessage', …)` + `webContents.send('message:*', …)` event forward, `safeStorage`-encrypted key store, `child_process.spawn` + handshake + AbortController map) will be inherited by every later phase.

Reference architecture in `research/ARCHITECTURE.md` documents Grokbot's patterns:
- **Process topology (Grokbot §1)** — Electron main + daemon child process is the proven split; Localbot simplifies it (one main + one daemon, no cloud box, no agent coordinator for Phase 1).
- **IPC bus channel naming (Grokbot §4)** — kebab-case channel names (`backend-check-auth-status` etc.) are the convention; Localbot uses `sendMessage`, `cancel`, `message:token`, `message:done`, `message:error`.
- **stdio MCP server (Grokbot §6)** — Grokbot's local-exec-daemon hosts an MCP server; Localbot uses straight JSON-RPC instead (one less protocol to learn) but keeps the same stdio transport.

### Integration Points

None in Phase 1 (no other Localbot components exist yet). Future integration points documented here for the planner's awareness:

- **Phase 2 tools plug into the daemon** via `tools/list` (currently returns `[]`) and `tools/call` (currently returns `unknown_tool`). The JSON-RPC shape D-11 establishes here is the wire format Phase 2 will use.
- **Phase 3 memory/history** inherits D-13's `<userData>/sessions/<sessionId>.jsonl` shape. Schema additions later are forward-only migrations.
- **Phase 4 personas** override D-16's hard-coded system prompt per-bot.
- **Phase 9 Tailscale/WS endpoint** reuses the renderer ↔ main IPC contract (D-07), exposing it as a WS endpoint for the phone browser.

</code_context>

<specifics>
## Specific Ideas

- Chat-bubble color contrast specifically chosen for a light theme — the planner should pick a tinted-bg shade that survives inline code highlighting without washing out syntax colors.
- The "(stopped)" / "Stream interrupted" markers should be visually distinct from inline `code` so they never accidentally get markdown-rendered.
- The minimal "L" mark icon (D-28) should be a 256×256 monochrome SVG-derived PNG; document in code where to swap it.
- The first-launch modal lives behind a one-time gate (`hasKey === false` in safeStorage probe on app start); subsequent launches skip the modal entirely.
- Daemon's `unknown_tool` response includes a stable error code so Phase 2+ tooling can distinguish "tool not registered" from real errors.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within Phase 1 scope across all 8 areas. Future-phase candidates that surfaced but were recognized as out of scope: sidebar / bot list (Phase 4), per-persona system prompt override (Phase 4), per-bot tool allowlists (Phase 2), memory summarization (Phase 3), scheduler (Phase 6), Obsidian (Phase 7), browser tools (Phase 8), Tailscale WS endpoint (Phase 9).

</deferred>

---

*Phase: 1-Skeleton + Streaming Chat*
*Context gathered: 2026-09-17*
