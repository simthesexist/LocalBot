---
phase: 09-phone-reach-ship
plan: 01
subsystem: network-control-plane
tags: [electron, websocket, ws, http, ipc, network-config, tracer]
provides:
  - "HTTP+WS control plane bound on configurable port (default 7878, localhost-only by default)"
  - "WebSocket sendMessage envelope routed through the SAME runAgenticLoop that desktop chat.ts uses"
  - "Per-msgId AbortController map mirroring chat.ts cancel semantics (cancel + WS close abort)"
  - "Audit-minimized WS lifecycle row: {event, host, port} only — no message content, no bot persona"
  - "Atomic <userData>/network.json persistence via daemon/network/config.cjs (tmp+rename + persistQueue)"
  - "Static phone-bundle server with path-traversal guard (path.normalize containment BEFORE fs.existsSync)"
affects: [phase-09-phone-reach-ship, phase-08-browser-automation]
actuals:
  tokens: 88000
  tasks: 2
  commits: 3
tech-stack:
  added: [ws@^8.21.3]
  patterns: [http-then-ws-on-same-port, per-msgId-abortcontroller-map, audit-minimization, atomic-tmp-rename-with-persistqueue, path-normalize-containment-before-fs]
key-files:
  created:
    - daemon/network/config.cjs
    - src/main/network/server.ts
    - src/main/network/handlers.ts
    - src/main/network/static.ts
    - src/main/network/index.ts
    - src/main/ipc/network.ts
    - tests/unit/ws_server.test.ts
    - tests/unit/ws_handlers.test.ts
    - tests/unit/network_config.test.ts
  modified:
    - package.json
    - package-lock.json
    - daemon/main.cjs
    - src/main/index.ts
    - src/main/paths.ts
    - src/main/preload/index.ts
    - src/shared/types.ts
    - src/shared/ipc-channels.ts
    - src/shared/window.d.ts
    - tests/unit/preload.test.ts
key-decisions:
  - "createRequire(__filename) multi-path probe resolves daemon/network/config.cjs from both source-relative and dist-relative layouts (vitest + tsc-dist)"
  - "fire-and-forget dispatchWsMessage inside wss.on('connection') — WS lifetime decoupled from per-message handlers so a stuck client cannot block the upgrade loop"
  - "static.ts stream error handler + server.ts wss.on('error', noop) + bind-error cleanup — added during Task 2 test runs to prevent uncaught ENOENTs and zombie-port leaks"
  - "port=0 ephemeral-port pattern (30000+random*10000) instead of port=0 in tests — loadNetworkConfig isValidShape rejects port=0; production port range lets bindMode='lan' be exercised deterministically"
  - "Defensive msg.bot default to 'default' when omitted — mirrors chat.ts L155 typeof check"
duration: ~38min
completed: 2026-09-20
status: complete
---

# Phase 9 Plan 1: Phone Reach — Wave 1 Tracer Slice Summary

**Localhost-only HTTP+WS control surface proven inside Electron main; phone chat cycle IS the desktop chat cycle (NET-01 + NET-02 invariants).**

## Performance

- **Duration:** ~38 minutes (incl. test stability iteration)
- **Tasks:** 2 of 2 complete
- **Files modified:** 19 total (9 NEW, 10 MODIFIED)
- **Tests:** 49 NEW passing across 4 suites (target was ≥20; far exceeded)
- **Commits:** 3 (`feat` for Task 1, `test` for Task 2, `fix` for test-stability hardening discovered during Task 2)

## Accomplishments

- **NET-01 PROVEN:** `startNetworkServer({phoneBundleDir})` binds http.createServer + WebSocketServer on the same port; default 127.0.0.1:7878 with bindMode=='lan' widening to 0.0.0.0. `ws@^8.21.3` installed as runtime dep (no native compile — pure-JS).
- **NET-02 PROVEN:** `dispatchWsMessage` reuses the SAME `runAgenticLoop` (src/main/llm/loop.ts) that src/main/ipc/chat.ts uses; per-msgId AbortController map (`activeWsRuns`) mirrors chat.ts activeStreams; cancel frame aborts the in-flight run; WS close iterates the map and aborts every active controller.
- **Audit minimization (T-9-04):** the lifecycle row for `network.bind` carries ONLY `{event:'network.bind', host, port}`. The `ws.send_message` row carries ONLY `{action, bot, msgId, durationMs, outcome}` (no message content, never bot persona text, never token deltas).
- **Atomic config (T-9-03):** `daemon/network/config.cjs` mirrors `daemon/vault/config.cjs` verbatim — tmp+rename, persistQueue serialization, corrupt JSON returns defensive default `{port:7878, bindMode:'localhost', updateChannel:'latest'}`. Concurrent saves serialize; shape drift rejects with `{code:'invalid_network_config'}`.
- **Path-traversal guard (T-9-02):** `servePhoneBundle` computes `safeJoin(rootDir, relPath)` BEFORE `fs.existsSync`; any path that doesn't satisfy `full === normalizedRoot || full.startsWith(normalizedRoot + sep)` returns 403. Covers `/`, `/index.html`, `/assets/<safe>`; 404 for everything else.
- **Client-side shape validation (T-9-06):** `NETWORK_SET_CONFIG` validates `{port integer in [1,65535], bindMode ∈ {localhost,lan}, updateChannel ∈ {latest,beta,nightly}}` BEFORE `callBot`, returning `{ok:false, error:'invalid_network_config'}` for inline renderer feedback.
- **IPC bridge:** 3 channels wired (`NETWORK_GET_CONFIG`, `NETWORK_SET_CONFIG`, `NETWORK_GET_REACH_INFO`) — ReachInfo is a Wave 1 placeholder returning `{tailscale:false, lanIps:[]}`; Wave 2 wires Tailscale detection.
- **App lifecycle wiring:** `registerNetworkHandlers()` invoked AFTER `registerBrowserHandlers()` (pure IPC registration, no I/O); `startNetworkServer` fires inside a fire-and-forget async IIFE AFTER `void spawnDaemon()` resolves; `app.on('before-quit')` closes the network handle BEFORE `stopDaemon`.

## Task Commits

1. **Task 1: WS control surface + daemon config + IPC bridge + shared types** - `ea77240`
   - `feat(phase-9-01): WS control surface inside Electron main`
2. **Task 2: 4 test suites — ws_server, ws_handlers, network_config, preload extension** - `4711e5c`
   - `test(phase-9-01): ws_server + ws_handlers + network_config + preload extension (49 passing cases)`
3. **Deviation fix: harden network surface for clean test shutdown + ws error containment** - `6d9c941`
   - `fix(phase-9-01): harden network surface for clean test shutdown + ws error containment`

## Files Created/Modified

### Created (NEW)

- `daemon/network/config.cjs` (132 lines) — atomic `<userData>/network.json` persistence; exports `loadNetworkConfig`, `saveNetworkConfig`, `networkConfigPath`, `defaultNetworkConfig`, `__test__`. Shape `{port:1..65535, bindMode:'localhost'|'lan', updateChannel:'latest'|'beta'|'nightly'}`.
- `src/main/network/server.ts` (~165 lines) — `startNetworkServer({phoneBundleDir})` returns `NetworkServerHandle {host, port, close, rebind}`; rebind throws in Wave 1 (forward-compat for Wave 2). Multi-path `createRequire` probe resolves daemon/network/config.cjs from both source and dist layouts.
- `src/main/network/handlers.ts` (~250 lines) — `dispatchWsMessage(ws, req)`; module-scope `activeWsRuns = new Map<msgId, AbortController>()`; shape validation (type=='sendMessage', msgId non-empty, content 1..4096 chars, bot optional non-empty); routes through `runAgenticLoop` mirroring chat.ts L178-188 system-prompt construction.
- `src/main/network/static.ts` (~135 lines) — `servePhoneBundle(req, res, rootDir)`; path-traversal guard via `safeJoin` (path.normalize containment BEFORE fs.existsSync); Content-Type map for html/js/mjs/css/svg/png/jpg/ico/json; stream error handler converts ENOENT races into 500s.
- `src/main/network/index.ts` (~25 lines) — barrel re-exports `startNetworkServer`, `dispatchWsMessage`, `servePhoneBundle`, `registerNetworkHandlers`.
- `src/main/ipc/network.ts` (~110 lines) — `registerNetworkHandlers()` registers 3 IPC channels; client-side shape validation BEFORE `callBot`; ReachInfo placeholder for Wave 1.
- `tests/unit/ws_server.test.ts` (12 cases) — bind modes 'localhost' and 'lan', port collision via `net.createServer()` blocker, graceful close, rebind stub, static path-traversal guard, asset 200, 404 fallbacks.
- `tests/unit/ws_handlers.test.ts` (9 cases) — sendMessage round-trip, cancel mid-stream via deferred promise, malformed JSON drop, unknown type drop, msgId validation, 4097-char DoS guard, ws.close abort, bot default fallback.
- `tests/unit/network_config.test.ts` (17 cases) — atomic round-trip, shape validation rejects on port/bindMode/updateChannel drift, corrupt JSON defensive default, concurrent saves serialize via persistQueue.

### Modified

- `package.json` + `package-lock.json` — added `ws@^8.21.3` runtime dep; verified `npm ls ws` returns 1 line; no native compile (optionalDeps not pulled).
- `daemon/main.cjs` — added `network` require, `currentNetworkConfig` module-scope mirror, JSON-RPC cases `network/get_config` + `network/set_config` with defensive validation.
- `src/main/index.ts` — imports `registerNetworkHandlers`, `startNetworkServer`, `phoneBundleDir`, `ensurePhoneBundleDir`; `registerNetworkHandlers()` after `registerBrowserHandlers()`; `startNetworkServer` in fire-and-forget IIFE after `spawnDaemon`; `app.on('before-quit')` closes the handle.
- `src/main/paths.ts` — `networkConfigPath()`, `phoneBundleDir()`, `ensurePhoneBundleDir()`.
- `src/main/preload/index.ts` — `api.network = { getConfig, setConfig, getReachInfo }`.
- `src/shared/types.ts` — `NetworkConfig`, `NetworkConfigResult`, `ReachInfo`, `ReachInfoEvent`, `WsSendMessageRequest`, `UpdateStatusEvent` interfaces.
- `src/shared/ipc-channels.ts` — `NETWORK_GET_CONFIG`, `NETWORK_SET_CONFIG`, `NETWORK_GET_REACH_INFO`.
- `src/shared/window.d.ts` — `LocalbotApi.network` namespace.
- `tests/unit/preload.test.ts` — +3 cases for `api.network` surface (getConfig, setConfig, getReachInfo).

## Decisions & Deviations

### Decisions

1. **createRequire multi-path probe**: tsc-compiled dist and source-relative vitest layouts resolve `daemon/network/config.cjs` differently (3 vs 2 segments up from `src/main/network/`). A try-catch sequence over candidate paths is simpler than monkey-packing `__dirname` resolution. Documented in server.ts L58-73.
2. **fire-and-forget `dispatchWsMessage`**: `wss.on('connection', (ws) => void dispatchWsMessage(ws, req))` — awaiting inside the connection handler would block the WS upgrade loop on stuck clients. The handler's own Promise resolves on WS close.
3. **port=0 rejected by `isValidShape`**: tests use ephemeral ports in the production range (`30000 + Math.floor(Math.random() * 10000)`) so `bindMode='lan'` can be exercised without triggering defensive defaults.
4. **Defensive `msg.bot` default**: `(typeof msg.bot === 'string' && msg.bot.length > 0) ? msg.bot : 'default'` mirrors chat.ts L155. Caught by ws_handlers.test.ts Case I during Task 2.

### Auto-fixed Issues (Deviation Rule 1 + 3)

1. **`[Rule 3 - Test stability]` Stream error handler on `fs.createReadStream`**
   - **Found during:** Task 2 ws_server.test.ts static cases
   - **Issue:** `fs.createReadStream(full).pipe(res)` returns immediately; if `fs.rmSync(rootDir)` in afterEach races the in-flight read, ENOENT escapes as uncaught error.
   - **Fix:** Attached `stream.on('error', () => { if (!res.writableEnded) res.writeHead(500).end(); })` on both the index and asset branches.
   - **Files modified:** src/main/network/static.ts
   - **Commit:** 6d9c941

2. **`[Rule 3 - Test stability]` WebSocketServer-level error suppression**
   - **Found during:** Task 2 ws_server.test.ts Case D
   - **Issue:** ws emits 'error' on the WebSocketServer (not the underlying http.Server) for malformed upgrade frames; without a handler, the error escapes uncaught.
   - **Fix:** Added `wss.on('error', () => undefined)` in startNetworkServer.
   - **Files modified:** src/main/network/server.ts
   - **Commit:** 6d9c941

3. **`[Rule 3 - Test stability]` Bind-error path tears down half-bound server**
   - **Found during:** Task 2 ws_server.test.ts Case D (port collision)
   - **Issue:** When `server.listen(port, host)` rejects with EADDRINUSE, the half-bound server stays alive in the test runner's process; subsequent tests in the same worker race for the port.
   - **Fix:** Wrapped the listen await in try/catch that calls `server.close()` + `wss.close()` before re-throwing.
   - **Files modified:** src/main/network/server.ts
   - **Commit:** 6d9c941

4. **`[Rule 3 - Test stability]` Port collision test refactored to use net blocker**
   - **Found during:** Task 2 ws_server.test.ts Case D
   - **Issue:** Running TWO `startNetworkServer` calls in the same test leaked wss/server instances across tests; the second server's promise resolution was tied to the first server's WebSocketServer somehow.
   - **Fix:** Replaced with a `net.createServer().listen(ephemeralPort, '127.0.0.1')` blocker that holds the port deterministically; the second `startNetworkServer` then deterministically rejects with EADDRINUSE.
   - **Files modified:** tests/unit/ws_server.test.ts
   - **Commit:** 6d9c941

### Out-of-scope (discovered but deferred)

- `tests/unit/bots_update_atomic.test.ts` has 2 flaky failures when run as part of the full suite (passes in isolation). Unrelated to Phase 9 — pre-existing parallel-test isolation issue. Will be flagged in phase-level verification.

## Next Phase Readiness

**Wave 2 (09-02) is unblocked:**

- `handle.rebind(newHost, newPort)` stub throws in Wave 1; the rebind implementation lands in 09-02 alongside the NetworkSettingsModal UI toggle and ReachInfoPill. The handle shape is forward-compatible.
- `NETWORK_GET_REACH_INFO` IPC channel exists and returns a placeholder `{tailscale:false, lanIps:[]}`; Wave 2 fills the body with Tailscale MagicDNS detection + LAN IP enumeration (`src/main/network/tailscale.ts` per the plan).
- `src/shared/types.ts` already declares `ReachInfo`, `ReachInfoEvent`, `WsSendMessageRequest`, `UpdateStatusEvent` — Wave 2 + 3 fill the payloads.
- `daemon/network/config.cjs` already persists `updateChannel` — Wave 3's `electron-updater` consumes it.

**Wave 3 (09-03) prerequisites in place:**

- `UpdateStatusEvent` interface declared; `electron-updater` IPC channels land in 09-03.
- `daemon/main.cjs` shape validation for `updateChannel ∈ {'latest','beta','nightly'}` already in place.

**Security baseline honored:**

- Localhost-only default (NET-03 v1) preserved; bindMode=='lan' is opt-in via persisted config.
- No WS auth in Wave 1 (Pitfall 1) — documented in the plan's threat model (T-9-08 accepted for v1, mitigated by Tailscale ACL).
- Audit row minimization enforced in code: bind row carries `{event, host, port}` only.

## Verification Status

| Check | Result |
|-------|--------|
| `npm ls ws` exits 0 with 1 line | PASS (ws@8.21.x) |
| `npx tsc --noEmit -p tsconfig.json` exits 0 | PASS |
| 4 vitest suites pass with ≥23 cases | PASS (49/49) |
| `ws_server.test.ts` bind modes proven | PASS (12/12) |
| `ws_handlers.test.ts` sendMessage round-trip + cancel + abort | PASS (9/9) |
| `network_config.test.ts` atomic round-trip + shape validation + concurrent serialization | PASS (17/17) |
| `preload.test.ts` api.network surface | PASS (11/11 incl. 3 new) |
| Pre-existing tests still pass | PARTIAL (2 bots_update_atomic flakes when run as part of full suite; passes in isolation; out of scope) |
