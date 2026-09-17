# Walking Skeleton — Localbot

**Phase:** 1
**Generated:** 2026-09-17

## Capability Proven End-to-End

A first-launch user enters an M3 API key into a blocking modal, the key is validated against the M3 probe and stored via Electron safeStorage; thereafter the user can type a message in the chat pane, watch the assistant's response stream token-by-token, and observe the Localbot tool daemon running as a sibling child process with `tools/call` requests round-tripping through it and every call appended to a shared audit JSONL file under the user-data directory.

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Desktop shell | Electron (latest stable) | Required by `.claude/CLAUDE.md`; needs native Node for the stdio tool daemon and for Playwright in Phase 8. |
| Renderer framework | React 19 + Vite + TypeScript | React 19 matches the Grokbot reference (research/ARCHITECTURE.md §8). Vite is the fastest TS-aware bundler for Electron renderer-dev and ships no node-gyp step. |
| LLM client | `@anthropic-ai/sdk` pointed at M3 (`M3_API_BASE` env override, default `https://api.MiniMax.io/v1`) | Per `.claude/CLAUDE.md`. SDK already handles Anthropic-compatible SSE streaming + tool_use envelopes; M3 speaks the same wire format. |
| Renderer–main bridge | `contextBridge`-exposed `window.localbot` object with `invoke` channels `sendMessage`, `cancel`, `key:get`, `key:set`, `key:probe`; outbound events `message:token`, `message:done`, `message:error`, `daemon:status` via `webContents.send`. `msgId` joins request → events. | Implements locked decision D-07. One-way: this contract is the surface Phase 2 tool calls and Phase 9 WS endpoint both build on. |
| API key storage | Electron `safeStorage.encryptString` → base64 → `app.getPath('userData')/api-key.bin`. Decryption in main only; renderer never sees the ciphertext. | Locked D-05. One-way: re-encrypts on first store under the OS master key. |
| Tool daemon transport | `child_process.spawn(process.execPath, ['daemon/main.cjs'], { stdio: ['pipe','pipe','inherit'] })`. Daemon writes `{"kind":"ready"}\n` on stdout; main reads one line, then sends `{"jsonrpc":"2.0","id":1,"method":"initialize"}`; awaits `{"jsonrpc":"2.0","id":1,"result":{...}}`. NDJSON framing thereafter. | Locked D-09/D-10. One-way: this is the process boundary every Phase 2 tool execution crosses. |
| Daemon protocol | JSON-RPC 2.0 over NDJSON; one object per line. Methods: `initialize`, `tools/list` (returns `[]` in Phase 1), `tools/call` (returns `unknown_tool` per D-11), `tools/cancel`. | Locked D-10/D-11. Forward-compatible with Phase 2+. |
| Audit log | Append-only NDJSON at `<userData>/audit/YYYY-MM-DD.jsonl` (UTC day). Line shape `{ ts, bot, tool, params, outcome, durationMs, error? }`. Both main and daemon can append; main is the designated writer so daemon failures are still logged. | Locked D-12. Reversible while the only consumer is SEC-04. |
| Session buffer | Append-only NDJSON at `<userData>/sessions/global.jsonl` in Phase 1. Line shape `{ ts, role, content, stopped?, interrupted? }`. Phase 3 swaps filename to per-session. | Locked D-13/D-14. One-way: existing JSONL uses this schema. |
| System prompt | Hard-coded constant in `src/main/llm/prompts.ts`. Phase 4 personas override per-bot. | Locked D-16. |
| Window chrome | `titleBarStyle: 'hidden'` + `titleBarOverlay: { color: '#ffffff', height: 32 }` on Windows; single `BrowserWindow`; `width: 1100, height: 760`. | Locked D-25/D-27. |
| Cancel transport | `ipcRenderer.invoke('cancel', msgId)` → main resolves an `AbortController` from a `Map<msgId, AbortController>` → SDK `stream.controller.abort()` + `tools/cancel` JSON-RPC if a tool call is in flight. | Locked D-18. Costly: Phase 2 agentic loop inherits the same `msgId` map. |
| Error surface | Top-of-chat dismissable banner for app/LLM errors; inline "Stream interrupted — Retry" footer for in-flight cancellations. Network/5xx auto-retry ≤3 with exp backoff; 401 immediate + "Update key" CTA. Daemon death triggers respawn + "Tool daemon reconnecting…" banner. | Locked D-21..D-24. |
| Tests | Vitest (unit) + Playwright Electron (smoke) in `devDependencies`. Fake M3 server in-process on `127.0.0.1:<random>`, base URL via `M3_API_BASE` env override. | Locked D-29..D-32. Reversible. |
| App icon | Minimal "L" SVG in resources/ — placeholder per D-28. | Locked D-28. |

## Stack Touched in Phase 1

- [x] Project scaffold (Electron + Vite + React 19 + TS, package.json, tsconfig, vite.config, build scripts)
- [x] Routing — single window + IPC channels (`sendMessage`, `cancel`, `key:*`, events `message:*`, `daemon:status`)
- [x] Database — real append-only writes (session JSONL, audit JSONL) AND real reads (session JSONL loaded into chat on launch)
- [x] UI — composer + bubbles + key modal + error banner all wired to live IPC streams
- [x] Deployment — `npm run dev` launches main + renderer with HMR; `npm run build` produces packaged `dist/main` + `dist/renderer` for a single-electron-launch flow

## Out of Scope (Deferred to Later Slices)

- Bot CRUD, per-bot personas, sidebar (Phase 4)
- File tools (`read_file`, `write_file`, `edit_file`, `list_dir`, `code_search`) + per-bot allowlist (Phase 2)
- Auto token-budget summarization, workspace tree (Phase 3)
- Cron scheduler + system notifications (Phase 6)
- Obsidian vault access (Phase 7)
- Playwright browser tools (Phase 8)
- Tailscale-friendly HTTP/WS endpoint, MagicDNS display (Phase 9)
- Windows .exe packaging (Phase 9)
- Multi-window, system-tray icon, real app icon (Phase 4 or Phase 9)
- "New Chat" / per-session history (Phase 3)
- Renderer-side rate-limit UI controls (none in v1)

## Subsequent Slice Plan

Each later phase adds one vertical slice on top of this skeleton without altering its architectural decisions:

- **Phase 2:** Bot gains the file-tool surface via the existing daemon `tools/call` channel. `tools/list` returns the first five tools; UI surfaces them as inline blocks (UI-03); allowlist policy lives in the daemon (SEC-02).
- **Phase 3:** Session files become per-`(bot, id)` JSONL; memory file + facts JSON appear in workspace tree; summarization kicks in above the token budget. Audit log + daemon process boundary unchanged.
- **Phase 4:** Bot CRUD multiplies the session/state folders; sidebar is UI-01; one global session becomes N per-bot sessions; window-chrome + safeStorage keep their Phase 1 shape.
- **Phase 5:** Adds `exec_command` to the daemon with the approval modal driving a new IPC channel; audit log gains `approved_by` field.
- **Phase 6:** Bot config gains a cron expression; main process owns the cron loop; `daemon:status` channel reused for "scheduled run starting" UX.
- **Phase 7:** Adds vault mount + glob enforcement; reads flow through the daemon, writes still routed via `tools/call`.
- **Phase 8:** Adds Playwright-driven browser tools; daemon gains a `playwright` child process group.
- **Phase 9:** Re-exposes the same `sendMessage` + event channels as a WebSocket endpoint bound to localhost by default; electron-builder produces the `.exe`.
