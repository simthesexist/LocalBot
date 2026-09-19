# Roadmap: Localbot

## Phases

- [x] **Phase 1: Skeleton + Streaming Chat** - Electron + React shell, M3 API streaming chat, keychain + tool daemon foundation
- [x] **Phase 2: File Tools + Search + Tool System** - read/write/edit/list/code_search via per-bot allowlisted tool daemon with inline UI blocks
- [ ] **Phase 3: Memory + Conversation History** - Persistent markdown+JSON memory, JSONL history, token-budget summarization, workspace file tree
- [ ] **Phase 4: Multi-Bot CRUD + Sidebar** - Create/list/edit/delete/run/cancel bots with sidebar, modals, settings, run history
- [x] **Phase 5: Shell Exec with Approval** - exec_command tool with approval modal + global dangerous-command denylist
- [x] **Phase 6: Scheduler + Notifications** - Cron-driven bot runs + system notifications on scheduled-bot error
- [ ] **Phase 7: Obsidian Integration** - Hybrid vault access (read-anywhere, write-agents-only) with glob enforcement + vault search
- [ ] **Phase 8: Browser Automation** - Playwright-driven browser tools (navigate, click, type, fill, screenshot, evaluate)
- [ ] **Phase 9: Phone Reach + Ship** - Tailscale-friendly HTTP/WS control endpoint + Windows .exe packaging with manual update

## Phase Details

### Phase 1: Skeleton + Streaming Chat

**Goal**: Get a runnable Electron desktop app where the user can chat with the LLM and watch tokens stream back, with the API key safely in the OS keychain and a separate tool-daemon child process.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: LLM-01, LLM-02, LLM-05, SEC-01, SEC-04, SEC-05, UI-02
**Success Criteria** (what must be TRUE):

  1. User launches the Electron app and sees a chat interface
  2. User types a message and sees the assistant's response streamed token-by-token
  3. API key is stored in the OS keychain (never in plaintext on disk, never exposed to the renderer)
  4. Tool daemon runs as a separate child process from Electron main; main never spawns user shell commands directly
  5. Every tool invocation is written to a shared audit log with timestamp, bot, tool name, and params

**Plans**: 2 plans

- [x] `01-01-PLAN.md` — Walking-skeleton tracer: scaffold Electron + React 19 + Vite + TypeScript, wire safeStorage key onboarding, stdio JSON-RPC tool daemon, streaming IPC with msgId-keyed AbortController, chat-bubble UI, single global session JSONL, audit-log writer; layer cancel + retry + daemon auto-respawn + error banners.
- [x] `01-02-PLAN.md` — Test infrastructure: Vitest unit suites for NDJSON framing, session JSONL serialization, safeStorage round-trip; Playwright Electron smoke (fake M3 → first-launch key modal → streamed token); Playwright daemon smoke (spawn real daemon → `tools/call` → audit JSONL line under temp `userData`).

**UI hint**: yes

### Phase 2: File Tools + Search + Tool System

**Goal**: Bot can read, write, edit, list, and ripgrep-search files in its workspace, with every tool call enforced through the daemon's per-bot allowlist and surfaced as inline visual blocks.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: TOOL-01, TOOL-02, TOOL-03, TOOL-04, TOOL-05, LLM-03, SEC-02, UI-03
**Success Criteria** (what must be TRUE):

  1. Bot can read a file and the contents appear inline in the chat
  2. Bot can write or targeted-edit a file (creating directories as needed) and the change is visible on disk
  3. Bot can list a directory and see the entries inline
  4. Bot can run a ripgrep code search (regex + globs) and see matching lines with context
  5. A bot whose allowlist excludes a tool cannot invoke that tool — the daemon refuses before any side effect

**Plans**: 3/3 plans executed

- [x] 02-01-PLAN.md
- [x] 02-02-PLAN.md
- [x] 02-03-PLAN.md
- [ ] `02-01-PLAN.md` — Tracer slice: end-to-end `read_file` (daemon allowlist + safe_path + read_file + 4 stub siblings; main agentic loop + IPC events; renderer MessageBlock discriminated union; safe_path/read_file/allowlist unit tests; Playwright daemon-tools smoke).
- [ ] `02-02-PLAN.md` — Multi-tool surface: write_file + edit_file (atomic, single-match strict) + list_dir; agentic loop multi-turn resume (bounded at maxTurns=10); 4 new Vitest suites; daemon-tools smoke extended.
- [ ] `02-03-PLAN.md` — code_search via `@vscode/ripgrep@1.18.0` (regex + glob, max_results=200, 60s timeout, in-flight child tracking); renderer collapse-for-length + error tint; final headed smoke-tools.test.ts gated by `LOCALBOT_SMOKE_OK`.

**UI hint**: yes

### Phase 3: Memory + Conversation History

**Goal**: Each bot accumulates durable memory across sessions and prunes its own context window automatically when it fills up.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: AGENT-05, AGENT-06, LLM-04, UI-08
**Success Criteria** (what must be TRUE):

  1. Bot persists memory as a markdown file plus a JSON facts file that survive app restart
  2. Per-session conversation history is persisted as JSONL files and reloads on next session
  3. When the token budget is approached, the bot auto-summarizes older messages so the conversation can continue
  4. User can browse the bot's workspace (including memory file) in a tree view in the UI

**Plans**: 3 plans

- [ ] `03-01-PLAN.md` — Wave 1 *(tracer)*: daemon `memory_read`/`memory_write`/`list_tree` + `safe_path` containment; main `botDir`/`memoryPath`/`factsPath` + per-bot JSONL routing (`appendMessage`/`loadSession`/`migrateLegacyGlobalJsonl`) + `injectMemorySuffix` (≤4 KB cap, trims oldest H2) + `usageAccumulator` + `maybeSummarize`/`runSummarizer` (separate retry budget); renderer `MemoryPill` + `WorkspaceTree` placeholders; Playwright `memory-history.test.ts` end-to-end (fake M3 streams `usage.input_tokens: 100000`; legacy migration + head-of-JSONL summary + renderer reload).
- [ ] `03-02-PLAN.md` — Wave 2 *(blocked on Wave 1)*: full UI per UI-SPEC — `DiffView` (`react-diff-viewer-continued` + binary placeholder), `MemoryPanel` (ARIA dialog + Escape + focus trap), `SummaryBlock`, `SessionSwitcher`; `chokidar` watcher with 250 ms debounce + `tree:refresh` IPC bridge; `childAbortController` for cancel mid-summarize; audit JSONL coverage for all 9 op names; full Wave 0 Vitest suites.
- [ ] `03-03-PLAN.md` — Wave 3 *(blocked on Wave 2)*: `fake-m3-server.ts` extended with `streamEditFileToolUse` + `streamBinaryEditFile`; `memory-history.test.ts` extended with SessionSwitcher + restart-reload; new `tree-diff.test.ts` covering WorkspaceTree + DiffView + binary placeholder + chokidar refresh; visual polish + ARIA roles + final `npm ls` audit + commit.

**UI hint**: yes

### Phase 4: Multi-Bot CRUD + Sidebar

**Goal**: User can manage many bots — create, edit, delete, manually trigger, cancel — and see them all at a glance in the sidebar.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: AGENT-01, AGENT-02, AGENT-03, AGENT-04, AGENT-07, AGENT-08, UI-01, UI-05, UI-06, UI-07
**Success Criteria** (what must be TRUE):

  1. User can create a new bot with name, persona, workspace path, tool allowlist, and optional cron schedule via a "New Bot" modal
  2. User sees all bots in a sidebar with name, status (idle/running/errored/scheduled), and last-run time
  3. User can edit a bot's persona, workspace, allowlist, and schedule from a per-bot settings page
  4. User can trigger a bot manually with a message, and cancel a running bot from the sidebar
  5. User can delete a bot (folder + all state) with a confirmation prompt, and view a per-bot run history table (timestamp, duration, exit reason, error)

**Plans**: 3 plans

- [x] `04-01-PLAN.md` — Tracer slice: daemon bots/loader.cjs + bots/policy.cjs + JSON-RPC bots/list|create|delete; src/main/ipc/bots.ts + spawn.callBot + paths/config; renderer BotSidebar + NewBotModal + DeleteConfirmModal + AppModal + state/bots.ts.
- [x] `04-02-PLAN.md` — Trigger/cancel surface: daemon bots/update + bots/trigger + bots/cancel + RunRecord writes + audit; main runs/jsonl.ts + bots/runs.ts + bots/policy.ts + chat.ts req.bot routing + per-runId AbortController map; renderer SidebarComposer + SettingsEditModal + extended sidebar/row + state subscription.
- [x] `04-03-PLAN.md` — Settings page + run history + Playwright smokes: BOTS_RUNS IPC + paginated listRuns + audit minimization; BotSettingsPage (4 tabs + URL hash sync) + RunHistoryTable + state/runs.ts + App view toggle; Playwright bot-crud + multi-bot tests + fake-m3 streamBotTrigger.

**UI hint**: yes

### Phase 5: Shell Exec with Approval

**Goal**: Bot can run shell commands, but only after the user approves each one (with an opt-out for trusted commands), and globally dangerous commands are blocked outright.
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: TOOL-06, SEC-03, UI-04
**Success Criteria** (what must be TRUE):

  1. When a bot requests to run a shell command, an approval modal pops up showing the command preview with Allow Once / Always Allow / Deny buttons
  2. Globally dangerous commands (`rm -rf /`, `sudo *`, `curl * | bash`, etc.) are auto-denied before the modal even appears
  3. After approval, the command's stdout/stderr appears inline in the chat
  4. "Always Allow" lets a bot re-run the same command without prompting again

**Plans**: 3 plans
Plans:
- [ ] `05-01-PLAN.md` — Daemon core tracer: denylist + alwaysAllow + exec_command + shell/approve JSON-RPC + execCommandAuditParams + 4 unit suites (exec_denylist, exec_alwaysAllow, exec_command, exec_approve).
- [ ] `05-02-PLAN.md` — IPC + UI: ipc-channels + types + paths + spawn listeners + preload + shells.ts handler + shells state store + ApprovalModal + ApprovalModalStack + ShellStreamBlock + Composer disable + App mount + 3 unit suites.
- [ ] `05-03-PLAN.md` — Audit + defense + E2E: daemon main.cjs denylist re-check + exec_audit.test.ts (JSONL minimization) + exec_denylist_defense.test.ts (monkey-patch) + Playwright exec-command-approval.test.ts (5 E2E cases) + fake-m3 streamExecCommandToolUse.
**UI hint**: yes

### Phase 6: Scheduler + Notifications

**Goal**: Bots can run unattended on cron schedules, and the user is alerted when something goes wrong.
**Mode:** mvp
**Depends on**: Phase 5
**Requirements**: AGENT-09, AGENT-10
**Success Criteria** (what must be TRUE):

  1. User can configure a cron expression per bot from its settings page
  2. Bot fires automatically at the scheduled times without manual intervention
  3. User can enable/disable each bot's schedule independently
  4. A system notification fires when a scheduled bot errors, and each bot can opt in or out of notifications

**Plans**: 3/3 plans executed

- [x] 06-01-PLAN.md
- [x] 06-02-PLAN.md
- [x] 06-03-PLAN.md
- [x] `06-01-PLAN.md` — Wave 1 *(tracer)*: daemon `bots/trigger(trigger='cron')` JSON-RPC seam + croner lifecycle (`protect:true` + `__fireCronForTest__`) + scheduler.json persistence + audit JSONL minimization (T-P6-19: 3-key shape `{runId, trigger, messageCount}`) + AbortController registration pre-await (AGENT-08) + runSendMessageCycle error path notification event + scheduler_tick.test.ts + bots_update_atomic.test.ts cronEnabled off-cycle.
- [x] `06-02-PLAN.md` — Wave 2 *(blocked on Wave 1)*: main process `spawn.ts` onNotification bridge (debounce 30s per bot) + Electron `Notification.show` integration + IPC `EVENT_NOTIFICATION_TOAST` + `notification:click` handler + `EVENT_NAVIGATE_TO_BOT` + renderer `NotificationToast` UI + `notification_click.test.ts` + `scheduler_notification.test.ts` + `fake-m3-server.ts` `streamExecCommandToolUse` extension.
- [x] `06-03-PLAN.md` — Wave 3 *(blocked on Wave 2)*: BotSettingsPage Schedule tab `notifyOnError` + `scheduledPrompt` + cron preview (croner `nextRuns(5)`) + BotSidebar scheduled-first sort + SidebarBotRow scheduled pulse dot + RunHistoryTable trigger='cron' label + audit minimization suite (5 cases) + sidebar sort suite (6 cases) + settings schedule suite (8 cases) + Playwright `scheduler-notification.test.ts` 4-case E2E (happy/error/disabled/delete).
**UI hint**: yes

### Phase 7: Obsidian Integration

**Goal**: Bots can read the user's Obsidian vault as a knowledge source and write back only into their own `Agents/<bot-name>/` subfolder, with per-bot and global glob enforcement.
**Mode:** mvp
**Depends on**: Phase 6
**Requirements**: OBS-01, OBS-02, OBS-03, OBS-04, OBS-05, OBS-06
**Success Criteria** (what must be TRUE):

  1. User can configure a vault path globally or per-bot
  2. Bot can read any note from the vault (search, read specific note, follow wikilinks) within its per-bot allow/deny glob lists
  3. Bot can write only to `Agents/<bot-name>/` of the vault — any other write path is refused
  4. User can set global deny globs (e.g., `Private/**`, `Credentials/**`) that block every bot from reading
  5. Bot can search the vault by query and return matching lines with context

**Plans**: TBD
**UI hint**: yes

### Phase 8: Browser Automation

**Goal**: Bots can drive a real browser to fetch pages, click elements, type into inputs, fill forms, screenshot, and run JS — handling JS-heavy sites the HTTP-fetch tools cannot.
**Mode:** mvp
**Depends on**: Phase 7
**Requirements**: TOOL-07, TOOL-08, TOOL-09, TOOL-10, TOOL-11, TOOL-12
**Success Criteria** (what must be TRUE):

  1. Bot can navigate to a URL and return the rendered page contents
  2. Bot can click an element by CSS selector and observe the resulting state
  3. Bot can type into an input, and fill multiple form fields in a single tool call
  4. Bot can capture a viewport screenshot as a PNG and reference it in the chat
  5. Bot can execute arbitrary JavaScript in the page context and read the result

**Plans**: TBD
**UI hint**: yes

### Phase 9: Phone Reach + Ship

**Goal**: The app can be reached from a phone over Tailscale and ships as a single Windows installer with a manual update channel.
**Mode:** mvp
**Depends on**: Phase 8
**Requirements**: NET-01, NET-02, NET-03, NET-04, PKG-01, PKG-02
**Success Criteria** (what must be TRUE):

  1. Localbot listens on a configurable port (default 7878) for HTTP + WebSocket control
  2. A phone browser can open the WS endpoint and chat with a bot using the same interface as the desktop renderer
  3. Default binding is localhost only; the user can opt in to LAN / Tailnet binding via a setting
  4. The UI shows the current Tailscale MagicDNS name so the user knows how to reach the app from a phone
  5. App builds to a single Windows .exe installer via electron-builder, installs cleanly, and exposes a manual update-check on a configurable channel (no auto-install)

**Plans**: TBD
**UI hint**: yes

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Skeleton + Streaming Chat | 2/2 | Complete | 2026-09-17 |
| 2. File Tools + Search + Tool System | 3/3 | Complete | 2026-09-18 |
| 3. Memory + Conversation History | 3/3 | Complete | 2026-09-18 |
| 4. Multi-Bot CRUD + Sidebar | 3/3 | Complete | 2026-09-18 |
| 5. Shell Exec with Approval | 0/0 | Not started | - |
| 6. Scheduler + Notifications | 0/0 | Not started | - |
| 7. Obsidian Integration | 0/0 | Not started | - |
| 8. Browser Automation | 0/0 | Not started | - |
| 9. Phone Reach + Ship | 0/0 | Not started | - |

---

*Roadmap created: 2026-09-17*
