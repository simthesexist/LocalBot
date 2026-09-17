# Grok Bot — Architecture Report

Reverse-engineered from the installed app at
`C:\Users\simth\AppData\Local\Programs\Grok Bot\Grok Bot.exe`
(version **0.47.0**, build `f22400e9-2447-4ed8-a73d-582cb5abc12a`),
extracted from `resources/app.asar`.

> **Internal codename: `sand`.** Author field is `SpaceXAI`. The product
> homepage is `https://cursor.com`, but it is a joint build with **xAI**
> and is a sibling of Cursor (the IDE), not a Cursor plugin.

---

## 1. High-level topology

```
┌────────────────────────────────────────────────────────────────────┐
│  Desktop (Electron) — installed on user's machine                   │
│                                                                     │
│  ┌──────────────┐   ┌─────────────────────┐   ┌──────────────────┐ │
│  │ Renderer     │◄──┤ IPC bus (electron)  ├──►│ Electron Main    │ │
│  │ (React 19)   │   │                     │   │ (main-core,      │ │
│  │ + noVNC view │   └─────────────────────┘   │  main-app)       │ │
│  └──────────────┘                            └─────┬────────────┘ │
│  ┌──────────────┐                                   │              │
│  │ Node Agent   │◄────────── Connect-RPC ──────────┤              │
│  │ Coordinator  │                                   │              │
│  └──────┬───────┘                                   │              │
│         │ MCP (HTTP/stdio)                          │              │
│  ┌──────▼───────┐                                   │              │
│  │ Local-Exec   │   ┌─────────────────────────────┐ │              │
│  │ Daemon       │◄──┤ Cursor Box Computer (MCP)   │ │              │
│  │ (rg, fs, sh) │   │ /projects/cursor-box-...    │ │              │
│  └──────────────┘   └─────────────────────────────┘ │              │
└──────────────────────────────────────────────────────┼──────────────┘
                                                       │
                              Connect-RPC / HTTPS      │
                                                       ▼
                                              ┌─────────────────┐
                                              │ api2.cursor.sh  │
                                              │ api.origin...   │
                                              │ api.x.ai        │  (Grok)
                                              │ api.x.com       │  (X/Twitter)
                                              │ api3.../tev1    │  (OTel)
                                              └─────────────────┘
                                                       │
                                                       ▼
                                              ┌─────────────────┐
                                              │ Cloud "Box" VM  │
                                              │ /home/box       │
                                              │ noVNC server    │
                                              │ MCP endpoint    │
                                              │ persistent disk │
                                              └─────────────────┘
```

Five distinct runtime processes ship in the desktop installer:

| Process | Entry | Purpose |
|---|---|---|
| Electron main | `dist/electron-main/main.cjs` | Lifecycle bootstrap (loads `main-core` + `main-app`) |
| Electron main (core) | `dist/electron-main/main-core.cjs` | Window, IPC, install/upgrade |
| Electron main (app) | `dist/electron-main/main-app.cjs` | Backend wiring, auth, telemetry |
| Node Agent Coordinator | `dist/node-agent-coordinator/main.cjs` | Multi-agent orchestration (out-of-process) |
| Local-Exec Daemon | `dist/local-exec-daemon/main.cjs` | MCP server host for local tools |
| Renderer | `dist/renderer/index.html` + React 19 | UI (chat, file tree, noVNC canvas, voice) |

Supporting native bits in `app.asar.unpacked/dist/native/`:

- `sand-webauthn-signer.exe` — native WebAuthn signing (passkeys)
- `cursor-proclist` — Cursor's process-listing utility
- `elevate.exe` — Windows elevation helper
- `onepassword-connection-service.cjs` — 1Password CLI/Connect integration

---

## 2. The "Box" — persistent cloud computer

The marketing term *"its own persistent cloud computer"* maps directly to an
internal abstraction called a **box**.

**Evidence (file paths & entitlements):**

- Default box home: `/home/box` (`/home/box/sand-data`, `/home/box/agent-data`)
- Three subscription-tier entitlements, all named `…-computer-use`:
  - `co.anysphere.grok-bot-computer-use` — production
  - `co.anysphere.grok-bot-dev-computer-use` — dev tier
  - `co.anysphere.grok-bot-lab-computer-use` — lab/experimental tier
- Dev boxes are packaged as Docker images: `dev-box-docker.mjs`, with
  IPC channels `dev-box-pull-progress` and `dev-box-rebuild`.
- The MCP server the local daemon talks to lives at
  `/projects/cursor-box-computer/dist/mcp.js` — i.e. the agent's view
  of the local box.

**Box interaction model — VNC + WebAuthn polyfill:**

The renderer embeds **noVNC** (the open-source VNC client) to give the
user a live view of what the agent is doing on its box. The preload
script (`preload-vnc.cjs`) installs a substantial shim layer between
noVNC and the box:

- **Clipboard bridge** — host ↔ VM clipboard mirrored with debounce.
- **Keyboard/IME forwarder** — a hidden `<textarea>` catches composition
  events and forwards Unicode codepoints as XK keysyms.
- **Mac key remapping** — Cmd chords are rewritten to Ctrl so Mac users
  get normal copy/paste/undo/select-all.
- **WebAuthn polyfill** — for Okta, Microsoft, Duo, Auth0, Ping
  Identity, Rippling. The local `sand-webauthn-signer.exe` handles
  passkey signing so the box can complete MFA flows without the user
  re-typing codes.
- **Local-network permission polyfill** — lets the noVNC-served pages
  reach `*.local` without the browser's private-network-access prompt.
- **Liveness tripwire** — wraps noVNC's key/pointer/damage handlers to
  count keys, clicks, moves, draw-ops, and inbound bytes. The
  Coordinator uses this to detect a "live" agent vs. a stalled one.
- **Dialog stubs** — `alert`/`confirm`/`prompt` are neutered inside the
  noVNC webview so the agent doesn't get blocked by browser dialogs.

**Process tree inside a box (inferred from bundle paths):**

```
/home/box/sand-data/                # persistent state
/home/box/agent-data/               # agent scratch space
projects/cursor-box-computer/        # the MCP server entry
  └── dist/mcp.js
```

The daemon's RPC surface:

```
control/start      # boot a tool/sandbox
control/release    # tear it down
coordinate         # cross-tool orchestration
tools/call         # MCP tools/call
ping
```

---

## 3. Agent Coordinator — multi-agent orchestration

`node-agent-coordinator/main.cjs` runs as a separate Node process spawned
by the Electron main. It is the bridge between the desktop UI and the
cloud backend's agent API. RPC method names recovered from the bundle:

```
createAgent             # start a new bot/agent
createGroup             # group multiple bots
resolveAgentCreation    # long-poll for creation result
getAgentAutomations     # list scheduled "routines"
events                  # event stream (status, output, errors)
health
```

This is what gives the product its *"bots you can keep around"* feel —
each `createAgent` allocates a long-lived box that survives between
sessions, and `getAgentAutomations` powers the *"run routines while
you're away"* claim.

---

## 4. Backend services — protocol & endpoints

The protocol is **Connect-RPC** (Bufbuild) over HTTP — confirmed by:

- `@connectrpc/connect` + `@connectrpc/connect-node` in dependencies
- `@bufbuild/protobuf` for the 3.8 MB bundled `.proto` schema

**Cloud endpoints (recovered from the bundle):**

| URL | Purpose |
|---|---|
| `https://api2.cursor.sh` | Primary Cursor backend |
| `https://api2.cursor.sh/updates` | Auto-update channel |
| `https://api.origin.cursor.com` | Cursor Origin backend |
| `https://api3.cursor.sh/tev1/v1` | OpenTelemetry trace sink |
| `https://api.x.ai/` | xAI Grok inference |
| `https://api.x.com` | X / Twitter API |
| `https://prod.authentication.cursor.sh` | Cursor auth |
| `https://authenticator.cursor.sh` | Passkey authenticator |
| `https://dev-staging.cursor.sh` | Staging backend (dev boxes) |
| `https://api.statsigcdn.com/v1` | Statsig feature-flag CDN |
| `https://statsigapi.net/v1/sdk_exception` | Statsig error sink |
| `https://featureassets.org/v1` | Feature asset CDN |
| `https://prodregistryv2.org/v1` | Bundle/component registry |
| `https://docs.x.ai/grok-bot` | Public docs |

**IPC bus channels (in-process), named in the bundle:**

```
backend-check-auth-status
backend-list-tools
backend-validate-tokens
backend-http-mcp          # MCP calls proxied over HTTP to backend
backendHttpStatus
backend_unreachable
backend_dropped
backend_gate
```

The `backend-http-mcp` channel is significant: the desktop can
**transparently forward MCP `tools/call` to a remote MCP server** rather
than only running them locally — i.e. plugins on the cloud side.

---

## 5. LLM stack

Recovered model identifiers:

| Model | Use |
|---|---|
| `grok-4.5` | Legacy default |
| `grok-4.6` | Current default |
| `grok-voice-latest` | Voice calls (latest) |
| `grok-voice-think-fast-2.0` | Fast voice path |

Inference is served from `api.x.ai` (not Cursor's own infra), which is
why this is branded as a *Cursor × xAI* product rather than a Cursor
feature.

A dedicated package, `@anysphere/grok-bot-voice-call-harness`, wires
the voice-call subsystem; `@anysphere/grok-bot-harness` is the core
prompt/orchestration harness.

---

## 6. Plugin model — MCP-first

The marketing line *"bots can use plugins you've connected to them"*
maps to a **Model Context Protocol** architecture:

- `@anysphere/mcp-core`, `@anysphere/mcp-agent-exec`, `@anysphere/cursor-plugins`
- Local: `local-exec-daemon` exposes an MCP server (`mcp.js`) for the
  box's own file system, shell, ripgrep, etc.
- Remote: `backend-http-mcp` channels allow bots to call MCP tools
  hosted in the cloud backend.

---

## 7. Google integrations

The OAuth scope list pulled from the bundle shows tight integration with
Google Workspace:

```
gmail.compose       gmail.modify         gmail.readonly
calendar.calendarlist.readonly
calendar.events     calendar.events.freebusy   calendar.events.readonly
documents
drive.file          drive.readonly
presentations
spreadsheets
```

This is how the agent sends email on your behalf, edits Docs/Sheets,
and reads/writes calendar events.

---

## 8. Renderer (UI) stack

Pulled from `renderer/assets/*.js` chunks and `package.json`:

- **React 19.2.1** + **React DOM 19.2.1**
- **Base UI** (`@base-ui/react`) — headless primitives
- **StyleX** (`@stylexjs/stylex`) — Meta's atomic CSS-in-JS
- **TanStack Query 5** — server-state cache
- **Tiptap** — rich-text / WYSIWYG editor (chat composer, doc view)
- **dnd-kit** — drag-and-drop
- **Mermaid** + **Cytoscape** — diagram rendering (`chunk-architectureDiagram`,
  `chunk-cynefin`, `chunk-mermaid.core`)
- **KaTeX** + **remark-math-extended** — math in chat
- **pdfjs-dist** — render PDFs (`chunk-pdf`)
- **mammoth** — `.docx` rendering
- **xlsx** — spreadsheets
- **emojibase-data** — emoji picker

Three preload scripts bridge native ↔ renderer:

| Preload | Role |
|---|---|
| `preload.cjs` | Main process IPC bridge |
| `preload-vnc.cjs` | The noVNC shim layer described in §2 |
| `preload-webview.cjs` | Generic webview preload (chrome-import-worker) |

---

## 9. Cross-cutting services

| Concern | Implementation |
|---|---|
| Tracing | `@opentelemetry/{api,core,sdk-trace-node,exporter-trace-otlp-proto}` → `api3.cursor.sh/tev1/v1` |
| Crash reporting | `@sentry/electron@7.2.0` + `@sentry/node-core@10.17.0` |
| Feature flags | `@statsig/js-client` |
| Auth | 1Password Connect (`onepassword-connection-service.cjs`) + native passkey signer |
| Auto-update | `https://api2.cursor.sh/updates`, `https://downloads.cursor.com` |
| Analytics | `@anysphere/{analytics-client,analytics-types}` |
| Local search | Bundled `ripgrep` (the `--bool`, `--iglob`, `--regexp`, `--hidden` flags in the daemon) |
| Code parsing | `tree-sitter`, `tree-sitter-bash`, `web-tree-sitter` (for safe shell parsing) |

---

## 10. Build & identity

- **Version:** 0.47.0
- **Build ID:** `f22400e9-2447-4ed8-a73d-582cb5abc12a`
- **Internal name:** `sand` (everywhere: package name, entitlement IDs, macOS bundle ID, native binary name)
- **macOS bundle ID:** `com.anysphere.sand`
- **Author / publisher:** `SpaceXAI`
- **Deep links:** `anysphere.cursor-deeplink/background-agent`, `anysphere.cursor-mcp`
- **Electron version:** Chromium-based (~ v8-context-snapshot binary present)
- **Optimisation:** Custom V8 code-cache wiring (cache dir: `v8-code-cache/<bundle>-<buildId>.v8`, retains top-2 recent, expires after 1 h)

---

## 11. Key architectural takeaways

1. **It's three layers, not two.** Box (cloud VM) ←→ Coordinator (local
   Node) ←→ Renderer (Electron UI). The box is the unit of persistence
   and isolation; the Coordinator is the orchestration brain; the UI is
   a thin React shell over noVNC + Connect-RPC.
2. **The "bot" is the box, not the LLM.** A bot = a long-lived VM with
   its own disk (`sand-data`) and MCP server (`cursor-box-computer`).
   Context that "compounds over time" is literally the persistent
   filesystem on the box.
3. **VNC is the I/O substrate.** All user input → box, and all
   screen-out → UI flows through VNC, even though the *application
   protocol* is MCP and Connect-RPC. That's why so much of `preload-vnc.cjs`
   is about correctness of input forwarding (IME, Mac chords, clipboards,
   passkeys).
4. **xAI is the brain, Cursor is the body.** Inference = `api.x.ai`,
   identity/auth/updates/billing = `*.cursor.sh`. Hence the
   *"Cursor × xAI"* framing.
5. **MCP is the plugin story.** Both local tools (rg, fs, shell) and
   remote/backend plugins are reached through the same `tools/call`
   envelope — that's what lets a bot "use plugins you've connected."
6. **Sandboxing is end-to-end.** Each bot runs in its own VM; the local
   daemon spawns tools as separate processes; WebAuthn is delegated to
   a native signer that the user trusts (`sand-webauthn-signer.exe`).

---

## 12. File map

```
C:\Users\simth\AppData\Local\Programs\Grok Bot\
├── Grok Bot.exe                # Electron host (~217 MB)
├── LICENSE.electron.txt
├── LICENSES.chromium.html
├── Uninstall Grok Bot.exe
├── locales/                    # 50+ Chromium .pak files
└── resources/
    ├── app.asar                # 34 MB packed JS
    ├── app.asar.unpacked/
    │   └── dist/
    │       ├── deps/
    │       │   ├── cursor-proclist/
    │       │   ├── node-addon-api/
    │       │   ├── node-gyp-build/
    │       │   ├── onepassword-connection-service.cjs
    │       │   ├── runtime-deps-manifest.json
    │       │   ├── tree-sitter/ + tree-sitter-bash/ + web-tree-sitter/
    │       ├── electron-main/  # main.cjs, main-app.cjs, main-core.cjs, proto.cjs
    │       ├── electron-preload/# preload.cjs, preload-vnc.cjs, preload-webview.cjs
    │       ├── local-exec-daemon/main.cjs
    │       ├── native/sand-webauthn-signer.exe
    │       ├── node-agent-coordinator/main.cjs
    │       └── renderer/       # index.html + assets/*.js (React bundle)
    └── elevate.exe
```

Extracted asar mirror lives at `D:/claude/Grokbot/research/extracted-asar/`.

---

*All claims above were derived from inspecting the installed bundle at
`C:\Users\simth\AppData\Local\Programs\Grok Bot\resources\app.asar`
(no network calls, no decompilation of `.node` binaries). Confidence
is high for protocol/endpoint strings and process topology, moderate
for the box internal layout (inferred from path conventions in the
daemon and entitlements).*
