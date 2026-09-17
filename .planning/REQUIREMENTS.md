# Requirements: Localbot

**Defined:** 2026-09-17
**Core Value:** A private, persistent, multi-agent AI coding/dev assistant that knows your codebase, learns from prior runs, and never leaves your machine.

## v1 Requirements

### Agent Runtime

- [ ] **AGENT-01**: User can create a new bot with name, persona, workspace path, tool allowlist, and optional cron schedule
- [ ] **AGENT-02**: User can delete a bot (folder + all state) with confirmation
- [ ] **AGENT-03**: User can list all bots with status (idle / running / errored / scheduled) and last-run timestamp
- [ ] **AGENT-04**: User can edit a bot's persona, workspace, tool allowlist, and schedule
- [ ] **AGENT-05**: Each bot has persistent memory stored as a markdown file + JSON facts file
- [ ] **AGENT-06**: Each bot keeps per-session conversation history as JSONL files
- [ ] **AGENT-07**: User can trigger a bot to run manually with a message
- [ ] **AGENT-08**: User can cancel a running bot
- [ ] **AGENT-09**: Bots can be scheduled on a cron expression; user can enable/disable per-bot
- [ ] **AGENT-10**: System notification fires when a scheduled bot errors (configurable per bot)

### LLM Integration

- [x] **LLM-01**: App talks to MiniMax M3 API via Anthropic-compatible /v1/messages endpoint
- [x] **LLM-02**: App streams tokens from the LLM to the chat UI in real time
- [ ] **LLM-03**: Agentic loop handles tool_use blocks (execute tool, append tool_result, continue)
- [ ] **LLM-04**: Token budget tracking with automatic conversation summarization when approaching context limit
- [x] **LLM-05**: API key stored locally (not in renderer, not on disk in plaintext — OS keychain)

### Built-in Tools

- [ ] **TOOL-01**: `read_file` — read a file at a path
- [ ] **TOOL-02**: `write_file` — write a file (creates dirs as needed)
- [ ] **TOOL-03**: `edit_file` — apply a targeted edit (find/replace) to an existing file
- [ ] **TOOL-04**: `list_dir` — list directory contents
- [ ] **TOOL-05**: `code_search` — ripgrep-based code search with regex and globs
- [ ] **TOOL-06**: `exec_command` — run a shell command, requires per-call user approval by default
- [ ] **TOOL-07**: `browser_navigate` — Playwright-driven browser navigation
- [ ] **TOOL-08**: `browser_click` — click a DOM element by selector
- [ ] **TOOL-09**: `browser_type` — type text into an input
- [ ] **TOOL-10**: `browser_screenshot` — capture a PNG of the viewport
- [ ] **TOOL-11**: `browser_evaluate` — run JS in page context
- [ ] **TOOL-12**: `browser_fill_form` — fill multiple form fields at once

### Obsidian Integration

- [ ] **OBS-01**: User can configure a vault path per bot (or globally)
- [ ] **OBS-02**: Bots can read notes from anywhere in the vault (search, read specific note, follow wikilinks)
- [ ] **OBS-03**: Bots can write only to `Agents/<bot-name>/` subfolder of the vault
- [ ] **OBS-04**: Per-bot allow/deny glob lists for vault read paths
- [ ] **OBS-05**: Global deny globs for vault paths that no bot can read (e.g., `Private/**`, `Credentials/**`)
- [ ] **OBS-06**: Bots can search vault by query and return context lines

### Security

- [x] **SEC-01**: Tool daemon runs as a separate child process from Electron main; main never touches user shell directly
- [ ] **SEC-02**: Per-bot tool allowlist + denylist enforced in the daemon, not the agent
- [ ] **SEC-03**: Global command denylist (e.g., `rm -rf /`, `sudo *`, `curl * | bash`) checked before per-bot policy
- [x] **SEC-04**: All tool calls logged to a shared audit log with timestamp, bot name, tool name, params
- [x] **SEC-05**: API key never exposed to renderer; LLM calls proxied through Electron main

### UI

- [ ] **UI-01**: Bot sidebar showing name, status indicator, last-run time
- [x] **UI-02**: Chat pane with streaming assistant text
- [ ] **UI-03**: Tool-call visual blocks (name + params + result) inline in the chat
- [ ] **UI-04**: Approval modal for shell command execution (command preview, Allow Once / Always Allow / Deny)
- [ ] **UI-05**: "New Bot" creation modal with template fields
- [ ] **UI-06**: Per-bot settings page
- [ ] **UI-07**: Run history table per bot (timestamp, duration, exit reason, error if any)
- [ ] **UI-08**: Workspace file tree + diff view for edit_file results

### Network / Tailscale

- [ ] **NET-01**: Localbot listens on a configurable port (default 7878) for HTTP/WS control
- [ ] **NET-02**: WebSocket endpoint exposes the same chat interface as the renderer
- [ ] **NET-03**: Local-only binding by default; user can opt in to LAN / Tailnet binding via a setting
- [ ] **NET-04**: Tailscale MagicDNS name shown in the UI for easy access from phone

### Packaging

- [ ] **PKG-01**: Single .exe installer for Windows via electron-builder
- [ ] **PKG-02**: App auto-updates from a configurable update channel (manual check, no auto-install)

## v2 Requirements

Deferred to future release.

### Cross-Bot Features

- **CBOT-01**: `delegate_to_agent` tool — one bot can call another (with depth limit + timeout)
- **CBOT-02**: Group agent runs that share a workspace + coordinated scheduling

### Voice

- **VOICE-01**: Voice call harness — user can call a bot and have a phone-style voice conversation
- **VOICE-02**: TTS/STT via local model

### Advanced Browser

- **BRWS-01**: Persistent browser profile per bot (cookies, sessions survive between runs)
- **BRWS-02**: Multi-tab management tools

### Persistence Enhancements

- **PERS-01**: Vector-based semantic memory (embeddings) for richer recall
- **PERS-02**: Conversation archival + full-text search across all bot history

## Out of Scope

| Feature | Reason |
|---------|--------|
| Voice / phone calls (v1) | Adds WebRTC + audio pipeline for marginal value to coding workflow. Re-evaluate after v1 ships. |
| Cross-bot communication / delegation | Recursion + deadlock risk; not needed for v1 use cases. |
| Native mobile app | Tailscale + phone browser hitting WS endpoint is sufficient. |
| Cloud sync / multi-device sync | Single-machine by design. Your PC is the only host. |
| Multi-user / team features | Single user. No auth flow, no per-user permissions. |
| Persona versioning | Old conversations load against the current persona; persona edits affect future runs only. |
| Native mobile-specific features | Push notifications to phone, mobile-responsive renderer. Use Tailscale + existing phone tools. |
| Telemetry / analytics / feature flags | Local tool, no value to collecting user data. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AGENT-01 | Phase 4 | Pending |
| AGENT-02 | Phase 4 | Pending |
| AGENT-03 | Phase 4 | Pending |
| AGENT-04 | Phase 4 | Pending |
| AGENT-05 | Phase 3 | Pending |
| AGENT-06 | Phase 3 | Pending |
| AGENT-07 | Phase 4 | Pending |
| AGENT-08 | Phase 4 | Pending |
| AGENT-09 | Phase 6 | Pending |
| AGENT-10 | Phase 6 | Pending |
| LLM-01 | Phase 1 | Complete |
| LLM-02 | Phase 1 | Complete |
| LLM-03 | Phase 2 | Pending |
| LLM-04 | Phase 3 | Pending |
| LLM-05 | Phase 1 | Complete |
| TOOL-01 | Phase 2 | Pending |
| TOOL-02 | Phase 2 | Pending |
| TOOL-03 | Phase 2 | Pending |
| TOOL-04 | Phase 2 | Pending |
| TOOL-05 | Phase 2 | Pending |
| TOOL-06 | Phase 5 | Pending |
| TOOL-07 | Phase 8 | Pending |
| TOOL-08 | Phase 8 | Pending |
| TOOL-09 | Phase 8 | Pending |
| TOOL-10 | Phase 8 | Pending |
| TOOL-11 | Phase 8 | Pending |
| TOOL-12 | Phase 8 | Pending |
| OBS-01 | Phase 7 | Pending |
| OBS-02 | Phase 7 | Pending |
| OBS-03 | Phase 7 | Pending |
| OBS-04 | Phase 7 | Pending |
| OBS-05 | Phase 7 | Pending |
| OBS-06 | Phase 7 | Pending |
| SEC-01 | Phase 1 | Complete |
| SEC-02 | Phase 2 | Pending |
| SEC-03 | Phase 5 | Pending |
| SEC-04 | Phase 1 | Complete |
| SEC-05 | Phase 1 | Complete |
| UI-01 | Phase 4 | Pending |
| UI-02 | Phase 1 | Complete |
| UI-03 | Phase 2 | Pending |
| UI-04 | Phase 5 | Pending |
| UI-05 | Phase 4 | Pending |
| UI-06 | Phase 4 | Pending |
| UI-07 | Phase 4 | Pending |
| UI-08 | Phase 3 | Pending |
| NET-01 | Phase 9 | Pending |
| NET-02 | Phase 9 | Pending |
| NET-03 | Phase 9 | Pending |
| NET-04 | Phase 9 | Pending |
| PKG-01 | Phase 9 | Pending |
| PKG-02 | Phase 9 | Pending |

**Coverage:**
- v1 requirements: 52 total
- Mapped to phases: 52
- Unmapped: 0 ✓

---

*Requirements defined: 2026-09-17*
*Last updated: 2026-09-17 after Phase 1 execution*
