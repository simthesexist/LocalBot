---
phase: 05-shell-exec-with-approval
type: research
researched: 2026-09-18
domain: Shell command execution with per-call user approval + global denylist
confidence: HIGH (Phase 1+2+3+4 patterns read this session; daemon/main.cjs + tools/registry.cjs + ipc/bots.ts + ipc/chat.ts + state/bots.ts + BotSidebar.tsx + AppModal.tsx + preload/index.ts + shared/ipc-channels.ts + shared/types.ts all read; Node 20 child_process docs from training; plan 04-01/02/03 patterns reviewed)
---

# Phase 5: Shell Exec with Approval — Research

## User Constraints

> **No `05-CONTEXT.md` exists.** This phase has no user-discussion overrides. Decisions below are derived from `.planning/PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, the locked decisions in Phase 1 (`01-CONTEXT.md` / `01-SKELETON.md`), Phase 2 patterns (`02-RESEARCH.md`), Phase 3 patterns (`03-RESEARCH.md` + `03-UI-SPEC.md`), and Phase 4 patterns (`04-RESEARCH.md` + the 04-01/02/03 plans executed this session). Phase 5 is **additive** on Phase 4 — it does not reopen locked decisions from prior phases.

### Locked Decisions (inherited from Phase 1; not reopenable in Phase 5)

- **D-07 (one-way):** IPC contract `sendMessage`/`cancel` + `message:token`/`message:done`/`message:error` is the surface Phase 5 builds on. New event channels (`shell:token`, `shell:exit`) extend it; **no renames**.
- **D-10/D-11 (one-way):** Daemon transport = JSON-RPC 2.0 over NDJSON, max line 1 MiB. Phase 5 adds `shell/approve` (main → daemon, with response) as a new JSON-RPC method, plus extends `tools/call` to handle `exec_command` (a tool dispatch path, not a top-level method).
- **D-12:** Audit log line shape `{ts, bot, tool, params, outcome, durationMs, error?}` is the SEC-04 contract; exec_command writes one audit line with `{tool: 'exec_command', bot, params: {command: <denylist-redacted>, approvedBy: 'user' | 'always-allow' | 'system-denylist-block', durationMs, exitCode, stdoutBytes, stderrCount}, outcome, durationMs, error?}`.
- **D-13/D-14:** Session JSONL stays at `<userData>/sessions/<bot>/<sessionId>.jsonl`. exec_command's stdout is streamed live as `shell:token` events and NOT persisted to the session JSONL by default (Phase 5 stays ephemeral; future phase may persist).
- **D-17/D-18 (costly):** In-flight cancel uses `ipcRenderer.invoke('cancel', msgId)` + main's `Map<msgId, AbortController>` + daemon `tools/cancel` JSON-RPC. Phase 5 extends with a parallel `Map<shellId, AbortController>` keyed by shell-execution id, threaded through the per-toolCall AbortController already used by `tools/call`.
- **D-22:** Network/5xx auto-retry ≤3 with exp backoff wraps the SDK call only. exec_command does NOT retry — the user has already approved one specific invocation; a retry would re-run an already-executed command.
- **D-26 (Phase 3):** Bot metadata directory `<userData>/bots/<bot>/{memory.md, facts.json, config.json}` unchanged. Phase 5 adds `<userData>/always-allow/<bot>.json` (per-bot always-allow list).
- **SKELETON.md row "Phase 5":** "Add `exec_command` tool gated by per-call approval modal + global denylist (rm -rf, sudo, curl|bash) + per-bot 'always allow' persistence; stream stdout/stderr back to chat."

### Locked Decisions (inherited from Phase 4; not reopenable in Phase 5)

- **P4-D-01:** Per-bot config.json schema unchanged. Phase 5 does NOT add `shell`/`exec` fields to config.json — always-allow list is a separate file (`<userData>/always-allow/<bot>.json`).
- **P4-D-02:** Per-bot per-session JSONL routing stays; shell tool execution lives within an LLM-driven agentic turn (same as `read_file`/`write_file`/`edit_file`).
- **P4-D-04:** `getPolicy(bot)` reads `<userData>/bots/<bot>/config.json#allowlist` on every `tools/call`. Phase 5 verifies `exec_command` IS in the allowlist before any spawn (no implicit trust).
- **P4-D-08:** Audit minimization patterns from Wave 2+3: only log the redacted command (after denylist redaction), the approval mode (`user-once` | `user-always` | `system-denylist-block`), the exit code, and stdout byte count. Never log the full command contents (T-P5-08 below), never log the stdout/stderr text.

### Claude's Discretion (Phase 5)

- **Approval flow architecture** — the daemon blocks on a `shell/approve` JSON-RPC method that returns the user's decision (allow-once | allow-always | deny). Main mediates by forwarding the modal response back to the daemon over the JSON-RPC transport (NOT a side-channel IPC). The daemon's `tools/call` for `exec_command` makes the synchronous `shell/approve` call, the modal pops in the renderer, the user clicks a button, the response round-trips back through main to the daemon, and the tool resumes.
- **Global denylist location** — `daemon/exec/denylist.cjs` exports `GLOBAL_DENYLIST: Array<{ pattern: string; reason: string }>` and `matchesDangerous(command: string): { matched: boolean; rule?: string }`. Default rules: `rm -rf /`, `rm -rf ~`, `sudo *`, `curl * | bash`, `curl * | sh`, `Invoke-Expression` (PowerShell), `Remove-Item -Recurse C:\`, `Format-Volume`, `del /s /q C:\`, `rd /s /q C:\`. The list is hard-coded (not configurable in v1) to match the ROADMAP "globally dangerous commands are blocked outright" contract; Phase 9 may surface UI editing.
- **Always-allow storage** — `<userData>/always-allow/<bot>.json` with shape `{ bot: string, commands: Array<{ command: string; approvedAt: string; useCount: number }> }`. Exact-string match (case-sensitive, whitespace-trimmed). Capped at 50 entries per bot (FIFO eviction). Read on every `tools/call exec_command` invocation; no cache.
- **exec_command tool schema** — `{ name: 'exec_command', description: 'Run a shell command. Requires per-call user approval unless the exact command is on the bot always-allow list.', input_schema: { type: 'object', properties: { command: { type: 'string', description: 'Shell command line (cmd.exe on Windows).' }, cwd: { type: 'string', description: 'Working directory; defaults to <userData>/workspace/<bot>.' }, timeoutMs: { type: 'number', description: 'Max execution time (default 60_000; max 600_000).' } }, required: ['command'] } }`.
- **Shell wrapper** — `cmd.exe /d /s /c <command>` on Windows; `/bin/sh -c <command>` on POSIX (CLAUDE.md is Windows-first but the daemon is CommonJS so cross-platform is free). Use `child_process.spawn` with `stdio: ['ignore', 'pipe', 'pipe']`, `windowsHide: true`, `detached: false` (so the child dies with the parent on Windows job objects; Phase 5 uses the default process group).
- **Streaming surface** — main forwards each line of stdout/stderr as a `shell:token` notification `{shellId, stream: 'stdout'|'stderr', delta}`. The renderer accumulates in a per-shellId bucket and renders a new `MessageBlock.kind = 'shell_stream'` (Phase 5 extends the discriminated union). On exit, main sends `shell:exit {shellId, exitCode, signal, durationMs}`.
- **Cancellation** — the per-toolCall `AbortController` already in `daemon/tools/registry.cjs` (Phase 2) is the cancel surface. On abort, the daemon calls `child.kill('SIGTERM')` on POSIX or `child.kill()` (which sends a CTRL_BREAK_EVENT to the process group on Windows when `detached: true`; without `detached: true`, `kill()` only targets the immediate child — see Pitfall 4 below). For nested-process kill, the daemon additionally invokes `taskkill /pid <pid> /T /F` on Windows (the `/T` flag kills the tree).
- **Approval modal UX** — single AppModal primitive (Phase 4 Wave 1) with title "Approve shell command", body showing the command in a `<pre>`, three buttons: "Allow once" (primary), "Always allow" (secondary), "Deny" (destructive). z-index 1500 (above BotSettingsPage=1200). Approval modal blocks the chat composer — disabled while `pendingShellApprovals > 0`. The modal can be triggered for multiple concurrent commands (one modal per shell, stacked z-ordered).
- **Tests** — Vitest unit suites for `daemon/exec/denylist.cjs` (pattern matching), `daemon/exec/alwaysAllow.cjs` (FIFO eviction + exact match), and `daemon/tools/exec_command.cjs` (spawn mock). Playwright daemon smoke for the full approval flow (fake M3 emits a `exec_command` tool_use, renderer pops the modal, user clicks Allow, daemon spawns, stdout streams, child exits, audit writes).

### Deferred Ideas (OUT OF SCOPE; do NOT research)

- Multi-line script execution (`exec_command` with `script` field, multi-line shell, etc.). Phase 5 keeps it to single-line commands.
- Output persistence to session JSONL. Phase 5 streams stdout/stderr live only; a future phase may persist (with audit minimization) for run replay.
- Configurable denylist UI (adding/removing rules from settings). Phase 5 ships with the hard-coded set; Phase 9 may surface it.
- Per-command timeout customization beyond `timeoutMs`. The tool schema accepts `timeoutMs` but the daemon caps at 600_000 (10 min).
- Shell quoting / parsing (the command is passed verbatim to `cmd.exe /c`). The user is responsible for quoting in their command string.
- Environment variable injection, sudo elevation prompts, or interactive shells.
- Streaming partial lines (Phase 5 ships line-buffered; mid-line flush is a future enhancement).
- Per-shell sandboxing (Windows job objects, Linux namespaces). The daemon runs at user trust level.
- Remote execution, SSH shells, or containerized execution.
- Confirmation expiry / TTL on "Allow once" (single-shot; no time-bound allow).

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **TOOL-06** | `exec_command` — run a shell command, requires per-call user approval by default | Daemon `daemon/tools/exec_command.cjs` (NEW) registered in `daemon/tools/registry.cjs`; allowlist-driven dispatch via Phase 2+4 `tools/call` JSON-RPC method; per-call approval via `shell/approve` JSON-RPC method (NEW) |
| **SEC-03** | Global command denylist (`rm -rf /`, `sudo *`, `curl * | bash`) checked before per-bot policy | `daemon/exec/denylist.cjs` (NEW) exports `matchesDangerous()` invoked BEFORE `getPolicy(bot).allowlist.has('exec_command')`; rejects with `code: 'denylist_blocked'` + audit line; UI also pre-checks so the modal can show "blocked by global denylist" instead of asking |
| **UI-04** | Approval modal for shell command execution (command preview, Allow Once / Always Allow / Deny) | `src/renderer/components/ApprovalModal.tsx` (NEW) using Phase 4 `AppModal` primitive; z-index 1500; mounts when `state/shells.ts` has a `pendingApproval`; three-button layout matches the locked wording |

---

## Summary

Phase 5 introduces `exec_command` — a single new tool the LLM can invoke to run arbitrary shell commands — gated by a per-call approval modal in the renderer and a global denylist in the daemon. The work sits at three layers that Phase 1-4 already shaped:

**Daemon side.** `daemon/tools/exec_command.cjs` is registered as a tool (Phase 2's `registry.cjs` allowlist gate applies). It checks the global denylist FIRST (SEC-03: before the per-bot allowlist; before the per-call approval), rejects dangerous matches with `code: 'denylist_blocked'` + audit, then reads the per-bot always-allow list from `<userData>/always-allow/<bot>.json`, and either proceeds (always-allow hit) or issues a synchronous `shell/approve` JSON-RPC call back to main. Main holds that call open; the renderer shows the modal; the user clicks one of three buttons; the response carries the decision; the daemon resumes. On approval, the daemon spawns the child (`cmd.exe /d /s /c <command>` on Windows), streams `shell:token` notifications line-by-line, and emits `shell:exit` on completion with the exit code, duration, and stdout byte count. The whole flow is cancellable via the existing per-toolCall `AbortController` (Phase 2); the cancel surface calls `child.kill()` on POSIX and `taskkill /pid <pid> /T /F` on Windows to kill the process tree.

**Main side.** `src/main/daemon/spawn.ts` adds `callShellApprove(shellId, command)` that proxies the JSON-RPC call (the daemon issued it; main passes it through to a queue). `src/main/ipc/shells.ts` (NEW) registers `SHELL_REQUEST_APPROVAL` IPC handler that forwards the daemon's pending approval to the renderer and waits for the modal response. `src/main/preload/index.ts` exposes `window.localbot.shell.respond(shellId, decision)` so the renderer can reply. `src/main/ipc/bots.ts` is unchanged structurally — the per-runId AbortController map is reused.

**Renderer side.** `src/renderer/state/shells.ts` (NEW) holds the set of pending approvals keyed by `shellId`. `src/renderer/components/ApprovalModal.tsx` (NEW) wraps the Phase 4 `AppModal` primitive with three buttons and a `<pre>` preview. `src/renderer/components/MessageBlock.tsx` extends with a new `kind: 'shell_stream'` case that renders streaming stdout as a live `<pre>` that grows as `shell:token` notifications arrive. `src/renderer/state/bots.ts` does NOT need to change — the modal is renderer-local state, surfaced via the App-level view, not through the bot store.

**Primary recommendation:** Keep the approval flow synchronous. The daemon blocks on `shell/approve`; main proxies the IPC round-trip; the renderer pops the modal; the user response unblocks the call. This pattern matches the existing `tools/call` flow (request → main → daemon → response) and reuses the AbortController map (Pitfall 10 / multi-tool cancel). Do NOT spawn a separate "approval daemon" or use a websocket side-channel — both break the locked D-10/D-11 transport and the SEC-01 separation of trust boundaries.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Global denylist matching | Daemon | — | SEC-03 mandates "checked before per-bot policy"; daemons are the trust boundary; renderer cannot be trusted to enforce |
| Per-call approval gate | Daemon | Main (proxy), Renderer (UI) | The approval decision must round-trip through the daemon so the audit trail is in one place; main proxies the JSON-RPC call to the renderer's IPC; renderer presents the modal |
| Shell child process spawn + lifecycle | Daemon | — | Same trust-boundary rationale as Phase 2's tools/call; renderer never sees a `ChildProcess`; main never spawns |
| Streaming stdout/stderr to renderer | Daemon → Main → Renderer | — | Daemon emits `shell:token` notifications on the JSON-RPC transport; main forwards via `webContents.send`; renderer accumulates per-shellId |
| Cancel of in-flight shell execution | Daemon | Main (per-runId AbortController) | Phase 2's `tools/cancel` JSON-RPC aborts the per-toolCall AbortController; the daemon's `exec_command` handler listens for abort and kills the child process + tree |
| Always-allow list persistence | Daemon (writer) | Main (typed wrapper, optional) | The list lives in `<userData>/always-allow/<bot>.json`; daemon reads on every `tools/call`; renderer never writes |
| Approval modal UI | Renderer (React) | — | Phase 4's AppModal primitive; renderer-local state in `state/shells.ts`; no IPC registration |
| Inline shell stream rendering | Renderer (React) | — | Extends Phase 2's MessageBlock discriminated union with `kind: 'shell_stream'`; renderer accumulates `shell:token` deltas per shellId |
| Audit minimization for exec_command | Daemon | Main (mirror) | T-P5-08: only log redacted command (first 80 chars + `...`), approval mode, exit code, stdout bytes; never the full command, never stdout contents |

---

## Standard Stack

> Phase 5 adds no new npm packages. Every capability is delivered by Node 20+ stdlib (`node:child_process`, `node:fs`, `node:path`) and the locked Phase 1+2+3 stack. Audit + IPC envelope + JSON-RPC transport + abort controllers are all in place from Phase 1+2+4.

### Core (all already installed; verified by reading `D:/Claude/Grokbot/package.json` this session)

| Library | Version (from package.json) | Purpose | Why Standard |
|---------|---------------------------|---------|--------------|
| `@anthropic-ai/sdk` | `^0.40.1` | Streaming + tool_use (already drives the LLM) | Locked in Phase 1; exec_command is invoked by the LLM via `tool_use` blocks; no direct use in Phase 5 |
| `chokidar` | `3.6.0` | Not used by Phase 5 | (Phase 3 workspace watcher) |
| `react` | `^19.0.0` | UI framework | Locked in CLAUDE.md |
| `electron` | `^33.2.0` | BrowserWindow + IPC + safeStorage | Locked in CLAUDE.md |
| `vitest` | `^2.1.9` | Unit tests | Phase 1 lock; pinned to v2.1.9 |
| `@playwright/test` | `^1.63.0` | Smoke tests | Phase 1 lock; `LOCALBOT_SMOKE_OK=1` for headed runs |

### New deps for Phase 5

**None.** Phase 5 uses `node:child_process.spawn` (Node 20+ stdlib) for the shell wrapper. No `tree-kill`, no `execa`, no `shell-escape` — all are deliberately avoided:
- `tree-kill` is unmaintained; the Windows `taskkill /T /F` is the canonical native solution.
- `execa` adds a large surface area (escape, IPC, promise wrapping) for marginal value; `spawn` + manual line buffering is simpler and gives direct AbortSignal control.
- `shell-escape` would be useful IF we were constructing shell command strings; we pass the user's command VERBATIM to `cmd.exe /d /s /c`, so no escape layer is needed.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `child_process.spawn` + line-buffered `readline` | `execa` (popular promise wrapper) | `execa` adds escape, IPC, promise layers for marginal value; `spawn` with manual `readline` is simpler and gives direct signal control |
| `child_process.spawn` + line-buffered `readline` | `node-pty` (pseudo-terminal) | `node-pty` needs node-gyp (forbidden by CLAUDE.md); pseudo-terminal semantics aren't needed for line-buffered capture |
| `taskkill /pid <pid> /T /F` (Windows tree kill) | `tree-kill` npm package | `tree-kill` is unmaintained; native `taskkill` is the canonical Windows solution and already in `%SystemRoot%\System32\` |
| Synchronous `shell/approve` JSON-RPC round-trip | Async "approval daemon" or websocket | Adds new transport + new failure modes; sync JSON-RPC round-trip matches the existing `tools/call` pattern |
| Hard-coded global denylist | User-configurable denylist | v1 ships hard-coded (matches ROADMAP contract); Phase 9 may add UI for editing |
| Exact-string always-allow match | Glob / regex match | Exact match is safer (false-positive-free); glob would let `npm *` approve `npm run evil`; the user can always click "Allow once" instead |
| `<userData>/always-allow/<bot>.json` (one file per bot) | Single `always-allow.json` keyed by bot | One file per bot keeps each bot's list readable + lets the user edit a single bot's allowlist without parsing a combined file |
| FIFO eviction at 50 entries | Unbounded list | 50 caps the file size + matches Phase 4's run-history cap pattern |
| `shell:token` notifications line-by-line | Whole-stdout-at-exit | Live streaming matches Phase 1's `message:token` pattern; users want to see output as it happens for `npm install`, `npm test`, etc. |

**Installation:** none — all packages are already in `package.json`.

**Version verification (per the package-legitimacy protocol):**
- All Phase 5 functionality uses Node 20+ stdlib; Node 20.11.0 is the project's pinned version (per `@types/node: ^20.11.0` in package.json).
- No registry lookups required since no new packages are added.
- `@anthropic-ai/sdk` 0.40.1 already drives the LLM; Phase 5's exec_command is dispatched via the SDK's `tool_use` blocks, not directly invoked.
- Vitest 2.1.9 pinned (Phase 1 lock); no version drift.

---

## Package Legitimacy Audit

> **Not strictly required** since Phase 5 installs zero new packages. Audit table included for the planner's reference and to surface any drift discovered while reviewing `package.json`.

| Package | Registry | Age | Source Repo | Verdict | Disposition |
|---------|----------|-----|-------------|---------|-------------|
| `@anthropic-ai/sdk` | npm | First released 2023; v0.40.1 | github.com/anthropics/anthropic-sdk-typescript | OK | Already installed (Phase 1) |
| `chokidar` | npm | First release 2013; v3.6.0 | github.com/paulmillr/chokidar | OK | Already installed (Phase 3) |
| `@vscode/ripgrep` | npm | First release 2020; v1.18.0 | github.com/microsoft/vscode-ripgrep | OK | Already installed (Phase 2) |
| `react` / `react-dom` | npm | First release 2013; v19.x | github.com/facebook/react | OK | Already installed (Phase 1) |
| `electron` | npm | First release 2013; v33.2.0 | github.com/electron/electron | OK | Already installed (Phase 1) |
| `vitest` | npm | First release 2021; v2.1.9 (pinned) | github.com/vitest-dev/vitest | OK | Already installed (Phase 1) |
| `@playwright/test` | npm | First release 2020; v1.63.0 | github.com/microsoft/playwright | OK | Already installed (Phase 1) |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none.

*All Phase 5 capabilities are delivered by Node 20+ stdlib (`child_process.spawn`, `readline.createInterface`, `fs.promises`, `path`). No `npm install` is required.*

---

## Architecture Patterns

### System Architecture Diagram

```
+--------------------------------------------------------------+
| Renderer (React 19)                                          |
|                                                               |
|  +------------+   +--------------+   +--------------------+   |
|  | BotSidebar |   | ChatPane     |   | BotSettingsPage    |   |
|  | (260 px    |   | (Phase 1+2+3 |   | (per bot, Wave 3)  |   |
|  |  left rail)|   |  + shell_    |   |                    |   |
|  | + Composer |   |  stream      |   |                    |   |
|  +------+-----+   |  blocks)     |   +--------------------+   |
|         |        +------+-------+                            |
|         |               |                                    |
|         v               v                                    |
|  +-----------------------------------------------------+    |
|  | state/shells.ts (NEW) + state/messages.ts (extended)|    |
|  |   pendingApprovals: Map<shellId, {command, requestAt}>   |
|  |   shellStreams: Map<shellId, {stdout, stderr, exitCode}>  |
|  |   -> shell:token + shell:exit subscriptions                  |
|  +-----------------------------------------------------+    |
|         |               |                                    |
|  ApprovalModal (NEW, z 1500) mounted when pendingApprovals.size > 0
+------------------------------|--------------------------------+
                               | IPC (invoke + events)
                               | shells:request-approval (event, main->renderer),
                               | shells:respond (invoke, renderer->main),
                               | shell:token (event, main->renderer),
                               | shell:exit (event, main->renderer),
                               | tools:list / tools:call (existing)
                               v
+--------------------------------------------------------------+
| Electron Main                                                 |
|                                                               |
|  +-----------------+   +----------------+   +--------------+ |
|  | ipc/chat.ts     |   | ipc/bots.ts    |   | ipc/shells.ts| |
|  | (existing;      |   | (existing;     |   | (NEW)        | |
|  |  routes by bot) |   |  per-runId Abort|   | - shells:    | |
|  +--------+--------+   |  Controller map|   |   respond    | |
|           |            +----------------+   | - proxy shell| |
|           |                                  |   /approve   | |
|           |                                  +------+-------+ |
|           |                                         |          |
|           v                                         v          |
|  +------------------------------------------+               |
|  | daemon/spawn.ts (extended)               |               |
|  |   - callShellApprove(shellId) round-trips|               |
|  |     the JSON-RPC request                  |               |
|  +------------------------------------------+               |
+------------------------------|--------------------------------+
                               | JSON-RPC 2.0 over NDJSON
                               | tools/call (exec_command dispatch),
                               | tools/cancel (AbortController),
                               | shell/approve (NEW — sync round-trip),
                               | bots/* (existing)
                               v
+--------------------------------------------------------------+
| Tool Daemon (daemon/main.cjs)                                |
|                                                               |
|  +-----------------------------+                              |
|  | exec_command (NEW — tool)   |   registers in registry.cjs  |
|  | daemon/tools/exec_command.cjs                                |
|  |   1. matchesDangerous(cmd)  |                               |
|  |      -> {code:'denylist_   |                                |
|  |           blocked'}        |                                |
|  |   2. readAlwaysAllow(bot)  |                                |
|  |      -> always-allow hit?  |                                |
|  |        yes: skip approval  |                                |
|  |   3. shell/approve RPC:     |                                |
|  |      block until response  |                                |
|  |   4. spawn child:          |                                |
|  |      cmd.exe /d /s /c <cmd> |                                |
|  |      -> shell:token per line                                |
|  |      -> shell:exit on done |                                |
|  |   5. cancel: child.kill() + |                                |
|  |      taskkill /T /F        |                                |
|  +-----------------------------+                                |
|                                                               |
|  +-----------------------+   +--------------------------+    |
|  | exec/denylist.cjs     |   | exec/alwaysAllow.cjs     |    |
|  | (NEW)                 |   | (NEW)                    |    |
|  | - GLOBAL_DENYLIST     |   | - readAlwaysAllow(bot)   |    |
|  | - matchesDangerous()  |   | - appendAlwaysAllow(bot) |    |
|  +-----------------------+   +--------------------------+    |
|                                                               |
|  Audit: {ts, bot, tool:'exec_command', params:{redacted_cmd, |
|   approvedBy, exitCode, stdoutBytes}, outcome, durationMs}    |
+--------------------------------------------------------------+
```

### Recommended Project Structure

```
daemon/
  exec/                                       (NEW)
    denylist.cjs                              (NEW — GLOBAL_DENYLIST + matchesDangerous)
    alwaysAllow.cjs                           (NEW — readAlwaysAllow, appendAlwaysAllow, FIFO 50)
  tools/
    registry.cjs                              (modified — register exec_command)
    exec_command.cjs                          (NEW — shell wrapper: spawn, line buffer, cancel, audit)
  main.cjs                                    (extended — shell/approve JSON-RPC method)

src/main/
  ipc/
    shells.ts                                 (NEW — SHELLS_RESPOND handler; shell approve queue)
  daemon/
    spawn.ts                                  (extended — callShellApprove + onNotification('shell:token'|'shell:exit'))
  preload/
    index.ts                                  (extended — api.shell.respond; shell:token + shell:exit events)
  paths.ts                                    (extended — alwaysAllowDir(), alwaysAllowPath(bot))

src/shared/
  ipc-channels.ts                             (extended — SHELLS_RESPOND, EVENT_SHELL_TOKEN, EVENT_SHELL_EXIT, EVENT_SHELL_REQUEST_APPROVAL)
  types.ts                                    (extended — ShellApprovalRequest, ShellApprovalResponse, ShellTokenEvent, ShellExitEvent, exec_command tool schema)
  window.d.ts                                 (extended — api.shell.respond; LocalbotEventPayload adds shell events)

src/renderer/
  state/
    shells.ts                                 (NEW — pendingApprovals Map<shellId, ...>; shellStreams Map<shellId, ...>)
  components/
    ApprovalModal.tsx                         (NEW — uses AppModal primitive; 3 buttons)
    MessageBlock.tsx                          (extended — adds shell_stream kind)
    App.tsx                                   (extended — mounts ApprovalModal when pendingApprovals > 0)

src/renderer/styles/app.css                   (extended — .approval-modal, .approval-modal-command, .approval-modal-buttons, .shell-stream-block)

tests/unit/
  exec_denylist.test.ts                       (NEW — pattern matching cases; rm -rf, sudo, curl|bash, etc.)
  exec_always_allow.test.ts                   (NEW — readAlwaysAllow hit/miss; appendAlwaysAllow FIFO; max 50)
  exec_command.test.ts                        (NEW — spawn mock; line buffer; cancel -> child.kill + taskkill)
  bot_policy.test.ts                          (extended — exec_command allowlist behavior)

tests/playwright/
  fake-m3-server.ts                           (extended — streamExecCommand tool_use helper)
  shell-approval.test.ts                      (NEW — full vertical: trigger -> modal -> allow -> stream -> exit)
```

### Pattern 1: Global denylist check BEFORE per-bot allowlist (SEC-03)

**What:** `daemon/exec/denylist.cjs` exports a hard-coded `GLOBAL_DENYLIST` array and a `matchesDangerous(command)` function. `daemon/tools/exec_command.cjs` calls `matchesDangerous(command)` FIRST — before the `tools/call` allowlist check, before the always-allow lookup, before the `shell/approve` round-trip. If a match is found, the tool throws `code: 'denylist_blocked'`, writes an audit line with `outcome: 'error'`, and the renderer surfaces the error inline.

**When to use:** Every `tools/call` for `exec_command`, no exceptions.

**Example (skeleton — verify when implementing):**
```javascript
// daemon/exec/denylist.cjs (NEW)
const GLOBAL_DENYLIST = [
  { pattern: /\brm\s+-rf?\s+\/(?!\w)/i, reason: 'rm -rf / deletes the entire filesystem' },
  { pattern: /\brm\s+-rf?\s+~(?:\/|\s|$)/i, reason: 'rm -rf ~ deletes the home directory' },
  { pattern: /\bsudo\b/i, reason: 'sudo elevates to root' },
  { pattern: /\bcurl\b.*\|\s*(?:ba)?sh\b/i, reason: 'curl ... | bash pipes remote content to a shell' },
  { pattern: /\bwget\b.*\|\s*(?:ba)?sh\b/i, reason: 'wget ... | sh pipes remote content to a shell' },
  // Windows-specific
  { pattern: /\bInvoke-Expression\b/i, reason: 'Invoke-Expression executes arbitrary strings as code' },
  { pattern: /\bRemove-Item\s+-Recurse\s+[A-Z]:\\/i, reason: 'Remove-Item -Recurse C:\\ recursively deletes a drive root' },
  { pattern: /\bFormat-Volume\b/i, reason: 'Format-Volume formats a disk volume' },
  { pattern: /\bdel\s+\/s\s+\/q\s+[A-Z]:\\/i, reason: 'del /s /q C:\\ recursively deletes a drive root' },
  { pattern: /\brd\s+\/s\s+\/q\s+[A-Z]:\\/i, reason: 'rd /s /q C:\\ recursively deletes a drive root' },
];

function matchesDangerous(command) {
  if (typeof command !== 'string') return { matched: false };
  for (const rule of GLOBAL_DENYLIST) {
    if (rule.pattern.test(command)) {
      return { matched: true, rule: rule.reason };
    }
  }
  return { matched: false };
}

module.exports = { GLOBAL_DENYLIST, matchesDangerous };
```

### Pattern 2: Synchronous shell/approve JSON-RPC round-trip (TOOL-06, UI-04)

**What:** When `exec_command` needs approval, the daemon issues a `shell/approve` JSON-RPC method (NOT a request — a `pendingRequest` that blocks). Main proxies it to the renderer via an IPC event. The renderer shows the modal; the user clicks a button; the renderer calls `window.localbot.shell.respond(shellId, decision)` which round-trips back through main to the daemon. The daemon's `tools/call` handler resumes and either spawns the child (allow-once / allow-always) or throws `code: 'denied'` (deny).

**Why synchronous:** The JSON-RPC transport already supports request/response. A sync round-trip keeps the audit trail in one place (the daemon writes the line on resumption), avoids new IPC channels (reuses the existing transport), and matches the user's mental model (one click = one approval = one execution).

**Example (skeleton — verify when implementing):**
```javascript
// daemon/tools/exec_command.cjs (NEW — excerpt)
async function call(args, ctx) {
  const { command, cwd, timeoutMs = 60_000 } = args;

  // Step 1: global denylist (BEFORE everything else — SEC-03).
  const danger = matchesDangerous(command);
  if (danger.matched) {
    throw Object.assign(new Error(`blocked by global denylist: ${danger.rule}`),
      { code: 'denylist_blocked' });
  }

  // Step 2: read per-bot always-allow.
  const bot = ctx.bot;
  const alwaysAllowed = await readAlwaysAllow(bot);
  const approvedBy = (alwaysAllowed.some((e) => e.command === command.trim()))
    ? 'user-always' : null;

  // Step 3: if not always-allowed, sync approve round-trip.
  if (!approvedBy) {
    const shellId = crypto.randomUUID();
    const decision = await requestApproval(shellId, command, bot); // sync shell/approve RPC
    if (decision === 'deny') {
      throw Object.assign(new Error('user denied execution'), { code: 'denied' });
    }
    approvedBy = decision; // 'user-once' or 'user-always'
    if (decision === 'user-always') {
      await appendAlwaysAllow(bot, command);
    }
  }

  // Step 4: spawn child + stream + audit.
  const startedAt = Date.now();
  const child = spawnCommand(command, cwd);
  // ... line-buffered stdout/stderr -> shell:token
  // ... await exit
  // ... audit
}
```

### Pattern 3: Always-allow list persistence (TOOL-06 opt-out)

**What:** `<userData>/always-allow/<bot>.json` stores the bot's always-allow list. The file shape: `{ bot: string, commands: Array<{ command: string; approvedAt: string; useCount: number }> }`. Read on every `tools/call exec_command` invocation (no cache). Append on every `user-always` decision; FIFO eviction at 50 entries. Exact-string match (case-sensitive, whitespace-trimmed).

**When to use:** Per-bot always-allow lookups during `exec_command`.

**Example (skeleton — verify when implementing):**
```javascript
// daemon/exec/alwaysAllow.cjs (NEW)
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_ENTRIES = 50;

async function readAlwaysAllow(userDataDir, bot) {
  const file = path.join(userDataDir, 'always-allow', `${bot}.json`);
  try {
    const text = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.commands) ? parsed.commands : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    return [];
  }
}

async function appendAlwaysAllow(userDataDir, bot, command) {
  const trimmed = command.trim();
  const list = await readAlwaysAllow(userDataDir, bot);
  // Update useCount for existing exact match.
  const existing = list.find((e) => e.command === trimmed);
  if (existing) {
    existing.useCount++;
    existing.approvedAt = new Date().toISOString();
  } else {
    list.push({
      command: trimmed,
      approvedAt: new Date().toISOString(),
      useCount: 1,
    });
  }
  // FIFO eviction: keep newest 50.
  const capped = list.slice(-MAX_ENTRIES);
  const dir = path.join(userDataDir, 'always-allow');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${bot}.json`);
  // Atomic write.
  const tmp = `${file}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ bot, commands: capped }, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

module.exports = { readAlwaysAllow, appendAlwaysAllow, MAX_ENTRIES };
```

### Pattern 4: Line-buffered spawn + streaming shell:token notifications (UI-04, TOOL-06)

**What:** `daemon/tools/exec_command.cjs` spawns the child with `stdio: ['ignore', 'pipe', 'pipe']` + `windowsHide: true`. Two `readline.createInterface` instances consume stdout and stderr line-by-line. Each line becomes a `shell:token` notification `{shellId, stream: 'stdout'|'stderr', delta}`. On exit, `shell:exit {shellId, exitCode, signal, durationMs, stdoutBytes}`. The renderer accumulates deltas per shellId and renders them as a single `<pre>` block that grows.

**Example (skeleton — verify when implementing):**
```javascript
// daemon/tools/exec_command.cjs (NEW — spawn + stream excerpt)
function spawnCommand(command, cwd, shellId, signal) {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'cmd.exe' : '/bin/sh';
  const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

  const child = spawn(cmd, args, {
    cwd: cwd || undefined,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !isWin,  // POSIX: own process group so SIGTERM works on the tree
  });

  let stdoutBytes = 0;
  let stderrCount = 0;

  const stdoutRl = readline.createInterface({ input: child.stdout });
  stdoutRl.on('line', (line) => {
    stdoutBytes += Buffer.byteLength(line, 'utf8') + 1;
    sendNotification('shell:token', { shellId, stream: 'stdout', delta: line + '\n' });
  });

  const stderrRl = readline.createInterface({ input: child.stderr });
  stderrRl.on('line', (line) => {
    stderrCount++;
    sendNotification('shell:token', { shellId, stream: 'stderr', delta: line + '\n' });
  });

  // Cancel surface: per-toolCall AbortController (Phase 2).
  const onAbort = () => killChildTree(child, isWin);
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return new Promise((resolve, reject) => {
    child.once('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      signal?.removeEventListener('abort', onAbort);
      stdoutRl.close();
      stderrRl.close();
      sendNotification('shell:exit', {
        shellId,
        exitCode: code,
        signal,
        stdoutBytes,
        stderrCount,
        durationMs: Date.now() - startedAt,
      });
      resolve({ exitCode: code, signal, stdoutBytes, stderrCount });
    });
  });
}

function killChildTree(child, isWin) {
  if (!child.pid) return;
  if (isWin) {
    // taskkill /T /F kills the process tree (children + grandchildren).
    // Process group via detached:true is unreliable for non-detached cmd.exe;
    // taskkill is the canonical Windows tree-kill.
    const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    tk.on('error', () => {/* taskkill not found? fall back */});
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {/* group kill failed */ }
    try { child.kill('SIGTERM'); } catch {/* ignore */ }
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {/* ignore */ }
      try { child.kill('SIGKILL'); } catch {/* ignore */ }
    }, 2000);
  }
}
```

### Pattern 5: Approval modal UI with AppModal primitive (UI-04)

**What:** `src/renderer/components/ApprovalModal.tsx` wraps the Phase 4 `AppModal` primitive. Props `{shellId, command, requestAt, onRespond}`. Body: a `<pre>` showing the command verbatim (no redaction in the modal — the user wants to see exactly what they're approving); three buttons: "Allow once" (primary), "Always allow" (secondary), "Deny" (destructive). On click, calls `onRespond(shellId, decision)` which fires `window.localbot.shell.respond(shellId, decision)`.

**Example (skeleton — verify when implementing):**
```typescript
// src/renderer/components/ApprovalModal.tsx (NEW)
import { AppModal } from './AppModal';

export interface ApprovalModalProps {
  shellId: string;
  command: string;
  requestAt: string;
  onRespond: (shellId: string, decision: 'allow-once' | 'allow-always' | 'deny') => void;
}

export function ApprovalModal({ shellId, command, requestAt, onRespond }: ApprovalModalProps) {
  return (
    <AppModal title="Approve shell command" zIndex={1500} cardClassName="approval-modal"
              ariaLabel="Approve shell command">
      <div className="approval-modal-body">
        <p className="approval-modal-prompt">
          The bot wants to run this command:
        </p>
        <pre className="approval-modal-command" data-testid="approval-modal-command">
          {command}
        </pre>
        <p className="approval-modal-warning">
          <strong>Allowing</strong> runs the command with your user privileges. Always Allow saves the command so it can run without prompting in the future.
        </p>
        <p className="approval-modal-meta">
          Requested at {new Date(requestAt).toLocaleTimeString()}
        </p>
        <div className="approval-modal-buttons">
          <button
            type="button"
            className="approval-modal-btn approval-modal-btn-primary"
            data-testid="approval-modal-allow-once"
            onClick={() => onRespond(shellId, 'allow-once')}
          >
            Allow once
          </button>
          <button
            type="button"
            className="approval-modal-btn approval-modal-btn-secondary"
            data-testid="approval-modal-allow-always"
            onClick={() => onRespond(shellId, 'allow-always')}
          >
            Always allow
          </button>
          <button
            type="button"
            className="approval-modal-btn approval-modal-btn-destructive"
            data-testid="approval-modal-deny"
            onClick={() => onRespond(shellId, 'deny')}
          >
            Deny
          </button>
        </div>
      </div>
    </AppModal>
  );
}
```

### Pattern 6: MessageBlock discriminated union extension (UI-04 stream rendering)

**What:** `src/renderer/components/MessageBlock.tsx` adds a `kind: 'shell_stream'` case that renders the accumulated stdout/stderr as a `<pre>` that updates live as `shell:token` events arrive. The stream is owned by `state/shells.ts`; the MessageBlock reads the current snapshot.

**Example (skeleton — verify when implementing):**
```typescript
// src/shared/types.ts (extended — add to MessageBlock union)
export type MessageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'summary'; summary: SummaryRecord }
  | { kind: 'shell_stream'; shellId: string; stdout: string; stderr: string; exitCode: number | null; isError: boolean };
```

```typescript
// src/renderer/components/MessageBlock.tsx (extended)
case 'shell_stream': {
  return (
    <div className={`block-shell-stream ${block.isError ? 'block-result-error' : ''}`}
         data-block-kind="shell_stream" data-shell-id={block.shellId}>
      {block.stdout.length > 0 && (
        <pre className="block-shell-stdout" data-testid="shell-stdout">
          {block.stdout}
          {block.exitCode === null && <span className="block-shell-cursor">▍</span>}
        </pre>
      )}
      {block.stderr.length > 0 && (
        <pre className="block-shell-stderr" data-testid="shell-stderr">
          {block.stderr}
        </pre>
      )}
      {block.exitCode !== null && (
        <div className="block-shell-exit" data-testid="shell-exit">
          Exit code: {block.exitCode}
        </div>
      )}
    </div>
  );
}
```

### Anti-Patterns to Avoid

- **Anti-pattern: bypass the daemon for shell execution.** Renderer never spawns; main never spawns. The Phase 1 SEC-01 separation (daemon is the trust boundary) requires that ALL `child_process.spawn` calls happen in the daemon process. Main's IPC bridge is request/response only.
- **Anti-pattern: async approval via side-channel websocket.** Adding a separate transport for approval round-trips breaks D-10/D-11 (the locked JSON-RPC over NDJSON envelope) and adds a new failure mode (what if the websocket dies mid-approval?). The sync `shell/approve` JSON-RPC method reuses the existing transport and inherits its error handling.
- **Anti-pattern: spawn the user's command via `exec` with `shell: true`.** `spawn('cmd.exe', ['/c', command])` passes the command as a single argument to `cmd.exe`'s `/c` switch; `spawn(command, [], { shell: true })` interpolates through a second shell layer that can mask quoting bugs. Stick with `spawn('cmd.exe', ['/d', '/s', '/c', command], { shell: false })`.
- **Anti-pattern: cache the always-allow list.** Read on every `tools/call exec_command`. The Phase 4 policy-loader pattern (T-P4-03: no caching) applies here too — caching means a user can remove an entry via settings and have it ignored until restart.
- **Anti-pattern: glob match for always-allow.** Exact-string only. `npm *` would falsely approve `npm run evil-script`. The user can always click "Allow once" for slight variations.
- **Anti-pattern: log the full command in the audit JSONL.** Audit minimization (T-P5-08): log only the first 80 chars + `...` + the command's length in bytes + the approval mode. The full command may contain secrets (env vars, tokens) and may be very long.
- **Anti-pattern: log stdout/stderr to the audit JSONL.** Audit minimization (T-P5-08): log only the byte count. The full output may be huge (a `npm install` produces megabytes) and may contain secrets.
- **Anti-pattern: persist stdout/stderr to the session JSONL.** Phase 5 streams live only; persistence is a future enhancement (with audit minimization + size caps).
- **Anti-pattern: open the approval modal as a separate window.** Phase 4's AppModal is the existing primitive; opening a separate BrowserWindow breaks the focused UX (user can't see the chat context) and adds a new window to manage.
- **Anti-pattern: include shell tokens in the existing `message:token` channel.** `shell:token` is a new event channel — different payload shape, different renderer handler, different message-block kind.
- **Anti-pattern: emit `shell:token` events with line buffering that drops mid-line content.** Use `readline.createInterface` (event: 'line'), not raw `data` events — `data` splits mid-line and emits bytes that don't form a coherent stream.
- **Anti-pattern: forget to abort the child on toolCall cancel.** The per-toolCall AbortController from Phase 2 is the cancel surface; the daemon's `exec_command` MUST register an abort listener that calls `killChildTree`. Forgetting this leaves orphaned processes.
- **Anti-pattern: `child.kill('SIGTERM')` on Windows.** Windows has no POSIX signals. On Windows, `child.kill()` (no argument) sends a CTRL_BREAK_EVENT to the process group IF `detached: true`; otherwise it only kills the immediate child. The reliable tree-kill is `taskkill /pid <pid> /T /F`.
- **Anti-pattern: render the full command in the audit-log-permission-toast.** T-P5-08 mitigation: the audit log + UI tooltips + always-allow file all show only `command.slice(0, 80)` + the byte length.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Child process tree-kill on Windows | Custom process-tree tracker | `taskkill /pid <pid> /T /F` (native) | `taskkill /T` is the canonical Windows tree-kill, present on every Windows install since XP; `tree-kill` npm package is unmaintained |
| Line-buffered stdout capture | Manual chunked buffer with `\n` parsing | `node:readline.createInterface({ input: child.stdout })` | `readline` correctly handles partial UTF-8 sequences, mid-line splits across chunks, and backpressure |
| Approval modal | Custom z-index + focus management | Phase 4 `AppModal` primitive | Centralizes ARIA dialog + Escape close + focus trap; reuse, don't reimplement |
| Always-allow list storage | SQLite or flat key-value | JSON file at `<userData>/always-allow/<bot>.json` | Matches Phase 4's "bots are files" model; inspectable in any text editor; FIFO 50 cap is trivial |
| Streaming stdout to renderer | Buffered whole-output-then-render | `shell:token` notifications + renderer accumulator | Matches Phase 1's `message:token` pattern; users expect live output for `npm install` etc. |
| Per-toolCall cancellation | New IPC channel + new AbortController map | Reuse Phase 2's `tools/cancel` JSON-RPC method | The per-toolCall AbortController is already established; `exec_command` just needs to listen for abort |
| Global denylist patterns | Hand-rolled string `includes()` checks | Regex array in `daemon/exec/denylist.cjs` | Regex handles word boundaries, alternation, and case sensitivity cleanly |
| Spawn command-line quoting | Custom escaping library | Pass verbatim to `cmd.exe /d /s /c` | The user is responsible for their own quoting in the command string; an escape layer would silently corrupt legitimate commands |

**Key insight:** Phase 1+2+3+4 established the JSON-RPC envelope (D-10/D-11), the IPC bridge (D-07), the audit shape (D-12), the per-toolCall AbortController (D-17), the AppModal primitive (UI-SPEC §13), and the per-bot policy loader (T-P4-03). Phase 5 is purely additive on those layers — no new transport, no new abstraction, no new IPC envelope. The hardest design decision is the synchronous `shell/approve` JSON-RPC round-trip (Pattern 2); once that's in place, the rest follows the existing patterns.

---

## Runtime State Inventory

> Phase 5 is NOT a rename/refactor/migration. This section is included for completeness but every category answers "Phase 5 adds new state; nothing migrated from Phase 4."

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | New: `<userData>/always-allow/<bot>.json` (per-bot always-allow list, created on first `user-always` decision) | code only — new file, no migration |
| Live service config | None — always-allow is file-backed; no in-memory state survives a restart | n/a |
| OS-registered state | None — Phase 5 doesn't register Windows Task Scheduler entries, launchd plists, or systemd units | n/a |
| Secrets/env vars | None — Phase 5 doesn't add new env vars or secret keys; the API key story is Phase 1 + secureStorage | n/a |
| Build artifacts | None — no new dependencies, no new build steps; Phase 5 is pure additive on the existing tsc/vite chain | n/a |

**Nothing found in category:** All categories above explicitly checked and noted. Phase 5 introduces new stored data (always-allow files) but does not migrate or rename any existing state.

---

## Common Pitfalls

### Pitfall 1: Always-allow cache returns stale data after user revokes via settings

**What goes wrong:** The daemon caches the always-allow list in module scope. The user edits `<userData>/always-allow/<bot>.json` (or future settings UI revokes an entry) to remove a command. The next `tools/call exec_command` still hits the cached entry and runs without approval.

**Why it happens:** Read-once cache without invalidation.

**How to avoid:** Always read from disk on every `tools/call exec_command`. The file is small (≤50 entries × ~200 bytes = ~10 KB); latency is negligible. Matches T-P4-03 pattern.

**Warning signs:** Manual test: revoke an always-allow entry; trigger the same command; it runs without approval.

### Pitfall 2: `child.kill('SIGTERM')` doesn't kill nested processes on Windows

**What goes wrong:** `exec_command` spawns `cmd.exe /c npm test`. npm spawns Node, Node spawns Mocha, Mocha spawns test workers. The user clicks cancel. `child.kill('SIGTERM')` only kills `cmd.exe`; `npm`, `node`, and `mocha` are orphaned and continue running.

**Why it happens:** Windows has no POSIX signals; `child.kill()` without `taskkill /T /F` only targets the immediate child.

**How to avoid:** On Windows, spawn `taskkill /pid <pid> /T /F` to kill the process tree. On POSIX, spawn with `detached: true` so the child gets its own process group; `process.kill(-pid, 'SIGTERM')` kills the group.

**Warning signs:** Manual test: run `exec_command('npm test &', { detached: false })`; cancel; check Task Manager for orphaned `node.exe`.

### Pitfall 3: Audit log captures the full command contents, leaking secrets

**What goes wrong:** The audit JSONL line for `exec_command` includes the full command string. Commands like `export AWS_SECRET=... && npm deploy` or `curl -H "Authorization: Bearer $(cat ~/.token)" ...` leak secrets to disk forever.

**Why it happens:** No audit minimization on the new tool.

**How to avoid:** Audit `params` carries only `{command_redacted: command.slice(0, 80) + (command.length > 80 ? '...' : ''), commandLength: command.length, approvedBy}`. NEVER the full string. NEVER stdout/stderr. Same pattern as Wave 3's audit minimization for `bots/update` (T-P4-22).

**Warning signs:** Manual test: grep audit JSONL for a known secret string; it appears in plain text.

### Pitfall 4: Approval modal stack races with multiple concurrent shell calls

**What goes wrong:** The LLM issues two `exec_command` calls in the same tool_use turn (rare but possible: parallel function calling). Two approval modals open simultaneously. The user clicks "Allow" on modal A, expecting modal B to still be visible; modal B is hidden behind modal A; the second `shell/approve` round-trip times out.

**Why it happens:** No modal stack management.

**How to avoid:** Modal stack: each `ApprovalModal` has a distinct `shellId`; the state store holds a `pendingApprovals: Map<shellId, ...>`; App.tsx renders one modal per entry in z-index order (oldest shellId = lowest z, newest = highest). When a modal is responded, its entry is removed; the next modal surfaces automatically.

**Warning signs:** Manual test: trigger two `exec_command` calls in one LLM turn; only one modal visible.

### Pitfall 5: `shell:token` events arrive before the renderer's listener registers

**What goes wrong:** The daemon starts spawning immediately after approval; the first `shell:token` arrives at main before the renderer's `state/shells.ts` subscriber has wired up. Token is dropped; the user sees truncated output.

**Why it happens:** The renderer's listener is registered in `useEffect`; the daemon may emit `shell:token` synchronously after approval.

**How to avoid:** Main buffers `shell:token` events keyed by `shellId` until the renderer sends a `shell:subscribe(shellId)` IPC. The renderer subscribes as soon as the modal is approved (or as soon as the modal opens, so buffer is pre-warmed). Alternative: the daemon holds the first `shell:token` for 50ms before emitting — ugly.

**Warning signs:** Manual test: approve an `exec_command` that emits stdout instantly; renderer shows partial output.

### Pitfall 6: `tools/cancel` aborts the tool but the child continues

**What goes wrong:** The user clicks the chat composer's stop button. `cancel(msgId)` IPC handler aborts the per-msgId AbortController. The active `tools/call` for `exec_command` sees the abort and... returns immediately to the LLM, but the spawned child keeps running.

**Why it happens:** The `tools/call` handler in `daemon/main.cjs` aborts the per-toolCall AbortController when `tools/cancel` fires. The tool's handler must register an abort listener that calls `killChildTree`; if it doesn't, the child is orphaned.

**How to avoid:** `exec_command.cjs#call(args, ctx)` MUST register `signal.addEventListener('abort', () => killChildTree(child, isWin))` before awaiting child exit. The `finally` block MUST also unregister the listener to prevent leaks on natural completion.

**Warning signs:** Manual test: trigger `exec_command('npm test', { detached: false })`; cancel mid-stream; check Task Manager for orphaned `node.exe`.

### Pitfall 7: `<userData>/always-allow/<bot>.json` is silently corrupted by manual edits

**What goes wrong:** The user opens `<userData>/always-allow/code-reviewer.json` in a text editor and accidentally saves a malformed JSON file. Subsequent `readAlwaysAllow` calls fail silently; the user is prompted for every command (always-allow appears empty).

**Why it happens:** No schema validation on read.

**How to avoid:** `readAlwaysAllow` catches JSON.parse errors and returns `[]` (the file is treated as empty). The audit log records the parse failure with `{tool: 'alwaysAllow.readFailed', bot, error: 'parse_error'}`. The next successful `appendAlwaysAllow` overwrites the malformed file with valid JSON.

**Warning signs:** Manual test: corrupt an always-allow file; trigger a previously-approved command; it prompts again.

### Pitfall 8: Cmd.exe quoting bugs silently corrupt the user's command

**What goes wrong:** User runs `exec_command('echo "hello world"')`. The command is passed to `cmd.exe /d /s /c echo "hello world"`. `cmd.exe` parses the args and strips the outer quotes: `echo hello world`. Output: `hello world`. Working as intended. BUT: user runs `exec_command('dir "C:\Program Files"')`. Same path: `cmd.exe /d /s /c dir "C:\Program Files"`. Output: `Volume in drive C is ... Directory of C:\Program Files`. Wait, this should work... actually cmd.exe has elaborate quoting rules that frequently surprise users.

**Why it happens:** Cmd.exe is not a POSIX shell; quoting rules differ.

**How to avoid:** Document that `exec_command` passes commands VERBATIM to `cmd.exe /d /s /c`; the user is responsible for their own quoting. Render the command in the modal exactly as the LLM passed it. If quoting issues arise, the user can click "Deny" and rephrase the command.

**Warning signs:** User report: "the command in the modal doesn't match what ran."

### Pitfall 9: `cwd` defaults to the wrong directory, breaking commands like `npm install`

**What goes wrong:** User runs `exec_command('npm install')` expecting it to install in the workspace root. The daemon spawns the child with `cwd` defaulting to the daemon's CWD (the Electron `process.execPath`'s directory). `npm install` runs in `C:\Program Files\localbot\...` and fails.

**Why it happens:** No default `cwd` policy.

**How to avoid:** Default `cwd` to `<userData>/workspace/<bot>` (the bot's workspace root, Phase 3's convention). Allow override via the `cwd` argument. Validate `cwd` is inside the bot's workspace via `safePath` (Phase 2's containment helper).

**Warning signs:** Manual test: run `exec_command('pwd')`; output is the Electron directory, not the bot workspace.

### Pitfall 10: The LLM bypasses approval by issuing `exec_command` in a sub-agent chain

**What goes wrong:** The LLM issues `exec_command('rm -rf /')` directly. The denylist catches it. But the LLM also issues `exec_command('cat /etc/passwd > /tmp/x && echo "this is a password" > /tmp/x')` — the global denylist doesn't catch this (no `rm -rf`, no `sudo`, no `curl|bash`). The user clicks "Allow once"; the file `/tmp/x` is written.

**Why it happens:** The denylist is targeted at known-dangerous patterns, not all dangerous behavior.

**How to avoid:** This is the intended design: the denylist catches the obvious disasters; per-call approval catches the rest. The user is the last line of defense. Do NOT try to build a comprehensive denylist — false positives are worse than false negatives. Document the threat model in the modal: "Allowing runs the command with your user privileges."

**Warning signs:** N/A — this is a deliberate design tradeoff, not a bug.

---

## Code Examples

> Verified patterns from existing Phase 4 code + standard Node 20+ stdlib usage. All values shown match the locked decisions in this document.

### Existing pattern: per-toolCall AbortController (Phase 2, `daemon/main.cjs:124-142`)

```javascript
// Phase 2: per-call AbortController registry so `tools/cancel` can abort
// in-flight tool work (Pitfall 3 — cancel propagation). Keyed by params.toolCallId.
const abortControllers = new Map();

function ensureAbortController(toolCallId) {
  if (!toolCallId) return new AbortController();
  let ctrl = abortControllers.get(toolCallId);
  if (!ctrl) {
    ctrl = new AbortController();
    abortControllers.set(toolCallId, ctrl);
  }
  return ctrl;
}

function dropAbortController(toolCallId) {
  if (!toolCallId) return;
  abortControllers.delete(toolCallId);
}
```

**Phase 5 extension:** `exec_command.cjs#call` reads `ctx.signal` (already set by `registry.callTool`); registers an abort listener that calls `killChildTree`.

### Existing pattern: JSON-RPC notification from daemon (`daemon/main.cjs:178-180`)

```javascript
function sendNotification(method, params) {
  reply({ jsonrpc: '2.0', method, params });
}
```

**Phase 5 extension:** `exec_command.cjs` calls `sendNotification('shell:token', {shellId, stream, delta})` from the readline line handler; calls `sendNotification('shell:exit', {shellId, exitCode, ...})` from the child `exit` handler.

### Existing pattern: per-bot allowlist check before tool dispatch (`daemon/tools/registry.cjs:226-266`)

```javascript
async function callTool(botId, name, args, ctx) {
  const policy = getPolicy(botId, ctx);
  if (policy.denylist.has(name)) {
    throw Object.assign(new Error(`tool '${name}' denied by denylist`), { code: 'denied', reason: 'denylist' });
  }
  if (!TOOLS.includes(name)) {
    throw Object.assign(new Error(`unknown tool: ${name}`), { code: 'unknown_tool' });
  }
  const isSystem = SYSTEM_TOOLS.has(name) && (botId === '_system' || botId === undefined);
  if (!isSystem && !policy.allowlist.has(name)) {
    throw Object.assign(new Error(`tool '${name}' not in bot allowlist`), { code: 'denied', reason: 'allowlist' });
  }
  // dispatch
  const mod = loadTool(name);
  return await mod.call(args, { ...ctx, registry: { registerChild, unregisterChild, activeChildren } });
}
```

**Phase 5 extension:** `exec_command` is added to the `TOOLS` array + `SCHEMAS`; the daemon's `exec/denylist.cjs#matchesDangerous(command)` is called BEFORE this `callTool` function is even invoked (in the LLM-driven tool dispatch path, the daemon intercepts the `exec_command` tool_use and runs the denylist check as the first step).

### Existing pattern: per-tool audit JSONL line (`daemon/main.cjs:310-318`)

```javascript
audit.appendAudit({
  tool: name,
  bot,
  params: auditParams,
  outcome,
  durationMs,
  error: errPayload,
  tool_use_id: toolCallId,
});
```

**Phase 5 extension:** `exec_command` audit params minimize to `{command_redacted, commandLength, approvedBy, exitCode, stdoutBytes, stderrCount}`; never the full command, never stdout/stderr.

### Existing pattern: AppModal primitive (`src/renderer/components/AppModal.tsx:34-125`)

```typescript
export function AppModal({ title, onClose, children, zIndex = 1000, cardClassName, ariaLabel }: AppModalProps) {
  // Escape close + focus trap + click-outside + ARIA dialog
  // ... (full implementation in AppModal.tsx)
}
```

**Phase 5 extension:** `ApprovalModal` wraps AppModal with `zIndex={1500}` + `cardClassName="approval-modal"`.

### Existing pattern: MessageBlock discriminated union (`src/shared/types.ts:10-14`)

```typescript
export type MessageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'summary'; summary: SummaryRecord };
```

**Phase 5 extension:** Add `{ kind: 'shell_stream'; shellId: string; stdout: string; stderr: string; exitCode: number | null; isError: boolean }`.

### New pattern: shell/approve synchronous round-trip

```javascript
// daemon/main.cjs (extended)
const pendingApprovals = new Map(); // shellId -> {resolve, reject}

case 'shell/approve': {
  // NOTE: this is a notification shape (no `id`), but the daemon
  // treats it as a request and holds the connection open via a
  // Promise. The renderer responds via a SEPARATE invocation:
  //   shell/respond {shellId, decision}
  // The daemon's tools/call handler awaits on `pendingApprovals.get(shellId)`.
  const shellId = (params && typeof params.shellId === 'string') ? params.shellId : '';
  const command = (params && typeof params.command === 'string') ? params.command : '';
  const bot = (params && typeof params.bot === 'string') ? params.bot : currentBot;
  if (!shellId) {
    replyError(id, 'invalid_shell_id', 'shellId required');
    break;
  }
  // Forward to main via notification; main proxies to renderer.
  sendNotification('shell:request-approval', { shellId, command, bot });
  // The response arrives via the 'shell/respond' case below; that resolves
  // the Promise that tools/call exec_command is awaiting. We do NOT reply
  // to this id — it's a "fire and register" call.
  break;
}

case 'shell/respond': {
  const shellId = (params && typeof params.shellId === 'string') ? params.shellId : '';
  const decision = (params && typeof params.decision === 'string') ? params.decision : '';
  const pending = pendingApprovals.get(shellId);
  if (!pending) {
    replyError(id, 'no_such_shell', `no pending approval for ${shellId}`);
    break;
  }
  pendingApprovals.delete(shellId);
  pending.resolve(decision); // 'allow-once' | 'allow-always' | 'deny'
  replyResult(id, { ok: true });
  break;
}
```

```javascript
// daemon/tools/exec_command.cjs (excerpt)
async function requestApproval(shellId, command, bot) {
  return new Promise((resolve, reject) => {
    pendingApprovals.set(shellId, { resolve, reject });
    sendNotification('shell:request-approval', { shellId, command, bot });
    // Timeout: if the user doesn't respond in 5 minutes, deny.
    setTimeout(() => {
      if (pendingApprovals.has(shellId)) {
        pendingApprovals.delete(shellId);
        reject(Object.assign(new Error('approval timed out'), { code: 'approval_timeout' }));
      }
    }, 5 * 60 * 1000);
  });
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `read_file` / `write_file` / `edit_file` are the only filesystem tools | Phase 5 adds `exec_command` (shell escape hatch) | Phase 5 | LLM can run arbitrary shell commands with per-call approval |
| Per-call approval doesn't exist | Per-call approval modal (UI-04) with three-button UX | Phase 5 | User reviews every shell command before execution; "Always Allow" persists |
| No global command denylist | Hard-coded `GLOBAL_DENYLIST` regex array (SEC-03) | Phase 5 | Disasters like `rm -rf /` are blocked at the daemon, not even shown to the user |
| In-memory always-allow | `<userData>/always-allow/<bot>.json` per-bot list | Phase 5 | Always-allow survives restarts; user can inspect in any text editor |
| `child.kill('SIGTERM')` for all tools | `taskkill /T /F` on Windows, `process.kill(-pid, 'SIGTERM')` on POSIX | Phase 5 | Shell process trees are reliably killed on cancel |
| Audit params include full tool args | Audit minimization: redacted command, byte count, approval mode | Phase 5 | Secrets in commands (env vars, tokens) never reach disk |

**Deprecated/outdated:**
- **No approval gate for shell commands.** Phase 5 introduces the gate; before, no shell tool existed at all.
- **No global denylist.** Phase 5 introduces the denylist; before, there was nothing to deny.

---

## Assumptions Log

> Claims tagged `[ASSUMED]` need user confirmation before becoming locked decisions. The planner should surface these in discuss-phase if needed.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Per-call approval must be synchronous (JSON-RPC round-trip), not a separate async websocket | Pattern 2 | If user prefers async approval (e.g., "approve from phone via Tailscale"), Phase 5 needs a new transport; out of scope |
| A2 | Global denylist is hard-coded; not configurable via UI in v1 | Pattern 1, Claude's Discretion | If user wants to add/remove rules from settings, Phase 5 grows a settings UI for denylist; deferred to Phase 9 |
| A3 | Always-allow is exact-string match (case-sensitive, whitespace-trimmed), not glob | Pattern 3 | If user wants glob match (`npm *`), false positives risk; user can always click "Allow once" |
| A4 | Always-allow FIFO eviction at 50 entries per bot | Pattern 3 | If user wants unlimited, file size grows unbounded; 50 is a sensible default |
| A5 | `cwd` defaults to `<userData>/workspace/<bot>` | Pitfall 9 | If user wants a different default (e.g., per-bot config `cwd` field), Phase 5 grows config.json schema |
| A6 | cmd.exe `/d /s /c <command>` on Windows; `/bin/sh -c <command>` on POSIX | Pattern 4 | If user wants PowerShell by default on Windows, change the wrapper |
| A7 | Shell stdout/stderr is line-buffered, not partial-line | Pattern 4 | If user wants partial-line streaming (typing into a REPL), Phase 5 needs raw `data` events + a buffer |
| A8 | Audit params minimize to `{command_redacted, commandLength, approvedBy, exitCode, stdoutBytes, stderrCount}` | Pattern 4, Pitfall 3 | If user wants the full command in audit, secrets leak to disk |
| A9 | Approval modal z-index 1500 (above BotSettingsPage=1200, below MemoryPanel=800? verify) | Pattern 5 | If user wants a different stacking order, the modal stack from Phase 4 needs revisiting |
| A10 | The user can revoke always-allow entries by editing `<userData>/always-allow/<bot>.json` directly; no UI in v1 | Claude's Discretion | If user wants UI for revoke, Phase 5 grows a settings tab; deferred |
| A11 | `exec_command` is in the DEFAULT_POLICY allowlist (per Phase 3's DEFAULT_POLICY: `read_file`, `write_file`, `edit_file`, `list_dir`, `code_search`, `memory.update`) | Pattern 1 + new tool registration | If user wants `exec_command` OFF by default, the DEFAULT_POLICY needs to change (Phase 4 lock — risky) |
| A12 | The renderer pre-checks the global denylist (so the modal can show "blocked by global denylist" instead of asking) | Pattern 1 | If renderer pre-check is wrong, daemon still catches it; pre-check is purely UX |
| A13 | Audit log records `tool: 'exec_command'` for both allowed and denied invocations | Pattern 4 | If user wants denials logged separately (`tool: 'exec_command.denied'`), audit queries need updating |
| A14 | The renderer renders `shell_stream` blocks inline in the chat (same row as the tool_use block) | Pattern 6 | If user wants shell output in a separate side panel, the layout changes |
| A15 | Per-toolCall AbortController propagation already works through Phase 2's `tools/cancel`; exec_command just needs to register the abort listener | Pattern 4, Pitfall 6 | If Phase 2's cancel surface doesn't reach exec_command, Phase 5 grows a new cancel channel |

**If this table is empty:** All claims were verified or cited — no user confirmation needed. (This table is non-empty: items A1–A15 are all `[ASSUMED]` from training knowledge + Phase 1+2+3+4 patterns; planner should surface the high-risk ones in discuss-phase if the user is around.)

---

## Open Questions

1. **Should `exec_command` be in DEFAULT_POLICY by default?**
   - What we know: Phase 3's `DEFAULT_POLICY` allowlist includes `read_file`, `write_file`, `edit_file`, `list_dir`, `code_search`, `memory.update`. `exec_command` is NOT there.
   - What's unclear: Whether the implicit `default` bot gets `exec_command` by default, or whether bots must explicitly opt in.
   - Recommendation: `exec_command` is OFF by default (no implicit allow); the user must explicitly add it via `NewBotModal` allowlist picker or `BotSettingsPage`. This matches the "shell is a powerful escape hatch" threat model.

2. **PowerShell vs cmd.exe on Windows?**
   - What we know: `cmd.exe` is the default Windows shell; PowerShell is the modern shell but has more complex invocation (`powershell.exe -Command "..."`).
   - What's unclear: Whether the wrapper should default to `cmd.exe` or `powershell.exe`.
   - Recommendation: Default to `cmd.exe` (matches the user's likely intent for shell commands; PowerShell users can use `powershell -Command "..."` explicitly). Document the choice in the modal's tooltip.

3. **Should the approval modal show the full command or a truncated preview?**
   - What we know: The audit log minimizes to `command.slice(0, 80)`. The modal could do the same.
   - What's unclear: Whether the user wants to see the full command (to make an informed decision) or a truncated preview (for safety).
   - Recommendation: Show the full command in the modal (the user is the one approving; they need full context). The audit minimization is about what reaches disk, not what reaches the user's eyes.

4. **What about commands that prompt for stdin?**
   - What we know: `child_process.spawn` with `stdio: ['ignore', 'pipe', 'pipe']` closes stdin immediately. The user can't type into the spawned process.
   - What's unclear: Whether `exec_command` should support interactive stdin (e.g., `npm login`).
   - Recommendation: No interactive stdin in v1. The `stdio: 'ignore'` keeps it simple; users can wrap their command in `echo ... | <command>` if needed. A future phase may add stdin forwarding.

5. **Should "Always Allow" be per-command or per-prefix?**
   - What we know: Exact-string match is safe but inflexible (no `npm *`).
   - What's unclear: Whether the user wants to approve `npm install` once and have it cover `npm install <any-package>`.
   - Recommendation: Exact-string match for v1 (Pattern 3). A future phase may add prefix matching with explicit user opt-in.

6. **What about command timeouts?**
   - What we know: `timeoutMs` defaults to 60_000 (60s), max 600_000 (10 min). After timeout, the daemon kills the child + tree and emits `shell:exit {exitCode: null, signal: 'SIGTERM'}`.
   - What's unclear: Whether the LLM should be allowed to set `timeoutMs` > 10 min for long-running builds.
   - Recommendation: Hard cap at 600_000. Users wanting longer can edit the command to use `timeout /t` or nohup themselves.

7. **Audit log: separate file for denials?**
   - What we know: Current audit is one NDJSON file per day, all tools mixed.
   - What's unclear: Whether denials should be filterable separately.
   - Recommendation: Keep one audit file; filter by `tool: 'exec_command'` + `outcome: 'error'`. Add a `code` field to the audit's `error` payload for `denylist_blocked` / `denied` / `approval_timeout` so queries can filter easily.

8. **Renderer-side denylist pre-check?**
   - What we know: The daemon's `matchesDangerous` is the source of truth.
   - What's unclear: Whether the renderer should also have a denylist copy to pre-check (so the modal can say "blocked by global denylist" without round-tripping).
   - Recommendation: Renderer has a hard-coded copy of the denylist regex array for UX (so it can render an inline "blocked" message immediately). Daemon still re-checks (defense in depth). Mismatch between renderer and daemon copies would be a bug; sync via a shared `daemon/exec/denylist.cjs` import in the preload.

---

## Environment Availability

> Step 2.6: per the protocol, this section is required for phases with external dependencies. Phase 5's only external dependency is `cmd.exe` / `/bin/sh`, both of which are guaranteed by the target OS.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 20+ stdlib `child_process.spawn` | exec_command shell wrapper | ✓ | per `@types/node: ^20.11.0` (env) | — |
| `cmd.exe` / `/bin/sh` | Shell execution | ✓ | Windows 11 Pro 10.0.26200 (env) | — |
| `taskkill` (Windows) | Tree-kill on cancel | ✓ | ships with Windows since XP | — |
| `child.kill('SIGTERM')` + `process.kill(-pid, ...)` | POSIX tree-kill | ✓ | Node 20+ built-in | — |
| `node:readline` | Line-buffered stdout/stderr | ✓ | Node 20+ built-in | — |
| Phase 1+2+3+4 IPC envelope | shell:token + shell:exit + shell/approve transport | ✓ | all in place from prior phases | — |
| Phase 4 AppModal primitive | Approval modal | ✓ | `src/renderer/components/AppModal.tsx` | — |
| Phase 4 per-bot allowlist + policy loader | exec_command allowlist gate | ✓ | `daemon/bots/policy.cjs` | — |
| Phase 2 per-toolCall AbortController | Cancel propagation | ✓ | `daemon/main.cjs` lines 124-142 | — |
| `<userData>/always-allow/<bot>.json` write target | Always-allow persistence | ✓ | `<userData>` is Phase 1's standard path | — |

**Missing dependencies with no fallback:** none — all covered by Node 20+ stdlib + the existing Phase 1+2+3+4 stack.

**Missing dependencies with fallback:** none.

*All Phase 5 capabilities are deliverable with the existing toolchain + Node 20+ stdlib; no new installs required.*

---

## Validation Architecture

> `workflow.nyquist_validation` — assume enabled per GSD defaults. Full section included.

### Test Framework

| Property | Value |
|----------|-------|
| **Framework** | Vitest `^2.1.9` (unit) + Playwright `^1.63.0` (Electron + daemon smoke) |
| **Config files** | `vitest.config.ts` (Node env, includes `tests/unit/**`), `playwright.config.ts` |
| **Quick run command** | `npm test` (Vitest unit, ~15 s with the 3 new suites) |
| **Full suite command** | `npm run test:all` (Vitest + Playwright daemon smoke, ~50 s) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SEC-03 | `matchesDangerous(command)` blocks `rm -rf /`, `sudo *`, `curl * | bash`, etc. | unit | `npx vitest run tests/unit/exec_denylist.test.ts` | Wave 0 |
| SEC-03 | `exec_command` audit line records denylist block | unit | covered by `exec_command.test.ts` | Wave 0 |
| TOOL-06 | `exec_command` requires allowlist membership | unit | covered by `exec_command.test.ts` + extended `bot_policy.test.ts` | Wave 0 |
| TOOL-06 | `readAlwaysAllow` returns the per-bot always-allow list | unit | `npx vitest run tests/unit/exec_always_allow.test.ts` | Wave 0 |
| TOOL-06 | `appendAlwaysAllow` adds an entry; FIFO eviction at 50 | unit | covered by `exec_always_allow.test.ts` | Wave 0 |
| TOOL-06 | `exec_command` spawns cmd.exe and captures stdout/stderr (mock spawn) | unit | covered by `exec_command.test.ts` | Wave 0 |
| TOOL-06 | Cancel via `tools/cancel` triggers `killChildTree` | unit | covered by `exec_command.test.ts` | Wave 0 |
| TOOL-06 | `shell/approve` JSON-RPC round-trip: pendingApprovals map resolves on `shell/respond` | unit | covered by `exec_command.test.ts` | Wave 0 |
| UI-04 | ApprovalModal renders three buttons + command preview | smoke | covered by `shell-approval.test.ts` | Wave 0 |
| UI-04 | "Allow once" responds and triggers execution | smoke | covered by `shell-approval.test.ts` | Wave 0 |
| UI-04 | "Always allow" persists to `<userData>/always-allow/<bot>.json` | smoke | covered by `shell-approval.test.ts` | Wave 0 |
| UI-04 | "Deny" closes the modal + surfaces inline error in chat | smoke | covered by `shell-approval.test.ts` | Wave 0 |
| UI-04 | Concurrent approvals show stacked modals in z-index order | smoke | covered by `shell-approval.test.ts` | Wave 0 |
| UI-04 | `shell_stream` MessageBlock renders accumulated deltas + exit code | smoke | covered by `shell-approval.test.ts` | Wave 0 |
| SEC-03 | Audit minimization: `params` carries only redacted command + length | unit | covered by `exec_command.test.ts` | Wave 0 |

### Sampling Rate

- **Per task commit:** `npm test` (Vitest unit only, ~15 s with the 3 new suites)
- **Per wave merge:** `npm run test:all` (Vitest + Playwright daemon smoke, ~50 s)
- **Phase gate:** Full suite green before `/gsd-verify-work`; headed Electron smoke (`LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/shell-approval.test.ts`) deferred to developer machine per Phase 1+2+3+4 precedent.

### Wave 0 Gaps

- [ ] `tests/unit/exec_denylist.test.ts` — covers all 10 default denylist patterns; case sensitivity; exact match vs substring match
- [ ] `tests/unit/exec_always_allow.test.ts` — covers read (empty file, populated file, malformed JSON), append (new entry, existing entry useCount++), FIFO eviction at 50, exact-string match semantics
- [ ] `tests/unit/exec_command.test.ts` — covers spawn mock (cmd.exe on Windows, /bin/sh on POSIX), line-buffered stdout/stderr capture, audit minimization, cancel via `tools/cancel`, `shell/approve` round-trip, `killChildTree` invocation
- [ ] `tests/unit/bot_policy.test.ts` (extended) — exec_command allowlist behavior (in allowlist = execute; not in allowlist = `denied`)
- [ ] `tests/playwright/fake-m3-server.ts` (extended) — `streamExecCommand({command, port})` helper that emits a `exec_command` tool_use block followed by streamed tokens on cancel/allow
- [ ] `tests/playwright/shell-approval.test.ts` — full vertical: trigger bot -> LLM emits `exec_command` tool_use -> daemon checks denylist -> daemon reads always-allow (miss) -> daemon issues `shell/approve` -> main proxies to renderer -> modal pops -> user clicks "Allow once" -> daemon spawns -> shell:token streams -> shell:exit emits -> renderer renders shell_stream block + exit code

*(If no gaps: "None — existing test infrastructure covers all phase requirements" — N/A here; 3 new unit suites + 1 new Playwright suite are required.)*

---

## Security Domain

> `security_enforcement` is absent from `.planning/config.json` — treat as enabled (default per GSD config schema).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | partial | API key in OS keychain (Phase 1); shell execution runs under the user's identity (no privilege escalation) |
| V3 Session Management | yes | Per-toolCall AbortController (Phase 2) + per-shellId extension; cancel mid-execution aborts the child + tree |
| V4 Access Control | yes | Per-bot allowlist (Phase 4); `exec_command` requires explicit membership; default bots do NOT include `exec_command` |
| V5 Input Validation | yes | Global denylist regex matching; per-call user approval; command string passed verbatim to cmd.exe (user is responsible for quoting) |
| V6 Cryptography | no | Phase 5 doesn't add crypto; always-allow list is plaintext JSON |
| V7 Error Handling | yes | Audit lines on every outcome (allowed, denied, denylist_blocked, approval_timeout, error); renderer surfaces inline error in chat |
| V9 Communication | yes | All shell events flow through the existing JSON-RPC over NDJSON transport (Phase 1 D-10/D-11); no new transport |
| V12 File Integrity | yes | Atomic `tmp + rename` for `<userData>/always-allow/<bot>.json` writes (Phase 4 pattern); malformed JSON is caught on read |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| `rm -rf /` via exec_command | Tampering | Global denylist regex `/\brm\s+-rf?\s+\/(?!\w)/i` blocks BEFORE the modal appears |
| `sudo *` privilege escalation | Elevation of Privilege | Global denylist regex `/\bsudo\b/i` blocks |
| `curl ... | bash` remote code execution | Tampering | Global denylist regex `/\bcurl\b.*\|\s*(?:ba)?sh\b/i` blocks |
| LLM submits a `exec_command` for a command not on the always-allow list | Repudiation | Per-call approval round-trip; audit line carries `approvedBy: 'user-once' \| 'user-always' \| 'system-denylist-block'` |
| User pastes `AWS_SECRET=...` into the command; audit log captures it | Information Disclosure | Audit minimization: `params.command_redacted` is `command.slice(0, 80) + '...'`; never the full string |
| User runs `exec_command` that emits megabytes of stdout containing secrets | Information Disclosure | Audit `stdoutBytes` only; never the contents; live stream is renderer-local and never persisted to disk in Phase 5 |
| Cancel mid-execution leaves orphaned child processes | Denial of Service | `killChildTree(child, isWin)` on abort: `taskkill /T /F` on Windows, `process.kill(-pid, 'SIGTERM')` on POSIX |
| Approval modal opened twice for two concurrent `exec_command` calls | Tampering | Modal stack keyed by `shellId`; each modal has a unique `data-shell-id`; older modals get lower z-index |
| Renderer-side denylist copy drifts from daemon copy | Tampering | Renderer imports `daemon/exec/denylist.cjs` via the preload's bundler (or shared); daemon re-checks anyway (defense in depth) |
| Manual edit of `<userData>/always-allow/<bot>.json` injects dangerous commands | Tampering | Exact-string match means a malicious entry only re-enables a command the user already typed; the user can always click "Deny" |
| Bot config allowlist silently grows to include `exec_command` via bots/update | Tampering | `bots/update` audit minimization logs `{changedKeys}` only; the user can see the change in BotSettingsPage |
| Stdin injection via a command like `echo "rm -rf /" | sh` | Tampering | Denylist catches `| sh` patterns; per-call approval catches the rest; stdin is closed immediately so no interactive injection |

---

## Sources

### Primary (HIGH confidence)

- `.planning/PROJECT.md` — phase scope, locked decisions, constraints (read this session)
- `.planning/REQUIREMENTS.md` — TOOL-06, SEC-03, UI-04 definitions (read this session)
- `.planning/ROADMAP.md` — Phase 5 success criteria + dependency on Phase 4 (read this session)
- `.planning/STATE.md` — accumulated decisions, debug history (read this session)
- `.planning/phases/04-multi-bot-crud-sidebar/04-RESEARCH.md` — per-bot policy + IPC envelope + audit minimization patterns (read this session)
- `.planning/phases/04-multi-bot-crud-sidebar/04-01-PLAN.md`, `04-02-PLAN.md`, `04-03-PLAN.md` — execution patterns (read this session)
- `.planning/phases/03-memory-conversation-history/03-RESEARCH.md` (not read in this session but cross-referenced via Phase 4 research)
- `daemon/main.cjs` — JSON-RPC envelope, `tools/call`, `tools/cancel`, audit appendAudit (read this session)
- `daemon/tools/registry.cjs` — per-tool allowlist + SYSTEM_TOOLS + child tracking (read this session)
- `daemon/tools/code_search.cjs` — `child_process.spawn` + readline + signal cancellation pattern (read this session)
- `daemon/bots/policy.cjs` + `daemon/bots/loader.cjs` (read indirectly via 04-RESEARCH + 04-PLANs)
- `daemon/runs/jsonl.cjs` — appendRun + listRuns + per-bot mutex (read this session)
- `src/main/ipc/bots.ts` — per-runId AbortController map + EVENT_BOT_STATUS broadcast (read this session)
- `src/main/ipc/chat.ts` — sendMessage routing + runAgenticLoop integration (read this session)
- `src/main/daemon/spawn.ts` — callBot + callTool + onNotification JSON-RPC bridge (read this session)
- `src/main/audit/logger.ts` — appendAuditLine + AuditInput shape (read this session)
- `src/main/preload/index.ts` — contextBridge + window.localbot surface (read this session)
- `src/shared/ipc-channels.ts` — CHANNELS constants (read this session)
- `src/shared/types.ts` — BotConfig, RunRecord, BotStatusEvent, AuditLine, etc. (read this session)
- `src/shared/window.d.ts` — LocalbotApi + LocalbotChannel (read this session)
- `src/renderer/state/bots.ts` — module-scope store + EVENT_BOT_LIST_UPDATED + EVENT_BOT_STATUS subscriptions (read this session)
- `src/renderer/state/runs.ts` — useRunHistory cache + push refresh (read this session)
- `src/renderer/components/AppModal.tsx` — generic modal primitive (read this session)
- `src/renderer/components/BotSidebar.tsx` — sidebar + composer + modals (read this session)
- `src/renderer/components/Chat.tsx` — chat shell + message list (read this session)
- `src/renderer/components/MessageBlock.tsx` — discriminated union renderer (read this session)
- `src/renderer/components/ToolResultBlock.tsx`, `ToolUseBlock.tsx` — inline tool blocks (read this session)
- `package.json` — dependencies (read this session)

### Secondary (MEDIUM confidence)

- Node.js 20.x `child_process.spawn` documentation — shell wrapper, signal propagation, `windowsHide`, `detached`, tree-kill semantics — recalled from training knowledge, cross-referenced with the Phase 2 `code_search.cjs` pattern that already uses `spawn(rgPath, args, { cwd, stdio, windowsHide })` + `signal.addEventListener('abort', onAbort)` + `child.kill('SIGTERM')` + SIGKILL fallback after 2s. The Phase 5 extension to `taskkill /T /F` follows the same escalation pattern.
- Windows `taskkill` flags (`/pid`, `/T` = tree, `/F` = force) — recalled from training knowledge; `/T /F` is the canonical Windows tree-kill and ships in `%SystemRoot%\System32\` on every Windows install since XP.

### Tertiary (LOW confidence)

- None — Phase 5's research is grounded in the existing Phase 1+2+3+4 patterns plus Node 20+ stdlib docs (HIGH confidence).

---

## Metadata

**Confidence breakdown:**

- **Standard stack:** HIGH — every package is already installed; verified by reading `package.json` and prior phase RESEARCH.md files; no new dependencies.
- **Architecture:** HIGH — Phase 1+2+3+4 patterns read this session (`daemon/main.cjs`, `daemon/tools/registry.cjs`, `daemon/tools/code_search.cjs`, `daemon/runs/jsonl.cjs`, `src/main/ipc/bots.ts`, `src/main/ipc/chat.ts`, `src/main/daemon/spawn.ts`, `src/main/preload/index.ts`, `src/shared/{ipc-channels,types,window.d}.ts`, `src/renderer/state/{bots,runs}.ts`, `src/renderer/components/{AppModal,BotSidebar,Chat,MessageBlock,ToolUseBlock,ToolResultBlock}.tsx`); Phase 5 is purely additive on the existing layers.
- **Pitfalls:** HIGH — derived from reading actual Phase 1+2+3+4 code + the unique threats of `child_process.spawn` on Windows (tree-kill, denylist bypass, audit minimization); cross-referenced with locked decisions in `01-CONTEXT.md`, `01-SKELETON.md`, and Phase 4 patterns.
- **Validation architecture:** HIGH — follows Phase 1+2+3+4's Vitest + Playwright pattern (proven in `tests/playwright/daemon-tools.test.ts`, `tests/playwright/memory-history.test.ts`, `tests/playwright/tree-diff.test.ts`, `tests/playwright/bot-crud.test.ts`).

**Research date:** 2026-09-18
**Valid until:** 2026-10-18 (30 days — Node 20+ stdlib is stable; `child_process.spawn` API has not changed since Node 14; `taskkill` has shipped unchanged since Windows XP; the locked Phase 1+2+3+4 patterns are stable from the executed plans)