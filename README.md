# Localbot

> Local-first desktop AI agent app. Create and run multiple specialized AI bots — each with its own persona, toolset, workspace, and persistent memory — that read and edit files, run shell commands, search code, and drive a browser, all on your own PC.

**Core value:** a private, persistent, multi-agent AI coding/dev assistant that knows your codebase, learns from prior runs, and never leaves your machine.

---

## Status

**Early development — Phase 3 of 9 complete** (skeleton + streaming chat + tool system + memory + conversation history).

| Phase | Name | Status |
|------:|------|:-------|
| 1 | Skeleton + Streaming Chat | ✅ |
| 2 | File Tools + Search + Tool System | ✅ |
| 3 | Memory + Conversation History | ✅ |
| 4 | Multi-Bot CRUD + Sidebar | — pending |
| 5 | Shell Exec with Approval | — pending |
| 6 | Scheduler + Notifications | — pending |
| 7 | Obsidian Integration | — pending |
| 8 | Browser Automation | — pending |
| 9 | Phone Reach + Ship | — pending |

Planning + verification artifacts live in `.planning/`. Headed-Electron smoke coverage is partial — see `.planning/phases/*/0?-UAT.md` for what's verified vs what still needs a desktop-session run.

---

## Features

- **Multi-bot runtime** — each bot has its own persona, workspace, tool allowlist, and per-bot per-session conversation history (JSONL)
- **Persistent memory** — per-bot markdown memory + JSON facts file, surfaced in the system prompt (with token-budget auto-summarization)
- **Built-in tools** — `read_file`, `write_file`, `edit_file`, `list_dir`, `code_search` (ripgrep), `exec_command` (approval-gated), browser automation (Playwright)
- **Streaming chat** — token-by-token streaming from a local LLM endpoint with full tool_use agentic loop
- **OS-keychain key storage** — API key encrypted via Electron `safeStorage` (DPAPI on Windows), never sent to the renderer
- **Per-session history + summarization** — soft-cap tokens, auto-summarize when approaching limit, summary persists as the JSONL head
- **Audit log** — every tool call logged as JSONL under `audit/<UTC-day>.jsonl` (timestamp, bot, tool, params, outcome)

### Planned

- **Obsidian vault integration** — read anywhere, write only to `Agents/<bot-name>/`
- **Phone reach** — HTTP/WS control endpoint reachable from a phone browser over Tailscale
- **Cron scheduler + system notifications** for scheduled bot runs
- **Single .exe Windows installer** via electron-builder

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Electron main process (src/main/)                         │
│    ├─ IPC handlers (history.list, memory.read, tree.list)   │
│    ├─ Anthropic SDK → M3 /v1/messages streaming             │
│    └─ spawn() → tool daemon                                 │
│         └─ stdio JSON-RPC                                  │
│              └─ daemon/                                     │
│                   read_file / write_file / edit_file /       │
│                   list_dir / code_search / ripgrep /        │
│                   memory.* / tree.list                      │
└──────────────────┬──────────────────────────────────────────┘
                   │ contextBridge.exposeInMainWorld
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  Renderer (src/renderer/, React 19)                         │
│    ├─ Chat stream (assistant bubbles + tool_use blocks)     │
│    ├─ MemoryPill · WorkspaceTree · DiffView · SessionSwitcher│
│    └─ KeyModal (API key + probe + save)                     │
└─────────────────────────────────────────────────────────────┘
```

**Security model:** the renderer never has Node access or the API key. All tool calls go main → daemon → main → renderer over the IPC bridge. Per-bot tool allowlists are enforced in the daemon, not in the agent prompt. Every tool call is audited.

---

## Tech Stack

- **Electron** 33 + **React** 19 + **TypeScript** 5.7 + **Node** 20+
- **@anthropic-ai/sdk** for streaming + tool_use (no raw HTTP)
- **chokidar** for workspace watcher, **react-arborist** + **react-diff-viewer-continued** for the tree/diff surfaces
- **Vitest** for unit tests, **Playwright** for Electron smokes
- **Pre-built binaries only** — no native modules requiring node-gyp

LLM endpoint is MiniMax M3 (Anthropic-compatible `/v1/messages`); only network dependency. No telemetry, no Sentry, no Statsig.

---

## Getting started

```bash
# requires Node 20+
nvm use                    # uses .nvmrc
npm install
npm run build              # compiles main (tsc) + renderer (vite)
npm start                  # launches the built Electron app
```

### Dev mode

```bash
npm run dev                # vite + electron concurrently, hot-reload renderer
```

### Tests

```bash
npm test                   # Vitest unit suite
npm run test:smoke         # Playwright Electron + daemon smokes
LOCALBOT_SMOKE_OK=1 npm run test:smoke   # headed Electron (needs a display)
```

---

## Configuration

- `M3_API_BASE` — LLM endpoint (default `http://localhost:8080`)
- `M3_MODEL` — model name (default `MiniMax/M3`)
- `LOCALBOT_USER_DATA_DIR` — override userData root (used by tests)
- `LOCALBOT_WORKSPACE_ROOT` — workspace path bots read/write
- `LOCALBOT_SOFT_CAP_TOKENS` — context-budget threshold for auto-summarize (default `60000`)
- `ELECTRON_RUN_AS_NODE=1` — required in the daemon child process env (set by main)

---

## Repo layout

```
.claude/        # Claude agent config + project skills
.planning/      # roadmap, requirements, phase plans, debug sessions, UAT
daemon/         # tool daemon (CJS, stdio JSON-RPC)
research/       # ARCHITECTURE.md (Grokbot reference architecture notes)
resources/      # icons, assets
src/
  main/         # Electron main: IPC, LLM loop, keychain, daemon spawn
  renderer/     # React 19 UI
  preload/      # contextBridge surface
tests/
  unit/         # Vitest
  playwright/   # Electron + daemon smoke tests
```

---

## License

Personal/internal. Not published for redistribution.