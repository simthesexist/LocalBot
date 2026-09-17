# Localbot

## What This Is

Localbot is a local-first desktop AI agent app that lets you create and run multiple specialized AI "bots" — each with its own persona, toolset, workspace, and persistent memory. Bots can read and edit files, run shell commands, search code with ripgrep, and drive a browser. They persist across sessions and can run on scheduled routines. The app integrates with your local Obsidian vault as a knowledge source and write target, and is reachable from your phone over Tailscale.

Built for a single user on a single Windows PC that stays on 24/7.

## Core Value

A private, persistent, multi-agent AI coding/dev assistant that knows your codebase, learns from prior runs, and never leaves your machine.

If everything else fails, this must work: **the chat → LLM → tool → result loop, with persistent agent memory, fully on your own PC.**

## Business Context

Internal tool, single user, no monetization. This section intentionally omitted.

## Requirements

### Validated

(None yet — ship to validate)

### Active

**Agent runtime**

- AGENT-01: User can create a new bot with a name, persona, workspace path, tool allowlist, and optional cron schedule
- AGENT-02: User can delete a bot (folder + all state) with confirmation
- AGENT-03: User can list all bots with status (idle / running / errored / scheduled) and last-run timestamp
- AGENT-04: User can edit a bot's persona, workspace, tool allowlist, and schedule
- AGENT-05: Each bot has its own persistent memory stored as a markdown file + JSON facts file
- AGENT-06: Each bot keeps per-session conversation history as JSONL files
- AGENT-07: User can trigger a bot to run manually with a message
- AGENT-08: User can cancel a running bot
- AGENT-09: Bots can be scheduled to run on a cron expression; user can enable/disable per-bot
- AGENT-10: System notification fires when a scheduled bot errors (configurable per bot)

**LLM integration**

- LLM-01: App talks to MiniMax M3 API via Anthropic-compatible /v1/messages endpoint
- LLM-02: App streams tokens from the LLM to the chat UI in real time
- LLM-03: Agentic loop handles tool_use blocks (execute tool, append tool_result, continue)
- LLM-04: Token budget tracking with automatic conversation summarization when approaching context limit
- LLM-05: API key stored locally (not in renderer, not on disk in plaintext — OS keychain)

**Tools (built-in)**

- TOOL-01: `read_file` — read a file at a path
- TOOL-02: `write_file` — write a file (creates dirs as needed)
- TOOL-03: `edit_file` — apply a targeted edit (find/replace) to an existing file
- TOOL-04: `list_dir` — list directory contents
- TOOL-05: `code_search` — ripgrep-based code search with regex and globs
- TOOL-06: `exec_command` — run a shell command, requires per-call user approval by default
- TOOL-07: `browser_navigate` — Playwright-driven browser navigation
- TOOL-08: `browser_click` — click a DOM element by selector
- TOOL-09: `browser_type` — type text into an input
- TOOL-10: `browser_screenshot` — capture a PNG of the viewport
- TOOL-11: `browser_evaluate` — run JS in page context
- TOOL-12: `browser_fill_form` — fill multiple form fields at once

**Obsidian integration**

- OBS-01: User can configure a vault path per bot (or globally)
- OBS-02: Bots can read notes from anywhere in the vault (search, read specific note, follow wikilinks)
- OBS-03: Bots can write only to `Agents/<bot-name>/` subfolder of the vault
- OBS-04: Per-bot allow/deny glob lists for vault read paths
- OBS-05: Global deny globs for vault paths that no bot can read (e.g., `Private/**`, `Credentials/**`)
- OBS-06: Bots can search vault by query and return context lines

**Security**

- SEC-01: Tool daemon runs as a separate child process from Electron main; main never touches user shell directly
- SEC-02: Per-bot tool allowlist + denylist enforced in the daemon, not the agent
- SEC-03: Global command denylist (e.g., `rm -rf /`, `sudo *`, `curl * | bash`) checked before per-bot policy
- SEC-04: All tool calls logged to a shared audit log with timestamp, bot name, tool name, params
- SEC-05: API key never exposed to renderer; LLM calls proxied through Electron main

**UI**

- UI-01: Bot sidebar showing name, status indicator, last-run time
- UI-02: Chat pane with streaming assistant text
- UI-03: Tool-call visual blocks (name + params + result) inline in the chat
- UI-04: Approval modal for shell command execution (command preview, Allow Once / Always Allow / Deny)
- UI-05: "New Bot" creation modal with template fields
- UI-06: Per-bot settings page
- UI-07: Run history table per bot (timestamp, duration, exit reason, error if any)
- UI-08: Workspace file tree + diff view for edit_file results

**Network / Tailscale**

- NET-01: Localbot listens on a configurable port (default 7878) for HTTP/WS control
- NET-02: WebSocket endpoint exposes the same chat interface as the renderer (so a phone browser can drive a bot)
- NET-03: Local-only binding by default; user can opt in to LAN / Tailnet binding via a setting
- NET-04: Tailscale MagicDNS name shown in the UI for easy access from phone

**Packaging**

- PKG-01: Single .exe installer for Windows via electron-builder
- PKG-02: App auto-updates from a configurable update channel (manual check, no auto-install)

### Out of Scope

- **Voice / phone calls** — Grokbot has these; we don't. Adds WebRTC + audio pipeline for marginal value. Re-evaluate in v2.
- **Cross-bot communication / delegation** — `delegate_to_agent` tool. Recursion + deadlock risk; not needed for v1 use cases.
- **Native mobile app** — Tailscale + a phone browser hitting the WS endpoint is sufficient.
- **Cloud sync / multi-device sync** — Single-machine by design. Your PC is the only host.
- **Multi-user / team features** — Single user. No auth flow, no per-user permissions.
- **Persona versioning** — Old conversations load against the current persona; persona edits affect future runs only.
- **Native mobile-specific features** — push notifications to phone, mobile-responsive renderer. Use Tailscale + existing phone tools instead.

## Context

- **Reference architecture**: Grokbot by Cursor AI (codename `sand`), version 0.47.0. Reverse-engineered from installed bundle at `C:\Users\simth\AppData\Local\Programs\Grok Bot\`. Architecture notes in `research/ARCHITECTURE.md`.
- **LLM API**: MiniMax M3 — Anthropic-compatible `/v1/messages` endpoint. Streaming + tool_use supported.
- **Local PC**: Windows 11, runs 24/7, available at `simth` user. Tailscale already configured for phone access.
- **Obsidian vault**: User has a local Obsidian vault (path TBD during phase 1 setup). Hybrid access model: read anywhere, write only to `Agents/<bot-name>/`.
- **Prior research**: `research/ARCHITECTURE.md` documents the Grokbot patterns being adapted.

## Constraints

- **Tech stack**: Electron + React 19 + TypeScript + Node 20+. Use Electron over Tauri because we need native Node access for the tool daemon and Playwright.
- **Single machine**: No distributed architecture, no cloud backend, no sync engine. Everything reads from and writes to the local filesystem.
- **Anthropic SDK**: Use `@anthropic-ai/sdk` for streaming + tool_use. Don't roll our own.
- **Local-only LLM calls**: M3 API is the only network dependency. Localhost defaults; no telemetry, no Sentry, no Statsig (unlike Grokbot).
- **No native modules that require building**: Pre-built binaries only (electron, playwright, tree-sitter). Avoid node-gyp compile steps.
- **Windows-first**: Build for Windows 11. Cross-platform later.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Electron over Tauri | Need Node child-process spawn + Playwright | — Pending |
| File-based bot storage (folders, not DB) | Inspectable, git-friendly, debuggable in any text editor | — Pending |
| One shared tool daemon, per-bot allowlist | Cheaper than per-bot daemon; allowlist enforces safety | — Pending |
| stdio JSON-RPC for daemon IPC | No ports to firewall, no auth needed, dies with main | — Pending |
| Hybrid Obsidian access (read-anywhere, write-agents-only) | Safest default; agents can use vault knowledge without risking note corruption | — Pending |
| Full Playwright over HTTP fetch | Support JS-heavy sites and real interaction (forms, clicks) | — Pending |
| Anthropic SDK, not raw HTTP | Handles SSE parsing, tool_use streaming, retries correctly | — Pending |
| In-process cron scheduler | PC runs 24/7; no need for OS-level handoff (launchd/Task Scheduler) | — Pending |
| System notifications via Electron Notification API | Built-in, no extra dep | — Pending |
| HTTP/WS control endpoint for Tailscale reach | User already has Tailscale; lets phone browser drive bots | — Pending |
| No telemetry, no error reporting, no feature flags | Local tool, no value to collecting user data | — Pending |
| `Localbot` as project name | Generic, neutral, no IP conflict | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-09-17 after initialization*
