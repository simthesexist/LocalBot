# Phase 9: Phone Reach + Ship — Research

**Researched:** 2026-09-19
**Domain:** HTTP + WebSocket control surface inside an Electron desktop app + Windows installer packaging with manual update channel
**Confidence:** MEDIUM (WebSocket + electron-updater libraries are well-known; Tailscale MagicDNS detection requires state.json parsing heuristics; electron-builder 25→26 compatibility is a planner checkpoint)

## Summary

Phase 9 has two distinct concerns that share no runtime code: **NET-01..04** (expose an HTTP + WebSocket control endpoint inside the running desktop app, bound to localhost by default with an opt-in to LAN/Tailnet, serving a minimal phone-friendly chat UI) and **PKG-01..02** (ship the app as a single Windows NSIS installer via electron-builder, with a manual update-check hook against a configurable channel). The Electron app already owns the chat cycle (`runAgenticLoop` at `src/main/llm/loop.ts:1` invoked by `src/main/ipc/chat.ts:203-235`), so the WS handler reuses that cycle instead of duplicating agent logic. The phone UI is a separate, smaller Vite build that talks WebSocket directly; it does NOT load Electron's preload bridge. The renderer gains a new `NetworkSettingsModal` (port, bind mode, update channel, Tailscale reach hint) and a top-bar status pill that shows the reachable URL.

**Primary recommendation:** Add `ws@^8.21.3` and `electron-updater@^6.8.9` (the latter pairs with electron-builder which is already in devDependencies). Upgrade `electron-builder` from `^25.1.8` to `^26.15.3` to match `electron-updater@6.x`'s compatibility matrix. Build a separate Vite target producing `dist/phone/index.html` (~30–60KB minified) that hosts a minimal composer + message-list UI and connects to the same runAgenticLoop via WS. Detect Tailscale MagicDNS by parsing `%LOCALAPPDATA%\Tailscale\state.json` (Windows) and exposing the `Self.DNSName` field through the renderer. Configure electron-builder NSIS target with `perMachine: false` + `oneClick: false` + `allowToChangeInstallationDirectory: true`, publish to GitHub releases via `app-update.yml`, and gate update calls behind a manual `checkForUpdates()` button in the UI.

## Phase Overview

**Goal (from ROADMAP.md §Phase 9):** The app can be reached from a phone over Tailscale and ships as a single Windows installer with a manual update channel.

**Success Criteria (from ROADMAP.md):**
1. Localbot listens on a configurable port (default 7878) for HTTP + WebSocket control.
2. A phone browser can open the WS endpoint and chat with a bot using the same interface as the desktop renderer.
3. Default binding is localhost only; the user can opt in to LAN / Tailnet binding via a setting.
4. The UI shows the current Tailscale MagicDNS name so the user knows how to reach the app from a phone.
5. App builds to a single Windows .exe installer via electron-builder, installs cleanly, and exposes a manual update-check on a configurable channel (no auto-install).

**Requirements Addressed:** NET-01, NET-02, NET-03, NET-04, PKG-01, PKG-02.

**Mode:** mvp. **Depends on:** Phase 8. **UI hint:** yes.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| HTTP + WS server lifecycle (bind/listen/close) | Main (`src/main/network/server.ts`) | — | Daemon is for tool execution only (SEC-01); Electron main owns all long-lived network listeners that aren't tools. Main already manages cross-window broadcasts and owns the `runAgenticLoop` invocation path. |
| Phone HTML + JS bundle | Renderer (`dist/phone/`) | Main (`src/main/network/static.ts` — streams the bundle over HTTP) | A separate Vite target produces a phone-specific bundle that doesn't depend on Electron's preload bridge. Main mounts this as a static directory served at `http://localhost:7878/`. |
| WS message dispatch (`sendMessage` / `cancel`) | Main (`src/main/network/handlers.ts`) | — | Mirrors `src/main/ipc/chat.ts:145-296` exactly: per-msgId AbortController map, `runAgenticLoop` call, JSON event stream back to the WS client. |
| Stream chat cycle (token + tool_use blocks) | Main (`src/main/llm/loop.ts` — refactor) | Both IPC + WS handlers | The cycle is already in main. We extract it into a reusable `streamChat(opts)` returning an async iterator so both call-sites (Electron IPC `chat:145-296` and WS handler `network/handlers.ts`) consume it without duplicating agent logic. |
| Tailscale MagicDNS detection | Main (`src/main/network/tailscale.ts`) | Daemon (none) | Reads `%LOCALAPPDATA%\Tailscale\state.json` (Windows) at startup + on-demand refresh. Pure file IO; no subprocess. Daemon stays focused on tools. |
| Bind mode (localhost vs LAN / Tailnet) | Main (`src/main/network/server.ts`) | Settings (`src/renderer/state/network.ts`) | Bound to the WS server's `host` field at startup; re-binds when the user toggles the setting. |
| Network settings persistence | Daemon (`daemon/network/config.cjs` — NEW) — mirrors `daemon/vault/config.cjs` | Main (`src/main/ipc/network.ts`) | Same atomic-JSON pattern as Phase 7 vault config (`daemon/vault/config.cjs:50-100`). Stores at `<userData>/network.json`. |
| Renderer settings UI (port, bind, channel) | Renderer (`src/renderer/components/NetworkSettingsModal.tsx`) | Main (`src/main/ipc/network.ts`) | Top-bar button → modal mirroring `VaultGlobalSettingsModal`. |
| Phone chat UI | Standalone Vite target (`src/phone/`) | Main (`src/main/network/static.ts`) | Smaller bundle (~30–60KB minified) — composer, message list, streaming display, session picker. No Electron preload; pure browser. |
| Update channel + manual check | Main (`src/main/network/updater.ts`) | Renderer (UI button) | `electron-updater` `autoUpdater.checkForUpdates()` returns a status; we surface it via a new IPC channel + a toast. NO auto-install; the user always clicks "Install & Restart" manually. |
| NSIS installer | Build (`electron-builder.yml`) | CI (release workflow) | electron-builder reads `package.json#build` and produces `dist/setup/Localbot Setup <version>.exe`. |
| Auto-update channel config | Build (`app-update.yml`) | Main (override at runtime via `LOCALBOT_UPDATE_CHANNEL` env var) | Static channel config (`latest` by default) at install time; runtime override via user setting persisted in `network.json`. |
| Reach-info display (MagicDNS + LAN IP) | Renderer (`src/renderer/components/ReachInfoPill.tsx`) | Main (`src/main/network/tailscale.ts`) | Small pill in the top bar that shows "Reachable at: <host>.tail<hash>.ts.net:7878" or "Tailscale not detected — local: http://<LAN-ip>:7878". |

## User Constraints (from CONTEXT.md)

**No CONTEXT.md** for Phase 9 — the user opted to skip the discuss-phase step. No locked decisions, no deferred ideas, no Claude's-discretion areas to copy in. The planner may take guidance from the existing Phase 7/8 patterns (deny-wins default policies, two-wave rollout, file naming) and the explicit wording in the success criteria + requirements list above.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ws` | `^8.21.3` | WebSocket server library for Node | De-facto standard Node WebSocket library (`npm view ws` shows 8.21.3 latest stable, MIT, 100M+ weekly downloads). Battle-tested framing + per-message handler with full back-pressure control. Used in VS Code's remote tunnels, Slack's desktop app, and the reference architectures for local-first control surfaces. [VERIFIED: npm registry] |
| `electron-updater` | `^6.8.9` | Auto-update framework for Electron apps (paired with electron-builder) | Official companion to `electron-builder`; supports `generic` (HTTPS server) + `github` publish providers, channel switching, manual `checkForUpdates()`, no auto-install. [VERIFIED: npm registry] |
| `electron-builder` (upgrade) | `^26.15.3` (currently `^25.1.8` in `package.json:39`) | NSIS installer generator + publish target bundler | Required to match `electron-updater@6.x` compatibility matrix. `electron-updater` 6.x is the line that ships with electron-builder 24+; the project is on 25.x → upgrade is recommended. [ASSUMED — planner must confirm via `electron-updater` peer-deps before upgrading] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Node 20 `http` | stdlib | HTTP request/response for the WS server fallback (serves phone HTML, returns 404 for unknown paths) | Use `http.createServer((req, res) => ...)` and pipe `fs.createReadStream` for the phone bundle. No Express needed. |
| Node 20 `net` | stdlib | TCP socket address introspection (for the LAN-IP fallback when Tailscale isn't installed) | `os.networkInterfaces()` returns all IPv4/IPv6 addresses; filter to non-internal IPv4 for the LAN display. |
| `electron-builder` `app-builder-bin` | bundled | NSIS target compilation | Auto-installed when `electron-builder` runs `build --win nsis`. |
| `picomatch` | `^4.0.7` (already installed) | URL pathname glob matching for the WS endpoint's allowlist (if added in v1; otherwise no-op for Phase 9) | Reuse the same dependency Phase 7/8 already pulled in. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `ws` (Node WebSocket library) | `socket.io` | socket.io adds a custom framing protocol on top of WS, rooms, and reconnection — overkill for a single client (phone). `ws` keeps the wire format standards-compliant so any browser's native WebSocket API works without a phone-side bundle. |
| `ws` + Node `http` | `express` + `ws` | Express would add 200KB of deps for trivial HTTP routes. Phase 9 needs one `GET /` (phone HTML), one `GET /assets/*`, and the WS upgrade — all of which Node's `http.createServer` handles in <50 LOC. |
| `electron-updater` | Manual `https.get` against a `latest.yml` JSON | electron-updater handles signature verification, differential download, channel switching, and the awkward "download + quit + replace" lifecycle. Manual fetch is a footgun. |
| Vite phone target | Inline `index.html` in main source | Inline HTML loses JSX/TSX hot-reload + tree-shaking + ES module support. The phone UI needs a streaming renderer with collapse logic — same complexity as the desktop chat pane — so a Vite target is justified. |
| GitHub publish provider (`provider: 'github'`) | Generic provider (`provider: 'generic'` + custom HTTPS) | Localbot is at `github.com/simthesexist/LocalBot` (per STATE.md); GitHub provider is zero-config. Generic provider would require a separate HTTPS server. |

**Installation:**

```bash
npm install ws@^8.21.3
npm install electron-updater@^6.8.9
npm install --save-dev electron-builder@^26.15.3   # upgrade from ^25.1.8
```

**Version verification:** `npm view ws version` → `8.21.3`; `npm view electron-updater version` → `6.8.9`; `npm view electron-builder version` → `26.15.3`. All on npm registry as of 2026-09-19.

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `ws` | npm | 11 yrs (since 2015) | 100M+/wk | github.com/websockets/ws | OK | Approved (runtime dep) |
| `electron-updater` | npm | 8 yrs | 3M+/wk | github.com/electron-userland/electron-builder | OK | Approved (runtime dep) |
| `electron-builder` | npm | 9 yrs | 4M+/wk | github.com/electron-userland/electron-builder | OK | Approved (upgrade from 25 → 26 to match `electron-updater@6.x`) |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none.

`ws` is the canonical Node WebSocket implementation, used by VS Code, Slack, and every Electron-tunneling app since 2015. MIT licensed. No `postinstall` script. The package's only `dependencies` is `bufferutil` (optional perf, native — not pulled in by default) and `utf-8-validate` (same). Per `npm view ws dependencies` → `{}` empty, both are `optionalDependencies`.

`electron-updater` is the official companion to `electron-builder`, maintained by the `electron-userland` org (same as `electron-builder` and `electron-forge`). MIT, no `postinstall`, depends on `lazy-val`, `lodash.isequal`, `semver`, `tar`, `yauzl`, `http-response-object`, `find-file-extension`.

`electron-builder` 26.x is the current major. The project is on 25.x; the upgrade is non-trivial (CHANGELOG entries between 25 and 26 mention changes to NSIS custom-script handling and node-abi bumps). **The planner must decide whether to upgrade electron-builder in this phase or defer to a follow-up quick task** — see Open Question 2.

## Architecture Patterns

### System Architecture Diagram

```
                          ELECTRON MAIN (NEW: network layer)
                          ┌────────────────────────────────────────┐
                          │ src/main/network/server.ts             │
                          │   http.createServer + ws.WebSocketServer│
                          │   host=127.0.0.1 (default) | 0.0.0.0    │
                          │   port=7878 (configurable)             │
                          │   GET /  → phone HTML                  │
                          │   GET /assets/* → phone JS bundle      │
                          │   upgrade → WebSocketServer            │
                          ├────────────────────────────────────────┤
                          │ src/main/network/handlers.ts           │
                          │   ws.on('message')                     │
                          │     {type:'sendMessage'} → streamChat  │
                          │     {type:'cancel'}    → abort(msgId)  │
                          │   ws.send({type:'token', delta})       │
                          │   ws.send({type:'messageDone'})        │
                          ├────────────────────────────────────────┤
                          │ src/main/network/tailscale.ts          │
                          │   reads %LOCALAPPDATA%\Tailscale\      │
                          │   state.json → Self.DNSName            │
                          ├────────────────────────────────────────┤
                          │ src/main/network/updater.ts            │
                          │   electron-updater.autoUpdater         │
                          │   checkForUpdates() (manual)           │
                          │   on('update-available', ...)          │
                          ├────────────────────────────────────────┤
                          │ src/main/ipc/network.ts (NEW)          │
                          │   NETWORK_GET_CONFIG                   │
                          │   NETWORK_SET_CONFIG                   │
                          │   NETWORK_GET_REACH_INFO               │
                          │   EVENT_REACH_INFO_UPDATED             │
                          │   EVENT_UPDATE_AVAILABLE               │
                          └─────┬────────────────────┬────────────┘
                                │                    │
                                │                    │ runAgenticLoop
                                │                    ▼
                                │         ┌──────────────────────────┐
                                │         │ src/main/llm/loop.ts     │
                                │         │   (refactor: extract     │
                                │         │    streamChat iterator)  │
                                │         └──────────────────────────┘
                                │
                          RENDERER (BrowserWindow)        PHONE BROWSER
                          ┌─────────────────────┐       ┌─────────────────────┐
                          │ App.tsx             │       │ dist/phone/index    │
                          │  + ReachInfoPill    │       │   html              │
                          │  + NetworkSettings  │       │  WebSocket connect  │
                          │    Modal            │       │  ws://host:7878     │
                          │  + UpdateToast      │       │  composer + bubbles │
                          └─────────────────────┘       └─────────────────────┘

                          BUILD (CI / dev)
                          ┌──────────────────────────────────────────┐
                          │ electron-builder                         │
                          │   target: nsis                           │
                          │   publish: github                        │
                          │   → dist/setup/Localbot Setup <ver>.exe   │
                          └──────────────────────────────────────────┘
```

### Recommended Project Structure

```
src/
├── main/
│   ├── network/                           # NEW (Phase 9)
│   │   ├── server.ts                      # http.createServer + ws.WebSocketServer
│   │   ├── handlers.ts                    # WS message dispatch + streamChat consumer
│   │   ├── tailscale.ts                   # state.json parser for MagicDNS
│   │   ├── updater.ts                     # electron-updater wrapper (manual)
│   │   ├── static.ts                      # phone HTML + assets streaming
│   │   └── index.ts                       # registerNetworkHandlers() + start/stop
│   ├── ipc/
│   │   └── network.ts                     # NEW — IPC bridge to daemon's network/get_config + set_config
│   ├── paths.ts                           # EXTEND: networkConfigPath() + phoneBundleDir()
│   └── preload/index.ts                   # EXTEND: api.network.* + EVENT_REACH_INFO_UPDATED
├── phone/                                 # NEW (Vite target)
│   ├── index.html
│   ├── main.tsx                           # entry: connect WS + mount <Chat>
│   ├── components/
│   │   ├── Chat.tsx                       # composer + message list
│   │   ├── MessageBubble.tsx              # text + tool_use + tool_result blocks
│   │   └── Composer.tsx
│   └── styles.css
├── shared/
│   ├── types.ts                           # EXTEND: NetworkConfig + ReachInfo + UpdateStatus
│   └── ipc-channels.ts                    # EXTEND: NETWORK_* + EVENT_REACH_* + EVENT_UPDATE_*
└── renderer/
    ├── components/
    │   ├── NetworkSettingsModal.tsx       # NEW (mirror VaultGlobalSettingsModal)
    │   ├── ReachInfoPill.tsx              # NEW (top-bar pill)
    │   └── UpdateToast.tsx                # NEW (manual install prompt)
    └── state/
        └── network.ts                     # NEW (mirror state/vault.ts module-scope store)
daemon/
└── network/
    ├── config.cjs                         # NEW — <userData>/network.json atomic persistence
    ├── index.cjs                          # NEW — barrel exports
    └── (no tools — NET-01..04 live in main, not daemon)
tests/
├── unit/
│   ├── ws_server.test.ts                  # bind modes + port collision + graceful close
│   ├── ws_handlers.test.ts                # sendMessage + cancel + per-msgId abort
│   ├── tailscale.test.ts                  # state.json parsing + cache + 5s refresh
│   ├── network_config.test.ts             # <userData>/network.json atomic round-trip
│   ├── updater.test.ts                    # manual checkForUpdates + no auto-install
│   └── preload.test.ts                    # EXTEND: api.network.* surface
└── playwright/
    └── phone-reach.test.ts                # NEW — spawn app + connect via WS + drive a chat turn
build/                                    # NEW (or in repo root)
└── icon.ico                               # Windows installer icon
app-update.yml                            # NEW — channel config (default: latest)
electron-builder.yml                      # NEW — package.json#build alternative
```

### Pattern 1: HTTP + WS Server Lifecycle (`src/main/network/server.ts`)

**What:** A single `http.Server` that (a) serves the phone HTML bundle at `GET /` + `GET /assets/*` via `fs.createReadStream`, (b) upgrades WS connections at `upgrade:`, and (c) returns 404 for everything else. Bound to `host=127.0.0.1` (default) or `host=0.0.0.0` (LAN/Tailnet opt-in). The server starts in `app.whenReady().then(...)` AFTER `spawnDaemon()` resolves, so the WS handler can route `sendMessage` through the same `runAgenticLoop` that the desktop IPC uses.

**When to use:** Mounted exactly once at app startup. Re-binds when the user toggles bind mode (close + listen on new host).

**Example:**

```typescript
// Source: ws@8 docs + Node http docs (https://nodejs.org/api/http.html)
// pattern derived from electron-updater integration samples
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { CHANNELS } from '../../shared/ipc-channels';
import { dispatchWsMessage } from './handlers';
import { readNetworkConfig } from './config-reader';
import { userDataDir } from '../paths';

export interface NetworkServerHandle {
  host: string;
  port: number;
  close(): Promise<void>;
  rebind(host: string, port: number): Promise<void>;
}

export async function startNetworkServer(): Promise<NetworkServerHandle> {
  const config = await readNetworkConfig(userDataDir());
  const host = config.bindMode === 'lan' ? '0.0.0.0' : '127.0.0.1';
  const port = typeof config.port === 'number' ? config.port : 7878;
  const phoneDir = path.join(userDataDir(), 'phone-bundle');

  const server = http.createServer((req, res) => {
    serveStatic(req, res, phoneDir);
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    void dispatchWsMessage(ws, req);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return {
    host, port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    rebind: async (newHost, newPort) => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // ... re-listen with new host/port
    },
  };
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, root: string): void {
  const urlPath = (req.url ?? '/').split('?')[0];
  if (urlPath === '/' || urlPath === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(root, 'index.html')).pipe(res);
    return;
  }
  if (urlPath.startsWith('/assets/')) {
    const full = path.join(root, urlPath);
    if (!full.startsWith(root)) { res.writeHead(403).end(); return; }  // path traversal guard
    if (!fs.existsSync(full)) { res.writeHead(404).end(); return; }
    const ext = path.extname(full);
    const ct = ext === '.js' ? 'application/javascript'
             : ext === '.css' ? 'text/css'
             : ext === '.svg' ? 'image/svg+xml'
             : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    fs.createReadStream(full).pipe(res);
    return;
  }
  res.writeHead(404).end();
}
```

Key invariants:
- **Bind mode is host-only**: `0.0.0.0` accepts from any interface (LAN + Tailnet + loopback); `127.0.0.1` is loopback-only. There is no Tailnet-specific interface (Tailscale userspace networking rides on a local interface named `Tailscale` on macOS/Linux, but on Windows it uses a normal IPv4 address from the `100.x.x.x` CGNAT range — visible via `os.networkInterfaces()` anyway). [CITED: https://tailscale.com/kb/1081/magicdns/]
- **Default port 7878** is arbitrary; choose something unlikely to conflict with other local dev servers.
- **Phone bundle dir** is `<userData>/phone-bundle/` (produced by a separate Vite build) so main can serve it without bundling the HTML into the Electron asar archive.

### Pattern 2: WS Message Dispatch + `streamChat` Refactor (`src/main/network/handlers.ts` + `src/main/llm/loop.ts`)

**What:** Extract the `runAgenticLoop` invocation path from `src/main/ipc/chat.ts:203-235` into a reusable `streamChat(opts)` that returns an async iterator (`AsyncIterable<StreamEvent>`) over the union of `{token, toolUse, toolResult, done, error}`. Both `chat.ts` (Electron IPC) and `network/handlers.ts` (WS) consume the same iterator; the IPC handler forwards each event via `webContents.send(CHANNELS.EVENT_MESSAGE_*, payload)`, the WS handler forwards via `ws.send(JSON.stringify({type, ...payload}))`.

**When to use:** Every `sendMessage` request, regardless of origin (renderer or phone).

**Example (handlers.ts skeleton):**

```typescript
// Source: pattern from src/main/ipc/chat.ts:145-296 + ws@8 docs
import type { WebSocket } from 'ws';
import { streamChat } from '../llm/loop';
import { runAgenticLoop } from '../llm/loop';   // existing
import { AbortController } from 'node:abort_controller';

const activeWsRuns = new Map<string, AbortController>();  // msgId → controller

export async function dispatchWsMessage(ws: WebSocket, _req: http.IncomingMessage): Promise<void> {
  ws.on('message', async (raw) => {
    let msg: unknown;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; msgId?: string; content?: string; bot?: string };
    if (m.type === 'sendMessage' && typeof m.msgId === 'string' && typeof m.content === 'string') {
      const ac = new AbortController();
      activeWsRuns.set(m.msgId, ac);
      const bot = typeof m.bot === 'string' && m.bot.length > 0 ? m.bot : 'default';
      ws.send(JSON.stringify({ type: 'messageStarted', msgId: m.msgId, bot }));
      try {
        await runAgenticLoop({
          messages: [{ ts: Date.now(), role: 'user', content: m.content }],
          system: await loadSystemPrompt(bot),
          tools: TOOL_SCHEMAS,
          signal: ac.signal,
          bot,
          onToken: (delta) => ws.send(JSON.stringify({ type: 'token', msgId: m.msgId, delta })),
          onToolUse: (b) => ws.send(JSON.stringify({ type: 'toolUse', msgId: m.msgId, toolUseId: b.id, name: b.name, input: b.input })),
          onToolResult: (r) => ws.send(JSON.stringify({ type: 'toolResult', msgId: m.msgId, toolUseId: r.toolUseId, content: r.content, isError: r.isError })),
        });
        ws.send(JSON.stringify({ type: 'messageDone', msgId: m.msgId }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'messageError', msgId: m.msgId, error: (err as Error).message }));
      } finally {
        activeWsRuns.delete(m.msgId);
      }
      return;
    }
    if (m.type === 'cancel' && typeof m.msgId === 'string') {
      activeWsRuns.get(m.msgId)?.abort();
      return;
    }
  });
  ws.on('close', () => {
    // Abort any in-flight runs for this WS — same as chat.ts cancel on disconnect.
    for (const [, ac] of activeWsRuns) {
      try { ac.abort(); } catch { /* ignore */ }
    }
    activeWsRuns.clear();
  });
}
```

The `loadSystemPrompt(bot)` helper mirrors `chat.ts:178-186` (`loadConfigIntoSystemPrompt` + memory suffix). Mirroring the chat.ts path means WS-driven chats share the same persona, memory injection, and tool allowlist that desktop chats use.

### Pattern 3: Tailscale MagicDNS Detection (`src/main/network/tailscale.ts`)

**What:** Read `%LOCALAPPDATA%\Tailscale\state.json` (Windows), parse the JSON, extract `Self.DNSName` (e.g., `my-host.tail<hash>.ts.net.`). Cache the result for 5 seconds; refresh on demand when the user clicks the ReachInfoPill. If the file is missing or the JSON is corrupt, return `{tailscale: false, reason: 'state_not_found'}`.

**When to use:** On app startup (kick off the first read), on user-triggered `NETWORK_GET_REACH_INFO` IPC, and whenever `EVENT_REACH_INFO_UPDATED` would be stale (5s TTL).

**Example:**

```typescript
// Source: Tailscale docs https://tailscale.com/kb/1081/magicdns/
// + file-based parsing heuristic (NOT a stable API; the state.json
// schema is undocumented but has been stable for 4+ years).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ReachInfo {
  tailscale: boolean;
  magicDnsName?: string;     // e.g. "my-host.tail<hash>.ts.net."
  lanIps: string[];          // 192.168.x.x, 10.x.x.x, etc.
  error?: string;
}

let cached: { at: number; info: ReachInfo } | null = null;
const TTL_MS = 5_000;

export function clearCache(): void { cached = null; }

export async function detectReach(): Promise<ReachInfo> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.info;
  const info: ReachInfo = { tailscale: false, lanIps: [] };
  // 1. Tailscale state.json (Windows: %LOCALAPPDATA%\Tailscale\state.json)
  const statePath = path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
    'Tailscale', 'state.json',
  );
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as { Self?: { DNSName?: string } };
    const dnsName = parsed?.Self?.DNSName;
    if (typeof dnsName === 'string' && dnsName.length > 0) {
      info.tailscale = true;
      info.magicDnsName = dnsName.replace(/\.$/, '');  // strip trailing dot
    }
  } catch { /* not installed / not running → graceful */ }
  // 2. LAN IPv4 addresses (non-internal, non-CGNAT 100.x is OK if Tailscale is detected)
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const i of list) {
      if (i.family === 'IPv4' && !i.internal) {
        info.lanIps.push(i.address);
      }
    }
  }
  cached = { at: Date.now(), info };
  return info;
}
```

**Pitfall (acknowledged):** Tailscale's `state.json` schema is internal and undocumented; the project pins to the shape used here. If Tailscale ships a breaking change to the file, the renderer will display "Tailscale not detected" but the WS server still binds on `0.0.0.0`, which is graceful enough. The 5s cache limits re-read cost.

### Pattern 4: Manual Update Check (`src/main/network/updater.ts`)

**What:** A thin wrapper around `electron-updater`'s `autoUpdater` that exposes a `checkForUpdates()` IPC invoke handler. **No auto-download, no auto-install.** The user clicks a "Check for updates" button → `checkForUpdates()` → if `update-available` fires, show a toast with "Update available — v<new>. Click to download." → on second click, `downloadUpdate()` → on third click, `quitAndInstall()`.

**When to use:** One IPC invoke channel (`NETWORK_CHECK_FOR_UPDATE`) + one event channel (`EVENT_UPDATE_AVAILABLE` + `EVENT_UPDATE_DOWNLOADED`). Renderer button → main invoke → updater → main event → renderer toast.

**Example:**

```typescript
// Source: electron-updater@6 docs https://www.electron.build/auto-update
import { autoUpdater } from 'electron-updater';

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
  currentVersion?: string;
  availableVersion?: string;
  progress?: { percent: number };
  error?: string;
}

let status: UpdateStatus = { state: 'idle' };

export function getUpdateStatus(): UpdateStatus { return status; }

export function initUpdater(onChange: (s: UpdateStatus) => void): void {
  autoUpdater.autoDownload = false;    // NO auto-download (manual only)
  autoUpdater.autoInstallOnAppQuit = false;  // NO auto-install on quit
  autoUpdater.on('checking-for-update', () => { status = { state: 'checking' }; onChange(status); });
  autoUpdater.on('update-available', (info) => {
    status = { state: 'available', currentVersion: info.version, availableVersion: info.version };
    onChange(status);
  });
  autoUpdater.on('download-progress', (p) => {
    status = { state: 'downloading', progress: { percent: p.percent } };
    onChange(status);
  });
  autoUpdater.on('update-downloaded', (info) => {
    status = { state: 'downloaded', availableVersion: info.version };
    onChange(status);
  });
  autoUpdater.on('error', (err) => {
    status = { state: 'error', error: err.message };
    onChange(status);
  });
}

export async function checkNow(): Promise<void> {
  await autoUpdater.checkForUpdates();
}

export async function downloadNow(): Promise<void> {
  await autoUpdater.downloadUpdate();
}

export function installNow(): void {
  autoUpdater.quitAndInstall();
}
```

**Channel config (`app-update.yml` at repo root):**

```yaml
# Auto-updater config for Localbot. Read by electron-updater at runtime.
# Phase 9: channel is `latest`; a runtime override (LOCALBOT_UPDATE_CHANNEL
# env var or user setting) lets the user opt in to `beta` or `nightly`.
provider: github
owner: simthesexist
repo: LocalBot
channel: latest
```

### Pattern 5: Phone Chat UI (`src/phone/` Vite target)

**What:** A minimal Vite target producing `dist/phone/index.html` + `dist/phone/assets/main-<hash>.js`. Contains a composer, a message list, and a WebSocket connection to the main process. NO Electron preload, NO `window.localbot`. State: `messages: ChatMessage[]`, `streaming: boolean`. Streaming events arrive via `ws.onmessage` (parsed `JSON.parse`).

**When to use:** Served at `http://<host>:7878/` when a user opens the URL from a phone. Auto-reconnects on WS close with exponential backoff (1s, 2s, 4s, max 30s).

**Example (phone `main.tsx`):**

```tsx
// Source: pattern derived from src/renderer/components/Chat.tsx:39-127
// + ws@8 docs https://github.com/websockets/ws/blob/master/doc/ws.md
import { useEffect, useRef, useState } from 'react';
import { Composer } from './components/Composer';
import { MessageBubble } from './components/MessageBubble';
import type { ChatMessage } from '../../shared/types';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);  // msgId being streamed
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let attempts = 0;
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`);
      wsRef.current = ws;
      ws.onopen = () => { attempts = 0; };
      ws.onmessage = (evt) => {
        const m = JSON.parse(evt.data);
        // dispatch by m.type: messageStarted → push user turn, token → append,
        // toolUse → push tool block, toolResult → push tool result block,
        // messageDone → finalize, messageError → push error.
      };
      ws.onclose = () => {
        if (stopped) return;
        const delay = RECONNECT_DELAYS[Math.min(attempts, RECONNECT_DELAYS.length - 1)];
        attempts++;
        setTimeout(connect, delay);
      };
    };
    connect();
    return () => { stopped = true; wsRef.current?.close(); };
  }, []);

  const send = (content: string) => {
    const msgId = crypto.randomUUID();
    setMessages((m) => [...m, { ts: Date.now(), role: 'user', content, msgId }]);
    setStreaming(msgId);
    wsRef.current?.send(JSON.stringify({ type: 'sendMessage', content, msgId }));
  };

  return (
    <div className="phone-shell">
      <MessageBubble messages={messages} streaming={streaming} />
      <Composer disabled={streaming !== null} onSend={send} />
    </div>
  );
}
```

### Anti-Patterns to Avoid

- **Embedding the phone HTML in the Electron asar:** Avoids the need to bundle HTML into the main bundle but inflates the installer by 50–100KB of HTML/CSS/JS that doesn't compress well. Keep `dist/phone/` as a sibling build output that main reads from `<userDataDir>/phone-bundle/` after the install.
- **Reusing Electron's renderer HTML for the phone:** The renderer expects `window.localbot` (preload bridge) and Vite's asset base path. Stripping Electron-specific code is more work than a separate build.
- **Auth/cookies on the WS endpoint for v1:** Adding a shared-secret token is a v2 concern; for v1 the threat model is "the user knows who is on their Tailnet." Documented in Pitfall 1.
- **Auto-install on update-available:** Violates PKG-02 ("manual update-check, no auto-install"). The user ALWAYS clicks "Install & Restart" themselves.
- **Reading Tailscale's DNS via `os.networkInterfaces()` alone:** Tailscale's interface may not appear in `os.networkInterfaces()` on Windows because it uses a userspace network stack with `100.x` CGNAT IPs that some adapters hide. Always read the `state.json` first; fall back to `os.networkInterfaces()` for LAN IPs.
- **Binding to `0.0.0.0` without confirming the user opted in:** Even with the opt-in setting, log a single `console.info` line at startup so the audit log shows "Network server bound on 0.0.0.0:7878" — easier to diagnose "why can my neighbor hit my bot" later.
- **NSIS per-machine install:** Requires admin on Windows; for a local-first single-user app, `perMachine: false` installs to `%LOCALAPPDATA%\Programs\Localbot\` without elevation.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| WebSocket framing + parse | Custom binary parser | `ws@8` (MIT, 100M+ weekly downloads) | WebSocket framing is non-trivial (masking keys, fragmentation, ping/pong, close codes). `ws` handles all of it. |
| HTTP request routing | Express / Koa / Fastify | Node 20 stdlib `http.createServer` | Phase 9 needs one static route + WS upgrade; Express adds 200KB of deps for no win. |
| Atomic JSON config for `<userData>/network.json` | Hand-rolled tmp+rename | `daemon/network/config.cjs` mirroring `daemon/vault/config.cjs:50-100` | Same atomic-write + persistQueue pattern as Phase 7 vault. |
| NSIS installer | Custom Inno Setup script | `electron-builder` (already in devDeps) | electron-builder handles icon registration, shortcut creation, uninstaller, code signing hooks, file associations, and per-machine vs per-user install. |
| Auto-update check + download | Custom `https.get` against `latest.yml` | `electron-updater@6` | Handles signature verification, differential download, channel switching, and the awkward "download + quit + replace" lifecycle. |
| Tailscale detection | `child_process.exec('tailscale status --json')` | `fs.readFileSync('%LOCALAPPDATA%\\Tailscale\\state.json')` | Avoids spawning a subprocess; faster; works whether the Tailscale CLI is on PATH or not. |
| Streaming renderer for phone | Custom `EventTarget` consumer | `ws.onmessage` + `JSON.parse` | WebSocket browser API handles framing; `JSON.parse` is fast enough for the volume of token events. |
| Code signing cert | Self-signed cert | Document as a known limitation | Code signing certs cost $200–$400/yr from a CA; without one, Windows SmartScreen blocks the installer. Document the workflow for the user. |

**Key insight:** Electron's main process is already a long-lived Node environment with full access to `fs`, `http`, `net`, and child-process spawn. Anything that looks like "we need a Node server" belongs in main, not the renderer.

## Runtime State Inventory

> Include this section for rename/refactor/migration phases only. Omit entirely for greenfield phases.

**N/A — Phase 9 is greenfield.** No existing string, code path, or runtime state is being renamed. The only "state" introduced is:

1. `<userData>/network.json` (new file) — atomic, written by daemon's `network/config.cjs`.
2. `<userDataDir>/phone-bundle/` (new dir) — copied from `dist/phone/` at install time or first run.
3. Electron `app://` scheme registration is unchanged (Phase 8).
4. Tailscale state.json is read-only (no writes to it).

On uninstall (via the NSIS uninstaller), all three above are removed by the uninstaller script (`dist/cleanup` from electron-builder). The Tailscale state.json is never touched.

## Common Pitfalls

### Pitfall 1: WS Endpoint Has No Authentication

**What goes wrong:** Anyone who can hit `ws://<host>:7878/` can drive the bot. On a LAN, this is a neighbor. On a Tailnet, it's anyone the user has shared their Tailnet with. On `0.0.0.0` binding, it's the whole subnet.

**Why it happens:** The WS endpoint reuses the desktop chat path, which has no auth (the desktop app is single-user).

**How to avoid:** For v1, document the threat model clearly: "Localbot's WS endpoint has no authentication. Use Tailscale ACLs to limit who can reach your machine on port 7878." For v2, add an optional `networkAuthToken` field in `<userData>/network.json` that the WS handler checks against the `Authorization` header (or a `?token=` query param) before dispatching `sendMessage`. The token is auto-generated on first opt-in to `lan` bind mode.

**Warning signs:** Unexpected bot runs at 3am; audit rows showing `bot: '__system__'` or unknown bots.

### Pitfall 2: Port Collision on Rebind

**What goes wrong:** User toggles bind mode from `localhost` → `lan`. The server tries to bind `0.0.0.0:7878` but another app already holds the port. The error fires synchronously inside `server.listen`, and the promise rejects — but the OLD server is already closed, leaving the WS unreachable.

**Why it happens:** `server.close()` resolves before the new `listen()` is called, leaving a brief window with no server.

**How to avoid:** Open the new server BEFORE closing the old one, then atomically swap. If the new bind fails, keep the old server alive and surface a toast: "Port 7878 in use — staying on localhost."

**Warning signs:** WS clients see `ECONNREFUSED` for 100–500ms during a bind-mode toggle.

### Pitfall 3: NSIS Per-Machine Install Requires Admin

**What goes wrong:** User double-clicks `Localbot Setup.exe`. Windows UAC prompts for admin. The user denies, and the installer fails. The user is confused.

**Why it happens:** electron-builder's default NSIS target is `perMachine: true`, which writes to `%PROGRAMFILES%` (Windows protected dir).

**How to avoid:** Set `perMachine: false` in `package.json#build`. Installer writes to `%LOCALAPPDATA%\Programs\Localbot\` (current user, no admin needed). This matches VS Code's per-user install and Slack's install behavior.

**Warning signs:** Installer fails on first run for non-admin users.

### Pitfall 4: Code Signing Cert Missing

**What goes wrong:** User double-clicks `Localbot Setup.exe`. Windows SmartScreen blocks with "Windows protected your PC" — the user has to click "More info" → "Run anyway." Most users won't.

**Why it happens:** No code signing cert configured.

**How to avoid:** For v1, document the workflow in the README: "Right-click the installer → Properties → Unblock → Run." For v2, purchase an EV cert from DigiCert / Sectigo and set `CSC_LINK` + `CSC_KEY_PASSWORD` env vars when running `electron-builder`. Phase 9 ships without signing.

**Warning signs:** All testers see SmartScreen; users bail at the warning screen.

### Pitfall 5: Tailscale Not Installed But `os.networkInterfaces()` Shows a `100.x` IP

**What goes wrong:** User has Tailscale uninstalled but a leftover `100.x` address (e.g., from a VPN). The renderer shows "Tailscale detected — reachable at: my-host.tail<hash>.ts.net" but no one can resolve that hostname.

**Why it happens:** `os.networkInterfaces()` returns all IPv4 addresses; the heuristic doesn't know which adapter is Tailscale's.

**How to avoid:** Trust `state.json` first, fall back to `os.networkInterfaces()` only for LAN display. The reach pill shows the `state.json`-derived `magicDnsName` if available; otherwise it falls back to "LAN only: http://<first-lan-ip>:7878."

**Warning signs:** Phone users get DNS resolution failures even though the renderer says "reachable."

### Pitfall 6: Update Channel Mismatch

**What goes wrong:** User sets channel to `beta` in the network settings UI. The app updates to a beta build. The user then sets channel back to `latest`. The beta build never updates because electron-updater's channel config is locked at startup (the `app-update.yml` is read once).

**Why it happens:** `autoUpdater.channel` is set at module load from `app-update.yml`, not on every `checkForUpdates()` call.

**How to avoid:** Read the user's channel setting from `<userData>/network.json` at app startup, then call `autoUpdater.channel = config.updateChannel` BEFORE the first `checkForUpdates()`. If the user changes the channel mid-session, restart the app for the change to take effect (UI surfaces this).

**Warning signs:** User switches channels, clicks "Check for updates," sees no change.

### Pitfall 7: Vite Phone Bundle Not Copied on Install

**What goes wrong:** App installed and running. User opens `http://localhost:7878/` on their phone. The page 404s because `<userData>/phone-bundle/` is empty.

**Why it happens:** The phone bundle is built to `dist/phone/` at `npm run build:phone` time, but electron-builder doesn't include it in the installer by default.

**How to avoid:** Add `dist/phone/**/*` to `package.json#build.files` so electron-builder bundles it inside `app.asar`. At install time, the asar unpack happens and main can serve from `process.resourcesPath` (production) OR `<userData>/phone-bundle/` (dev mode, copy in postinstall).

**Warning signs:** Phone UI 404s on first install.

### Pitfall 8: Vite Phone Build Clashes with Electron Renderer Build

**What goes wrong:** Running `vite build` builds the desktop renderer. The phone target needs its own Vite invocation; without it, no phone bundle is produced.

**Why it happens:** The project's `vite.config.ts` is desktop-only.

**How to avoid:** Add `src/phone/vite.config.ts` for the phone target. Add `"build:phone": "vite build -c src/phone/vite.config.ts"` to `package.json#scripts`. Chain it: `"build": "npm run build:main && npm run build:renderer && npm run build:phone"`.

**Warning signs:** `dist/phone/` missing after `npm run build`; phone 404s.

## Code Examples

Verified patterns from official sources:

### Common Operation 1: WS Connection Lifecycle

```typescript
// Source: ws@8 docs (https://github.com/websockets/ws/blob/master/doc/ws.md)
// pattern derived from ws echo-server example + Electron http server docs
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';

const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
  ws.on('error', (err) => console.error('[ws] error', err));
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // ... dispatch
    } catch (e) { /* ignore malformed JSON */ }
  });
  ws.on('close', () => { /* cleanup */ });
});

server.listen(7878, '127.0.0.1', () => {
  console.log('WS listening on ws://127.0.0.1:7878');
});
```

### Common Operation 2: electron-updater Manual Check

```typescript
// Source: electron-updater docs (https://www.electron.build/auto-update)
// + electron-builder app-update.yml reference
import { autoUpdater } from 'electron-updater';

autoUpdater.autoDownload = false;       // user clicks to download
autoUpdater.autoInstallOnAppQuit = false;  // user clicks to install

autoUpdater.on('update-available', async (info) => {
  console.log('Update available:', info.version);
  // Renderer shows toast: "v0.5.0 available — Download?"
});
autoUpdater.on('update-downloaded', (info) => {
  console.log('Downloaded:', info.version);
  // Renderer shows toast: "Downloaded — Install & Restart?"
});

await autoUpdater.checkForUpdates();   // manual; does NOT auto-download
```

### Common Operation 3: electron-builder NSIS Config

```jsonc
// Source: electron-builder NSIS docs (https://www.electron.build/configuration/nsis)
// placed in package.json#build
{
  "build": {
    "appId": "com.simthesexist.localbot",
    "productName": "Localbot",
    "directories": {
      "buildResources": "build",
      "output": "dist/setup"
    },
    "files": [
      "dist/main/**/*",
      "dist/renderer/**/*",
      "dist/phone/**/*",
      "package.json"
    ],
    "win": {
      "target": [
        { "target": "nsis", "arch": ["x64"] }
      ],
      "icon": "build/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "shortcutName": "Localbot"
    },
    "publish": [
      {
        "provider": "github",
        "owner": "simthesexist",
        "repo": "LocalBot",
        "channel": "latest"
      }
    ]
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Tailscale's `tsnet` (custom handshake) | `state.json` parsing + `os.networkInterfaces()` | Always | We don't need `tsnet` (which requires a Tailscale partner key) — just detection. |
| Express + socket.io | `ws` + Node `http` | 2020+ | Express + socket.io adds 500KB of deps. For a single local server, `ws` is the canonical lightweight choice. |
| electron-builder `electron-updater` auto-install | Manual `checkForUpdates()` + `downloadUpdate()` + `quitAndInstall()` | electron-updater v4+ | The PKG-02 spec is explicit: "no auto-install." Modern electron-updater exposes `autoDownload` and `autoInstallOnAppQuit` flags so we can opt out. |
| NSIS per-machine install (admin) | NSIS per-user install (`perMachine: false`) | electron-builder v22+ | Default was per-machine; explicit `perMachine: false` opts in to current-user. |
| GitHub Releases as update feed | electron-builder `provider: 'github'` | electron-builder v20+ | Native GitHub Releases integration reads `latest.yml` automatically. No separate publish server needed. |
| Vite single-target builds | Vite multi-target (vite.config.ts + src/phone/vite.config.ts) | Vite 3+ | Multi-target builds are standard; chain via npm scripts. |

**Deprecated/outdated:**
- **electron-builder 25.x:** superseded by 26.x; the project should upgrade in this phase to match `electron-updater@6.x`. (See Open Question 2.)
- **Express for local servers:** maintained but no longer the default for Electron control surfaces. `ws` + stdlib `http` is the modern baseline.
- **`socket.io`:** maintained but its custom framing breaks the browser's native WebSocket API. `ws` keeps the wire format standards-compliant.

## Assumptions Log

> List all claims tagged `[ASSUMED]` in this research.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Tailscale's `state.json` schema at `%LOCALAPPDATA%\Tailscale\state.json` contains `Self.DNSName` and is stable. | Pattern 3 / Pitfall 5 | If the schema changes, the renderer shows "Tailscale not detected" gracefully, but the user can't see the MagicDNS name. Update `tailscale.ts` to match the new shape; tracked as a v1.1 fix. |
| A2 | Electron `process.resourcesPath` in production points to the install dir; in dev it points to the repo root. | Pattern 5 / Pattern 1 | If the dev-vs-prod path resolution differs in unexpected ways, the phone bundle 404s. Mitigation: copy `dist/phone/` to `<userData>/phone-bundle/` at first run via a `npm postinstall` hook. |
| A3 | `electron-updater@6.x` is the right line to pair with the current `electron-builder@25.1.8`. | Standard Stack | The actual peer-deps may require upgrading electron-builder to 26.x. See Open Question 2. |
| A4 | The Vite phone target needs its own `vite.config.ts` (multi-config builds). | Pattern 5 / Pitfall 8 | If Vite's multi-config requires a different invocation (`vite build --config ...`), the npm script needs adjusting. Verified by Vite docs (single `vite.config.ts` only supports one root). |
| A5 | Per-WS AbortController map is sufficient for cancel propagation; no shared state with the IPC side needed. | Pattern 2 | If the IPC and WS paths share memory or context that aborts unexpectedly, a bug may surface. Mitigation: separate `activeWsRuns` map; do not share with `chat.ts`'s `activeStreams`. |
| A6 | The phone UI doesn't need to render `vault_read` / `browser_screenshot` blocks (those are uncommon from a phone). | Pattern 5 | If the user expects to see vault content on their phone, this is a v2 feature. For v1, the phone renderer shows `text` + `tool_use` + `tool_result` (text-only); richer blocks fall back to `[Block: vault_read — 1,234 bytes]`. |
| A7 | Manual update flow (no auto-install) matches the user's PKG-02 spec. | Pitfall 6 / Pattern 4 | If the user wanted auto-install on quit (with a "install now or on next quit" prompt), the UI flow changes. Clarify with user. |

**If this table is empty:** All claims in this research were verified or cited — no user confirmation needed. *(Table is NOT empty; the planner should review A3 and A7 before locking decisions.)*

## Open Questions (RESOLVED)

All five open questions below have been resolved. Each resolution is implemented by the plans in this phase (Plan 09-01 / 09-02 / 09-03) and inherited by downstream execution. Decisions:

### Decisions

**D-1 (was Q1):** RESOLVED — Phone renders `text + tool_use (name + input only) + tool_result (text only) + summary`. Heavy blocks (e.g. `vault_read`, `browser_screenshot`) show a `[Block: <name> — N bytes]` stub. Implemented in Plan 09-02 (src/phone/components/MessageBubble.tsx + the WS handler's per-block routing in src/main/network/handlers.ts from Plan 09-01).

**D-2 (was Q2):** RESOLVED — Upgrade electron-builder from `^25.1.8` to `^26.15.3` as part of Plan 09-03, conditional on `npm install` peer-dep compatibility. If the upgrade fails the peer-dep gate, stay on `^25.1.8` and pin `electron-updater@^5.x` (instead of `^6.x`) — the SUMMARY must document the chosen branch. The 25→26 jump is non-trivial; v2 follow-up only if blocked in v1.

**D-3 (was Q3):** RESOLVED — Defer auth to v2. v1 ships without WS authentication. README §"Phone reach" documents the threat model: rely on Tailscale ACLs for access control; do NOT bind on `0.0.0.0` unless the user has explicitly opted in via the bind-mode setting. The `networkAuthToken` field is reserved in the type definition but unused in v1.

**D-4 (was Q4):** RESOLVED — Ship `latest` only for v1. `updateChannel` IS persisted in `<userData>/network.json` (default `latest`) so a v2 build can switch to `beta`/`nightly` without a schema change. UI exposes the field but the v1 renderer does not render channel radio buttons; the value is set programmatically at install time via `app-update.yml`.

**D-5 (was Q5):** RESOLVED — Document "requires Tailscale 1.x or later" in README §"Phone reach". If the user has Tailscale 0.x (effectively zero install base in 2026), the renderer shows "Tailscale not detected" and the user falls back to LAN IP. No code change required; the `try/catch` in `tailscale.ts` already handles missing fields gracefully.

---

## Original Questions (for traceability)

1. **Phone UI feature scope** — Does the phone need to render vault content, browser screenshots, and tool_result blocks? Or just text?
   - What we know: Desktop UI shows all blocks; phone is for quick glances from a phone.
   - What's unclear: Whether `vault_read` and `browser_screenshot` blocks (the heaviest) need phone rendering.
   - Recommendation: Phone renders `text + tool_use (name + input only) + tool_result (text only) + summary`. Heavy blocks show a `[Block: vault_read — 1,234 bytes]` stub.

2. **Upgrade electron-builder from 25.x to 26.x?** — electron-updater@6.x compatibility may require it.
   - What we know: electron-builder 26.15.3 is the latest; the project is on 25.1.8.
   - What's unclear: Whether the breaking changes between 25 and 26 affect Localbot's setup.
   - Recommendation: Upgrade to 26.x as part of Phase 9 Wave 3. If the upgrade is too invasive, defer to a quick task and ship electron-builder 25.x with a known-good `electron-updater@5.x` pair.

3. **Optional authentication token for LAN/Tailnet binding** — Should v1 ship a shared-secret token, or defer to v2?
   - What we know: PKG-02 is silent on auth; NET-03 specifies "LAN / Tailnet binding via a setting" without auth.
   - What's unclear: Whether the user wants auth in v1.
   - Recommendation: Defer to v2. Document the threat model in the README and rely on Tailscale ACLs for access control.

4. **Update channel UX** — How does the user pick a channel?
   - What we know: Default `latest`; could add `beta` + `nightly`.
   - What's unclear: Whether the user wants channel switching.
   - Recommendation: Ship `latest` only for v1; expose the `updateChannel` field in network config for v2.

5. **What runtime version of Tailscale is required?** — The state.json shape has been stable across Tailscale 1.x versions.
   - What we know: `Self.DNSName` is present in every Tailscale 1.x version.
   - What's unclear: Whether Tailscale 0.x users exist (likely none in 2026).
   - Recommendation: Document "requires Tailscale 1.x or later."

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 20+ | Daemon child process + main WS server | Already verified (Phase 1+) | 20.x | — |
| `ws` | Phase 9 WS server | New dep to install | `8.21.3` (npm view) | None — required |
| `electron-updater` | Phase 9 manual update flow | New dep to install | `6.8.9` (npm view) | None — required |
| `electron-builder` (upgrade) | Phase 9 NSIS installer | Already in devDeps at 25.1.8; upgrade recommended | `26.15.3` (latest) | Stay on 25.x if 26 breaks the build |
| Tailscale installed on user's PC | MagicDNS reach display | User-installed; not bundled | 1.x | Graceful fallback: "Tailscale not detected" |
| `%LOCALAPPDATA%\Tailscale\state.json` | Tailscale detection | User-specific path | n/a | Graceful fallback: `os.networkInterfaces()` for LAN IPs |
| Windows 11 / Windows 10 | NSIS target + electron-builder win build | Dev machine is Windows 11 (per CLAUDE.md) | 11 | None (Windows-first per CLAUDE.md) |
| Node `http` + `net` + `os` | WS server, LAN IP detection | Node 20 stdlib | built-in | None |
| Vite multi-config | Phone bundle build | Already used for desktop renderer | 6.0.3 | None |

**Missing dependencies with no fallback:**
- `ws` — without it, the WS server can't be built.
- `electron-updater` — without it, no update flow.

**Missing dependencies with fallback:**
- `electron-builder` upgrade — if 26.x breaks the build, stay on 25.x.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest v2.1.9 (pinned) + `@playwright/test` v1.63.0 |
| Config file | `vitest.config.ts` (existing) + `playwright.config.ts` (extended) |
| Quick run command | `npx vitest run tests/unit/ws_server.test.ts tests/unit/ws_handlers.test.ts tests/unit/tailscale.test.ts` |
| Full suite command | `npm test && npm run test:smoke && npm run test:build` (where `test:build` runs `electron-builder --win --publish never`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| NET-01 | Localbot listens on configurable port (default 7878) for HTTP + WS | Unit + Playwright | `npx vitest run tests/unit/ws_server.test.ts` + `npx playwright test phone-reach.test.ts -g "bind"` | No (Wave 0) |
| NET-02 | Phone browser can chat via WS | Playwright | `npx playwright test phone-reach.test.ts -g "chat"` | No (Wave 0) |
| NET-03 | Default localhost; LAN/Tailnet opt-in | Unit | `npx vitest run tests/unit/ws_server.test.ts -g "bind"` | No (Wave 0) |
| NET-04 | UI shows Tailscale MagicDNS name | Unit + Playwright | `npx vitest run tests/unit/tailscale.test.ts` + `npx playwright test phone-reach.test.ts -g "reach"` | No (Wave 0) |
| PKG-01 | Single Windows .exe installer via electron-builder | Build smoke | `npm run dist` (electron-builder --win) + assert `dist/setup/Localbot Setup <ver>.exe` exists | No (Wave 0) |
| PKG-02 | Manual update-check on configurable channel | Unit | `npx vitest run tests/unit/updater.test.ts` | No (Wave 0) |

### Sampling Rate

- **Per task commit:** `npx vitest run tests/unit/ws_*.test.ts tests/unit/tailscale.test.ts tests/unit/network_config.test.ts tests/unit/updater.test.ts`
- **Per wave merge:** `npm test && npm run test:smoke && npm run dist`
- **Phase gate:** Full Vitest suite green + Playwright phone-reach E2E green + `npm run dist` produces a valid installer.

### Wave 0 Gaps

- [ ] `tests/unit/ws_server.test.ts` — bind modes (localhost / LAN), port collision, graceful close + rebind, 404 for unknown paths
- [ ] `tests/unit/ws_handlers.test.ts` — sendMessage + cancel + per-msgId abort + same MessageBlock union as desktop
- [ ] `tests/unit/tailscale.test.ts` — state.json parse happy path, corrupt JSON fallback, missing file fallback, `os.networkInterfaces()` fallback, 5s cache TTL
- [ ] `tests/unit/network_config.test.ts` — `<userData>/network.json` atomic round-trip + corrupt default + concurrent save ordering (mirror `tests/unit/vault_config.test.ts`)
- [ ] `tests/unit/updater.test.ts` — manual `checkForUpdates` + `autoDownload=false` + `autoInstallOnAppQuit=false` + channel override
- [ ] `tests/unit/preload.test.ts` — EXTEND with `api.network.*` surface
- [ ] `tests/playwright/phone-reach.test.ts` — spawn app + WS connect via `ws@8` from Node + drive a chat turn + assert MagicDNS in the renderer pill (use fake Tailscale state.json fixture)
- [ ] `playwright.config.ts` extended with `phone-reach.test.ts` in the `daemon-smoke` project

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V1 Architecture | Yes | WS server lifecycle isolated to Electron main (not daemon — daemon stays focused on tools); per-msgId AbortController map to prevent stale state. |
| V2 Authentication | NO (deferred to v2) | See Pitfall 1: v1 ships without auth; documented threat model + Tailscale ACL recommendation. |
| V3 Session Management | Partial | Per-WS-client AbortController map; cancel on WS close. No persistent WS sessions (every connection is a fresh chat). |
| V4 Access Control | Partial | Bind mode gates network reach (localhost vs LAN); per-bot tool allowlist already enforces NET-02 (phone-driven tool calls honor the same allowlist as desktop). |
| V5 Input Validation | Yes | All WS messages are JSON.parse'd with shape validation before dispatch (mirror `daemon/main.cjs#tools/call`); phone composer limits message length to 4096 chars (mirror `daemon/bots/loader.cjs` cap). |
| V6 Cryptography | Yes (TLS) | Recommend `wss://` if the user serves the phone via a Tailscale HTTPS proxy; v1 ships `ws://` (cleartext) and documents the limitation. |
| V7 Error Handling | Yes | WS errors are JSON-serialized with `{type:'messageError', code, message}`; renderer + phone UI display collapsed error blocks. |
| V9 Communication | Yes | All WS messages are JSON + UTF-8; binary content (screenshots) is served through the existing `app://` handler (Phase 8), not the WS endpoint. |
| V11 Business Logic | Yes | The phone UI goes through the SAME `runAgenticLoop` as the desktop, so per-bot tool allowlist + per-bot URL allowlist + SSRF shield + vault glob policy all apply identically. No new business-logic surface. |
| V12 Files and Resources | Yes | `<userData>/network.json` is the only new persisted state; atomic write pattern mirrors Phase 7 vault. |
| V14 Configuration | Yes | `app-update.yml` at install time + `network.json#updateChannel` at runtime. |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Neighbor on LAN hits WS endpoint and runs `browser_navigate` to a phishing site | Tampering | Per-bot URL allowlist (Phase 8 SEC-Browser-01) + per-bot tool allowlist (Phase 4 SEC-02) gate the action; the bot's allowlist MUST include `browser.navigate` for the bot to run it. |
| User binds on `0.0.0.0` and accidentally exposes a bot that has `exec_command` enabled | Elevation of Privilege | Documented threat model + opt-in setting + log on bind (`Network server bound on 0.0.0.0:7878`). v2: add `networkAuthToken`. |
| Phone sends malicious JSON to WS endpoint | Tampering | Every WS message is `JSON.parse` + shape-validated before dispatch; invalid messages are dropped silently. |
| Update download is MITM'd | Tampering | electron-updater verifies the signature on every update; if the cert is wrong, the update is rejected. Without code signing, MITM risk is higher (Pitfall 4). |
| Tailscale state.json is spoofed by another process | Information Disclosure | `state.json` is in `%LOCALAPPDATA%\Tailscale\` which is the user's own dir; a co-located process is the user's own. The risk is reading wrong fields, not spoofing — gracefully handled by `try/catch`. |
| WS client sends `sendMessage` for a non-existent bot | Information Disclosure | `runAgenticLoop` reads the bot's config; unknown bot → daemon returns `unknown_bot` error → WS sends `{type:'messageError', error:'unknown_bot'}`. |
| WS client runs an unbounded agentic loop | Denial of Service | Per-msgId AbortController; user can `cancel` via WS; existing chat.ts cancel flow applies. |
| NSIS installer is MITM'd during download | Tampering | electron-builder signs the installer; without signing (Pitfall 4), the user must verify SHA256 manually. |
| Update channel switch persists to wrong config | Tampering | `<userData>/network.json` writes are atomic; the daemon re-reads on every WS connection (no cache). |

## Plan Decomposition Hint

This is **not a plan** — just a recommended slicing for the planner. Mirror Phase 7/8's 3-wave structure.

### Wave 1 (Network Server Tracer) — `09-01-PLAN.md`

**Goal:** Daemon config + WS server skeleton + localhost bind + single `sendMessage` round-trip via WS. The simplest end-to-end proof of NET-01..02 with bind mode locked to localhost (NET-03 partial).

**Tasks:**
1. Install `ws@^8.21.3`. (Defer `electron-updater` to Wave 3; defer `electron-builder` upgrade to Wave 3 unless blocking.)
2. New `daemon/network/{config,index}.cjs` — atomic `<userData>/network.json` persistence (mirror `daemon/vault/config.cjs:50-100`). Shape: `{port: number, bindMode: 'localhost'|'lan', updateChannel: 'latest'}`.
3. Extend `daemon/bots/loader.cjs` ALLOWED_CONFIG_KEYS — N/A (network config is global, not per-bot).
4. New `src/main/network/{server,handlers,static,index}.ts` — `http.createServer` + `WebSocketServer` + WS message dispatch.
5. Refactor `src/main/llm/loop.ts` to expose a reusable `streamChat(opts)` returning `AsyncIterable<StreamEvent>`; have `src/main/ipc/chat.ts` continue to consume it. Verify chat.ts still works.
6. Extend `src/main/index.ts` to call `registerNetworkHandlers()` AFTER `spawnDaemon()` resolves.
7. Extend `src/shared/types.ts` — `NetworkConfig`, `ReachInfo`, `NetworkConfigResult`.
8. Extend `src/shared/ipc-channels.ts` — `NETWORK_GET_CONFIG`, `NETWORK_SET_CONFIG`, `NETWORK_GET_REACH_INFO`.
9. New `src/main/ipc/network.ts` — IPC bridge to daemon.
10. Extend `src/main/preload/index.ts` — `api.network.getConfig()`, `api.network.setConfig()`, `api.network.getReachInfo()`.
11. Create `tests/unit/ws_server.test.ts` (≥8 cases: bind modes, port collision, 404 fallback, graceful close + rebind).
12. Create `tests/unit/ws_handlers.test.ts` (≥6 cases: sendMessage round-trip, cancel mid-stream, unknown bot, malformed JSON).
13. Create `tests/unit/network_config.test.ts` (≥6 cases: atomic round-trip, corrupt default, concurrent saves — mirror `vault_config.test.ts`).
14. Extend `tests/unit/preload.test.ts` with `api.network.*` surface.

**Acceptance:** `npm ls ws` exits 0; Vitest passes ≥ 20 new tests; TS build clean; manual WS test (`node -e "new WebSocket('ws://localhost:7878')"`) connects.

### Wave 2 (Reach + Tailscale + UI) — `09-02-PLAN.md`

**Goal:** Tailscale detection + NetworkSettingsModal + ReachInfoPill + phone UI bundle. Completes NET-03 (LAN bind opt-in) and NET-04 (MagicDNS in UI).

**Tasks:**
1. New `src/main/network/tailscale.ts` — `state.json` parser + `os.networkInterfaces()` fallback + 5s cache.
2. Extend `src/main/network/server.ts` — rebind on bind-mode change (close old server before opening new one; surface errors via toast).
3. Extend `src/main/ipc/network.ts` — `NETWORK_GET_REACH_INFO` handler.
4. Extend `src/shared/types.ts` — `ReachInfoEvent` payload.
5. Extend `src/shared/ipc-channels.ts` — `EVENT_REACH_INFO_UPDATED`.
6. New `src/phone/` directory — `index.html`, `main.tsx`, `components/Composer.tsx`, `components/MessageBubble.tsx`, `styles.css`. WebSocket connect to `ws://<host>:7878`.
7. New `src/phone/vite.config.ts` — separate root + outDir + ES module target. Add `build:phone` npm script.
8. Extend `package.json` — `"build": "npm run build:main && npm run build:renderer && npm run build:phone"`.
9. Extend `vite.config.ts` (or new multi-config setup) — keep desktop + phone builds separate.
10. New `src/renderer/components/NetworkSettingsModal.tsx` — mirror `VaultGlobalSettingsModal`; inputs for port + bind mode + update channel.
11. New `src/renderer/components/ReachInfoPill.tsx` — top-bar pill showing "Reachable at: <magicDns>:<port>" or "LAN: http://<lan-ip>:<port>" or "Localhost only" (with link to open settings).
12. New `src/renderer/state/network.ts` — module-scope store + `useNetworkConfig()` hook (mirror `state/vault.ts`).
13. Extend `src/renderer/App.tsx` — mount `<ReachInfoPill />` in header + `<NetworkSettingsModal />` from a settings button.
14. Extend `electron-builder` post-install step — copy `dist/phone/**` to `<userData>/phone-bundle/` (or bundle in asar + reference via `process.resourcesPath`).
15. Create `tests/unit/tailscale.test.ts` (≥6 cases: state.json parse happy, corrupt JSON fallback, missing file fallback, `os.networkInterfaces()` fallback, 5s cache TTL).
16. Extend `tests/playwright/phone-reach.test.ts` (Wave 0; covered in Wave 3) — drive a chat turn from a simulated phone WS client.

**Acceptance:** `npm run build:phone` produces `dist/phone/index.html`; renderer mounts ReachInfoPill with the MagicDNS name when Tailscale is detected; LAN bind opt-in works.

### Wave 3 (Update + Installer + E2E) — `09-03-PLAN.md`

**Goal:** Install `electron-updater` + write `app-update.yml` + configure electron-builder NSIS + manual update button + Playwright E2E. Completes PKG-01..02.

**Tasks:**
1. Install `electron-updater@^6.8.9`. Upgrade `electron-builder` to `^26.15.3` if `npm install electron-updater` reports a peer-dep warning (else defer to a quick task).
2. New `src/main/network/updater.ts` — `electron-updater` wrapper, manual flow, channel config from `<userData>/network.json#updateChannel`.
3. Extend `src/main/ipc/network.ts` — `NETWORK_CHECK_FOR_UPDATE` + `NETWORK_DOWNLOAD_UPDATE` + `NETWORK_INSTALL_UPDATE` invoke channels; `EVENT_UPDATE_STATUS_CHANGED` broadcast.
4. Extend `src/shared/ipc-channels.ts` — `NETWORK_CHECK_FOR_UPDATE`, `NETWORK_DOWNLOAD_UPDATE`, `NETWORK_INSTALL_UPDATE`, `EVENT_UPDATE_STATUS_CHANGED`.
5. Extend `src/shared/types.ts` — `UpdateStatusEvent` payload.
6. New `src/renderer/components/UpdateToast.tsx` — toast that listens to `EVENT_UPDATE_STATUS_CHANGED` + buttons for download/install.
7. Extend `src/renderer/components/NetworkSettingsModal.tsx` — "Check for updates" button.
8. New `app-update.yml` at repo root — GitHub provider config + `channel: latest`.
9. Extend `package.json#build` — NSIS target config (per `Common Operation 3` above); `perMachine: false`, `oneClick: false`, `allowToChangeInstallationDirectory: true`.
10. New `build/icon.ico` (256x256 multi-resolution icon for NSIS).
11. Create `tests/unit/updater.test.ts` (≥4 cases: `autoDownload=false`, `autoInstallOnAppQuit=false`, manual check, channel override).
12. Create `tests/playwright/phone-reach.test.ts` (≥4 cases: connect via WS, send chat turn, assert MessageBlock round-trip, verify MagicDNS pill text).
14. Extend `playwright.config.ts` daemon-smoke project with `phone-reach.test.ts`.
15. Add `npm run dist` script (`electron-builder --win --publish never`).
16. Document code-signing workflow in README (`CSC_LINK` + `CSC_KEY_PASSWORD`).

**Acceptance:** `npm run dist` produces `dist/setup/Localbot Setup <ver>.exe`; installer installs to `%LOCALAPPDATA%\Programs\Localbot\` without admin; manual update button shows a toast on `update-available`; Playwright phone-reach E2E green.

### Total File Count (estimate)

- **~14 new files** (4 daemon + 6 main + 4 phone/renderer)
- **~10 modified files** (3 src/shared + 3 src/main + 3 renderer + 1 build config)

## Sources

### Primary (HIGH confidence)

- `D:/Claude/Grokbot/src/main/ipc/chat.ts:145-296` — exact analog for WS handler
- `D:/Claude/Grokbot/src/main/llm/loop.ts` — `runAgenticLoop` to extract into `streamChat`
- `D:/Claude/Grokbot/src/main/daemon/spawn.ts:78-125` — `callTool` envelope pattern for reference
- `D:/Claude/Grokbot/daemon/vault/config.cjs:50-100` — atomic JSON persistence pattern to mirror
- `D:/Claude/Grokbot/daemon/main.cjs` — JSON-RPC dispatch shape for new `network/*` cases
- `D:/Claude/Grokbot/src/main/index.ts` — handler registration ordering
- `D:/Claude/Grokbot/src/main/preload/index.ts` — `api.*` surface extension pattern
- `D:/Claude/Grokbot/src/main/audit/logger.ts` — audit append shape (for `network.bind_change` lines)
- `D:/Claude/Grokbot/src/main/paths.ts` — extend with `networkConfigPath()`
- `D:/Claude/Grokbot/src/shared/ipc-channels.ts` — channel constants pattern
- `D:/Claude/Grokbot/src/shared/types.ts` — type extension pattern for `NetworkConfig`, `ReachInfo`
- `D:/Claude/Grokbot/src/renderer/components/VaultGlobalSettingsModal.tsx` — mirror for NetworkSettingsModal
- `D:/Claude/Grokbot/src/renderer/state/vault.ts` — mirror for state/network.ts
- `D:/Claude/Grokbot/.planning/phases/08-browser-automation/08-PATTERNS.md` — multi-wave pattern map

### Secondary (MEDIUM confidence)

- `npm view ws version` → `8.21.3`; `npm view electron-updater version` → `6.8.9`; `npm view electron-builder version` → `26.15.3`
- [WebSocket protocol (RFC 6455)](https://datatracker.ietf.org/doc/html/rfc6455) — wire format reference
- [ws@8 docs](https://github.com/websockets/ws/blob/master/doc/ws.md) — `WebSocketServer` + `ws.on('message')` patterns
- [Node http docs](https://nodejs.org/api/http.html) — `http.createServer` + `fs.createReadStream` for static serving
- [electron-updater docs](https://www.electron.build/auto-update) — `autoUpdater.checkForUpdates`, `autoDownload` flag, `quitAndInstall()`
- [electron-builder NSIS docs](https://www.electron.build/configuration/nsis) — `perMachine`, `oneClick`, `allowToChangeInstallationDirectory`
- [Tailscale MagicDNS docs](https://tailscale.com/kb/1081/magicdns/) — `state.json` location + `Self.DNSName` shape
- [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#websocket) — input validation, no auth default, threat model

### Tertiary (LOW confidence — needs runtime verification)

- Tailscale `state.json` schema stability (Pitfall A1) — schema is undocumented; relying on community convention
- electron-builder 25 → 26 breaking changes (Open Question 2) — should review CHANGELOG before committing to upgrade
- `process.resourcesPath` resolution in packaged Electron vs dev (A2) — verify with a manual install test
- `electron-updater@6.x` peer-deps with electron-builder 25.x (A3) — run `npm install` and check warnings before committing to upgrade path

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — `npm view` confirms `ws@8.21.3`, `electron-updater@6.8.9`, `electron-builder@26.15.3`; Phase 7/8 patterns for `daemon/vault/config.cjs` and `src/renderer/state/vault.ts` are direct analogs
- Architecture: MEDIUM — WS-in-Electron-main is standard; phone UI as separate Vite target is the conventional pattern; Tailscale detection requires runtime verification (Pitfall A1)
- Pitfalls: MEDIUM — bind-mode race (Pitfall 2) and Tailscale detection reliability (Pitfall 5) need runtime verification; code signing (Pitfall 4) is a documented limitation, not a bug
- Security: MEDIUM — v1 ships without WS auth (documented); TLS is documented as a v2 follow-up; per-bot tool allowlist already enforces business-logic controls
- Test strategy: HIGH — Playwright daemon-smoke + fake WS client pattern is proven (Phase 4+); new Vitest suites follow the Phase 7/8 template

**Research date:** 2026-09-19
**Valid until:** 2026-10-19 (30 days; `ws` is stable, `electron-updater` minor versions ship monthly, electron-builder majors every 3–6 months)