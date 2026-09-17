# Phase 1: Skeleton + Streaming Chat - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-17
**Phase:** 1-Skeleton + Streaming Chat
**Areas discussed:** Chat UI layout & style, API key onboarding & keychain, Daemon bootstrap & audit log, Session message buffering, In-flight cancel / abort, Error surface & recovery, App windowing & tray, Phase 1 test scope

---

## Chat UI Layout & Style

| Option | Description | Selected |
|--------|-------------|----------|
| Hybrid dark theme | Dark background by default; sans-serif prose, monospace for code; thin neutral borders. | |
| Light chat-bubble style | Light background; rounded user/assistant bubbles; friendly spacing. | ✓ |
| Terminal / CLI aesthetic | Monospace everywhere, dense monochrome. | |

| Question | Selection |
|---|---|
| What overall look should the Phase 1 chat pane have? | Light chat-bubble style |
| How should code render inside assistant bubbles in Phase 1? | Highlighted code blocks (shiki or react-syntax-highlighter) |
| How should user vs assistant messages be visually distinguished? | Left/aligned by color (subtle bg color only) |
| How should the composer / message-input area look and behave? | Auto-grow composer, pinned to bottom (Claude discretion - recommended option selected) |

**Notes:** User said "you choose" on the composer question; the recommended option (auto-grow pinned bottom, Enter to send, Shift+Enter newline) was adopted.

---

## API Key Onboarding & Keychain

| Option | Description | Selected |
|--------|-------------|----------|
| Electron safeStorage | Built-in; uses OS keychain (DPAPI / Keychain / libsecret). | ✓ |
| keytar | Community lib, prebuilt binaries available. | |
| Hand-rolled DPAPI | Direct call via @napi-rs/keyring. | |

| Question | Selection |
|---|---|
| Where should the encrypted key be stored? | Electron safeStorage (Windows DPAPI / macOS Keychain / Linux libsecret) |
| How should Phase 1 bootstrap the API key on first launch? | Blocking first-launch modal |
| How should streaming IPC work between renderer and main, given SEC-05? | ipcRenderer.invoke + per-message-id event forward |
| How should key validation work in the first-launch modal? | Test-connection button + auto-save on success |

**Notes:** Modal includes a "Get API key" link to the M3 dashboard. Test probe is a tiny `messages.create({ max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })` call.

---

## Daemon Bootstrap & Audit Log

| Option | Description | Selected |
|--------|-------------|----------|
| child_process.spawn + handshake | Spawn with stdout "ready" handshake + initialize JSON-RPC. | ✓ |
| child_process.fork | Auto IPC channel; less explicit child-process boundary. | |
| Separate Node binary | Daemon as its own executable; doubles install footprint. | |

| Option for framing | Description | Selected |
|---|---|---|
| NDJSON | One JSON message per line. | ✓ |
| Length-prefixed (LSP-style) | `Content-Length: N\r\n\r\n<json>`. | |
| Single in-flight | Blocks parallelism; unsuitable for Phase 2+. | |

| Option for empty registry | Description | Selected |
|---|---|---|
| tools/call returns structured "unknown tool" | Exercises dispatch + audit; bridge for Phase 2. | ✓ |
| tools/call unimplemented in Phase 1 | Cleaner Phase 1; audit hook untested. | |
| Register a sentinel echo tool | Green path; misleading because no real tools exist. | |

| Option for audit log | Description | Selected |
|---|---|---|
| Per-day JSONL | `<userData>/audit/YYYY-MM-DD.jsonl`; one line per call. | ✓ |
| Single flat log | Simplest; one giant file over years. | |
| SQLite audit table | Queryable; extra dep. | |

**Notes:** Daemon dies when main exits. Audit line fields: `{ ts, bot, tool, params, outcome, durationMs, error? }`. Failure outcomes include `error.code`.

---

## Session Message Buffering

| Option | Description | Selected |
|--------|-------------|----------|
| Scratch JSONL now | Each turn appended to `<userData>/sessions/<id>.jsonl`. | ✓ |
| Ephemeral until Phase 3 | Pure in-memory until Phase 3 lands persistence. | |
| Hybrid: in-memory + recovery blob | Smaller recovery file; full history is Phase 3. | |

| Option for session boundary | Description | Selected |
|---|---|---|
| One global session file | Single continuous JSONL; no "New Chat" in Phase 1. | ✓ |
| Per-launch + "New Chat" button | Multiple sessions per app lifetime. | |
| Idle-timeout session break | Auto end after N minutes of inactivity. | |

| Option for history on launch | Description | Selected |
|---|---|---|
| Load full history, scrollable | Whole JSONL in chat on launch. | ✓ |
| Load last N messages | Pagination gesture. | |
| Empty chat by default | Side-panel history view. | |

| Option for system prompt | Description | Selected |
|---|---|---|
| Concise default baseline | Hard-coded Localbot dev-assistant prompt. | ✓ |
| No system prompt | Let the LLM default. | |
| Defer system prompt | Empty system prompt until Phase 4 personas. | |

**Notes:** JSONL schema Phase 1 ships: `{ ts, role, content, stopped?, interrupted? }`. Phase 3 inherits this format. Baseline prompt: "You are Localbot, a local-first coding/dev assistant running on the user's PC. Be concise, use tools when useful, and don't pretend to know things you haven't verified."

---

## In-flight Cancel / Abort

| Option | Description | Selected |
|--------|-------------|----------|
| Inline button replaces Send; Esc also stops | During stream, Send morphs into Stop. | ✓ |
| Persistent Stop button | Always present, greyed when idle. | |
| Esc only, no button | No visible affordance. | |

| Option for cancel transport | Description | Selected |
|---|---|---|
| ipcRenderer.invoke('cancel', msgId) + AbortController map | Per-msgId controller; calls SDK .abort and forwards tools/cancel. | ✓ |
| fire-and-forget ipcRenderer.send | Blurs request vs event semantics. | |
| Cancel as a message-kind token | Conflates request and event semantics. | |

| Option for partial text | Description | Selected |
|---|---|---|
| Keep partial + "(stopped)" marker | Preserves text; marks for future readers. | ✓ |
| Keep partial, no marker | Clean visually but loses signal in JSONL. | |
| Truncate to last sentence | Loses already-read content. | |

| Option for tool cancel | Description | Selected |
|---|---|---|
| Cancel propagates to daemon via tools/cancel | Symmetric with SDK cancel; Phase 2 gets it free. | ✓ |
| Cancel SDK only; let daemon finish | Asymmetric; needs follow-up in Phase 2. | |
| Out of scope for Phase 1 | Defers design. | |

**Notes:** Contract is intentionally symmetric so Phase 2's agentic loop can reuse the same `msgId`-keyed cancel map.

---

## Error Surface & Recovery

| Option | Description | Selected |
|--------|-------------|----------|
| Top-of-chat banner for app/LLM; inline below for tool errors | Banner top; tool errors inline (Phase 2+). | ✓ |
| All errors inline below message | Risk of confusing app-level errors with bubble failures. | |
| Toast in corner | Easy to miss; no error history. | |

| Option for retry | Description | Selected |
|---|---|---|
| Auto-retry transient, manual for permanent | Network/5xx auto with exp backoff up to 3; 401/manual immediately. | ✓ |
| Manual only | Predictable; user clicks Retry for every blip. | |
| Always auto-retry until budget exhausted | Risky for 401s. | |

| Option for mid-stream interruption | Description | Selected |
|---|---|---|
| Keep partial + inline "stream interrupted" + Retry | Faithful; matches cancel UX. | ✓ |
| Replace partial with error block | Lossy. | |
| Lose partial, top-banner error | User must remember what was streamed. | |

| Option for daemon death | Description | Selected |
|---|---|---|
| Auto-restart silently + banner while reconnecting | Quiet; minimal manual work. | ✓ |
| Top banner + manual "Restart daemon" | Adds step for transient crashes. | |
| Quit app on daemon death | Loud signal; too heavy. | |

---

## App Windowing & Tray

| Option | Description | Selected |
|--------|-------------|----------|
| Single window for Phase 1 | Closing quits; matches single-chat Phase 1. | ✓ |
| Multi-window from day one | Each chat independent. | |
| Single window but no quit on close | Sets up tray behavior. | |

| Option for tray | Description | Selected |
|---|---|---|
| No tray; close = quit | Simple; tray deferred to Phase 4/9. | ✓ |
| Tray icon + menu only | App stays running in background. | |
| Tray icon + quick-prompt (Spotlight) | Scope creep. | |

| Option for chrome | Description | Selected |
|---|---|---|
| Hidden-inset title bar | `titleBarStyle: 'hidden'`, native min/max/close on right. | ✓ |
| Plain native title bar | OS default. | |
| Fully custom frame | Hand-rolled buttons. | |

| Option for app icon | Description | Selected |
|---|---|---|
| Minimal 'L' mark placeholder | Swappable later. | ✓ |
| Default Electron icon | Generic. | |
| Defer entirely (no icon file) | Looks unfinished. | |

**Notes:** Window is `titleBarStyle: 'hidden'` with `titleBarOverlay` enabled on Windows. Header hosts a small "Localbot" label. Icon is a 256×256 monochrome "L" in a colored rounded square.

---

## Phase 1 Test Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Smoke + IPC contract unit tests | Vitest unit + Playwright smoke; covers contracts end-to-end. | ✓ |
| IPC contracts + Playwright integration | Heavier setup; slower CI. | |
| Manual QA only | Fast; loses test coverage. | |

| Option for mocking M3 | Description | Selected |
|---|---|---|
| In-process fake M3 HTTP/SSE server | Real SDK exercised; env-overridable base URL. | ✓ |
| msw (Mock Service Worker) | Lighter setup; Electron/Node/SSE friction. | |
| Inject a fake client behind a wrapper | Doesn't exercise SDK's own parsing. | |

| Option for daemon tests | Description | Selected |
|---|---|---|
| Spawn real daemon end-to-end | Verifies spawn/handshake/JSON-RPC/audit. | ✓ |
| Stub daemon in main | Loses the real IPC contract coverage. | |
| Skip daemon tests in Phase 1 | Manual only until Phase 2. | |

| Option for tooling | Description | Selected |
|---|---|---|
| Vitest unit + Playwright smoke | Standard combo in devDependencies. | ✓ |
| Vitest unit only; defer Playwright | Lighter Phase 1; only manual E2E. | |
| Node test runner + Playwright | Cheaper dep tree; less ergonomic TS. | |

**Notes:** Daemon smoke fires `tools/call`, expects `unknown_tool`, then verifies the JSONL audit line was written under a temp directory.

---

## Claude's Discretion

| Area | What was deferred |
|---|---|
| Composer (D-04) | User said "you choose"; recommended option (auto-grow pinned bottom) was adopted. |
| D-02 highlighter choice (shiki vs. react-syntax-highlighter) | Left to planner — both acceptable; pick whichever is lighter given no-node-gyp constraint. |
| Banner / footer wording (D-21, D-23) | Implementation can refine phrases to fit the light-bubble aesthetic. |

## Deferred Ideas

None — discussion stayed strictly within Phase 1 scope across all 8 areas. Items that surfaced but were recognized as out of scope: sidebar / bot list (Phase 4), per-persona system prompt override (Phase 4), per-bot tool allowlists (Phase 2), memory summarization (Phase 3), scheduler (Phase 6), Obsidian (Phase 7), browser tools (Phase 8), Tailscale WS endpoint (Phase 9).
