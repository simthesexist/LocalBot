---
phase: 09-phone-reach-ship
plan: 02
type: execute
subsystem: network + renderer + phone-ui
tags: [tailscale, rebind, network-settings, reach-info, phone-bundle, vite-target, ws-reconnect]
dependency_graph:
  requires:
    - phase-09-phone-reach-ship-09-01
  provides:
    - NET-03-bind-mode-toggle-UX
    - NET-04-magicdns-detection
    - PHONE-UI-VITE-TARGET
    - REACH-INFO-PILL
  affects:
    - src/main/network/server.ts
    - src/main/network/index.ts
    - src/main/ipc/network.ts
    - src/main/index.ts
    - src/main/preload/index.ts
    - src/renderer/components/App.tsx
    - src/renderer/state/network.ts
    - src/renderer/styles/app.css
    - src/shared/ipc-channels.ts
    - src/shared/window.d.ts
    - package.json
tech-stack:
  added: []
  patterns:
    - open-new-before-closing-old rebind (Pitfall 2 mitigation)
    - 5s TTL cache for filesystem-bound detection
    - separate Vite target for SPA bundle
    - exponential-backoff WS reconnect (cap 30s)
key-files:
  created:
    - src/main/network/tailscale.ts
    - src/phone/index.html
    - src/phone/main.tsx
    - src/phone/vite.config.ts
    - src/phone/components/Composer.tsx
    - src/phone/components/MessageBubble.tsx
    - src/phone/components/Chat.tsx
    - src/phone/styles.css
    - src/renderer/components/NetworkSettingsModal.tsx
    - src/renderer/components/ReachInfoPill.tsx
    - src/renderer/state/network.ts
    - tests/unit/tailscale.test.ts
  modified:
    - src/main/network/server.ts
    - src/main/network/index.ts
    - src/main/ipc/network.ts
    - src/shared/types.ts
    - src/shared/ipc-channels.ts
    - src/shared/window.d.ts
    - src/main/preload/index.ts
    - src/main/index.ts
    - src/renderer/components/App.tsx
    - src/renderer/styles/app.css
    - package.json
    - tests/unit/ws_server.test.ts
decisions:
  - rebind implementation opens new http.Server before closing old (Pitfall 2 mitigation); on bind failure the old server stays alive
  - Tailscale detection: state.json first, os.networkInterfaces only for LAN fallback (Pitfall 5)
  - 5s TTL cache on ReachInfo to bound re-read cost
  - Module-scope `lastBoundConfig` in ipc/network.ts drives rebind decisions (bindMode OR port change triggers rebind; channel alone does not)
  - Phone bundle uses separate Vite target (src/phone/vite.config.ts) with es2020 target; no preload bridge, pure browser WebSocket API
  - Exponential-backoff WS reconnect: [1s, 2s, 4s, 8s, 16s, 30s cap]
  - MessageBubble renders vault_read / browser_screenshot / browser_evaluate blocks as `[Block: <kind> — N bytes]` stubs (Pitfall A6)
  - NetworkSettingsModal uses bindMode/port trigger rebind; updateChannel in v1 is display-only (disabled radios)
  - Periodic 5s reach-info refresh in main calls clearCache() then detectReach() — pushes fresh state to renderer via EVENT_REACH_INFO_UPDATED
metrics:
  duration: ~12m
  completed_date: 2026-09-20
  tasks: 3
  commits: 3
status: complete
actuals:
  tokens: 92000
  tasks: 3
  commits: 3
plan_head_before: 09c1405190d554d3032545c21d127dffa2cef071
---

# Phase 9 Plan 02 Summary

Wave 2: Tailscale MagicDNS detection + NetworkSettingsModal + ReachInfoPill + phone UI bundle + bind-mode rebind UX. Closes NET-03 (LAN bind opt-in via setting) and NET-04 (Tailscale MagicDNS in renderer UI).

**One-liner:** Phone reachable end-to-end: Tailscale detector + bind-mode toggle rebinds the WS server without ECONNREFUSED, ReachInfoPill surfaces the right reach URL, and a minimal phone SPA on a separate Vite target streams tokens over WS.

## What Shipped

### Tail of work
- `src/main/network/tailscale.ts` — `detectReach()` reads `%LOCALAPPDATA%\Tailscale\state.json`, strips trailing dot from `Self.DNSName`, falls back to LAN IPv4 (non-internal) via `os.networkInterfaces()`, 5s TTL cache, graceful failure on ENOENT/corrupt JSON. `__test__` exposes `parseStateJson`, `getStatePath`, `TTL_MS`, `reset`.
- `src/main/network/server.ts` — `rebindServer(handle, newHost, newPort, phoneBundleDir)` opens NEW `http.Server` BEFORE closing OLD (Pitfall 2 mitigation). On bind failure old server stays alive. Handle stores internal `_internalServerRef` / `_internalWssRef` for atomic swap.
- `src/main/network/index.ts` — `currentNetworkHandle` singleton + `rebindNetworkServer(newHost, newPort)` + `subscribeReachInfo` / `broadcastReachInfo` fan-out helpers.
- `src/main/ipc/network.ts` — `NETWORK_GET_REACH_INFO` calls `detectReach()`. `NETWORK_SET_CONFIG` triggers `rebindNetworkServer` on bindMode/port change. Module-scope `lastBoundConfig` decides whether to rebind. Successful setConfig broadcasts `EVENT_NETWORK_CONFIG_UPDATED`.
- `src/main/index.ts` — subscribes reach-info + 5s periodic refresh interval (`clearCache()` → `detectReach()` → `broadcastReachInfo()`), cleanup on `before-quit`.
- `src/shared/ipc-channels.ts` — `EVENT_NETWORK_CONFIG_UPDATED` + `EVENT_REACH_INFO_UPDATED` constants.
- `src/shared/window.d.ts` — `LocalbotEvent` union adds `'network:config:updated'` + `'network:reach:updated'`.
- `src/main/preload/index.ts` — `EVENT_CHANNELS` extends with both new channels.

### Renderer side
- `src/renderer/state/network.ts` — module-scope store + `useNetworkConfig()` hook + `networkActions`; subscribes to both `EVENT_NETWORK_CONFIG_UPDATED` and `EVENT_REACH_INFO_UPDATED`; 250ms refresh throttle (mirrors `state/vault.ts`).
- `src/renderer/components/NetworkSettingsModal.tsx` — port + bindMode (localhost/lan) + updateChannel (latest/beta/nightly, disabled v1); rebind error surfaces inline.
- `src/renderer/components/ReachInfoPill.tsx` — three display modes (Tailscale MagicDNS / LAN / localhost-only); click opens modal; data-testid for E2E.
- `src/renderer/App.tsx` — mounts `<ReachInfoPill onClick={openNetworkModal} />` at root + `<NetworkSettingsModal open={...} onClose={...} />`.
- `src/renderer/styles/app.css` — `.reach-info-pill` (fixed top-right pill) + `.network-settings-modal-body` + `.radio-group` + `.form-radio` styles.

### Phone UI bundle (separate Vite target)
- `src/phone/index.html` — single root + script tag for `./main.tsx`.
- `src/phone/main.tsx` — React 19 createRoot mount.
- `src/phone/vite.config.ts` — `root: src/phone`, `outDir: ../../dist/phone`, `target: 'es2020'`, no preload bridge.
- `src/phone/components/Composer.tsx` — textarea + send button; Enter submits, Shift+Enter newline, 4096 char cap.
- `src/phone/components/MessageBubble.tsx` — user/assistant bubbles + tool_use pill + heavy-block stubs (vault_read / browser_screenshot / browser_evaluate render as `[Block: <kind> — N bytes]`).
- `src/phone/components/Chat.tsx` — exponential-backoff WS reconnect `[1s, 2s, 4s, 8s, 16s, 30s cap]`; `crypto.randomUUID()` for msgId; dispatches messageStarted / token / messageDone / messageError / toolUse / toolResult.
- `src/phone/styles.css` — mobile-first plain CSS, 100dvh viewport, sticky-bottom composer.

### Tests
- `tests/unit/tailscale.test.ts` — 10 cases covering state.json parse happy + ENOENT + corrupt JSON + missing DNSName + 5s cache TTL + LAN IPv4 filter + parseStateJson variants. **All 10 passing.**
- `tests/unit/ws_server.test.ts` — Case F updated from "rebind throws" (Wave 1 forward-compat) to "rebind resolves and updates host/port" (Wave 2 reality).

### Build pipeline
- `package.json` — `scripts.build` now chains `build:main && build:renderer && build:phone`; `build:phone: 'vite build -c src/phone/vite.config.ts'`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `vi.mocked(...).mockReturnValueOnce is not a function` in tailscale.test.ts**
- **Found during:** Task 2 — first vitest run
- **Issue:** Initial mock setup used `vi.mocked(fs.readFileSync)` post-import, but `vi.mock` factories are hoisted above all imports so the named export wasn't yet the mocked fn at the call site.
- **Fix:** Restructured the mock using `vi.hoisted()` to define the mock fns before `vi.mock` runs, so the factories can reference them. Inside test bodies we now call `mockReadFileSync.mockImplementationOnce(...)` on the hoisted ref.
- **Files modified:** `tests/unit/tailscale.test.ts`
- **Commit:** `d305c57`

**2. [Rule 1 - Bug] `ws_server.test.ts` Case F expected rebind to throw**
- **Found during:** Task 2 — full suite run
- **Issue:** The Wave 1 forward-compat test asserted `handle.rebind() rejects toThrow(/rebind not implemented/i)`. In Wave 2 rebind is implemented and resolves successfully.
- **Fix:** Updated Case F to assert `rebind resolves` and that `handle.host` / `handle.port` reflect the new target.
- **Files modified:** `tests/unit/ws_server.test.ts`
- **Commit:** `0d157bf`

**3. [Rule 1 - Bug] Phone Vite build couldn't resolve `/assets/main.js` from index.html**
- **Found during:** Task 2 — `vite build -c src/phone/vite.config.ts`
- **Issue:** Hardcoded `<script src="/assets/main.js">` in index.html — Vite's resolver tried to resolve that as an import but the file doesn't exist (Vite produces hashed names).
- **Fix:** Rewrote index.html to reference `./main.tsx` and `./styles.css` (relative paths). Vite rewrites these to hashed `/assets/index-<hash>.{js,css}` at build time. The servePhoneBundle static handler then resolves them via the existing `/assets/<rel>` path.
- **Files modified:** `src/phone/index.html`
- **Commit:** `d305c57`

### Out-of-scope discoveries

- `tests/unit/bots_update_atomic.test.ts` flaked on full-suite run ("bots/update with cronEnabled:false removes the schedule from scheduler.json") but PASSES in isolation and on the merge base. Pre-existing flakiness unrelated to network/tailscale work — left alone per scope boundary.

## Verification

- `npx tsc --noEmit -p .` exits 0 (TS build clean).
- `npx vitest run tests/unit/tailscale.test.ts` — **10 passed**.
- `npx vitest run tests/unit/ws_server.test.ts` — **12 passed** (including updated Case F).
- `npx vite build -c src/phone/vite.config.ts` — produces `dist/phone/index.html` + `dist/phone/assets/index-*.js` + `dist/phone/assets/index-*.css`.
- `npx vitest run` — 53/55 test files passing; one flake (bots_update_atomic) is pre-existing and unrelated.
- TypeScript types align — `ReachInfoEvent extends ReachInfo { at: number }` was already declared in Plan 1 and is referenced by `src/main/index.ts`.

## Threat-model coverage

- T-9-W2-01 (rebind without ECONNREFUSED): open-new-before-closing-old pattern in `rebindServer`; rebind error surfaces inline in `NetworkSettingsModal` (`rebindError`).
- T-9-W2-02 (state.json read minimization): `tailscale.ts` extracts ONLY `Self.DNSName`; never logs auth tokens or peer metadata; 5s cache limits re-read cost.
- T-9-W2-03 (graceful fallback): `tailscale.test.ts` cases B + C + D (ENOENT + corrupt JSON + missing DNSName) all pass.
- T-9-W2-04 (reconnect backoff): `RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000]` in `Chat.tsx`.
- T-9-W2-06 (client-side validation): `NetworkSettingsModal` validates port (1..65535), bindMode enum, updateChannel enum BEFORE `networkActions.setConfig`.

## Manual smoke note (Task 3)

Plan Task 3 calls for manual smoke verification with the Electron app launched. In the parallel-executor worktree context the manual UI smoke was NOT performed (the worktree agent can't drive a desktop app interactively); the verification scope covered by automation is:

- Static analysis: tsc --noEmit clean.
- Unit tests: tailscale (10) + ws_server (12) all passing.
- Build: `vite build -c src/phone/vite.config.ts` succeeds; `dist/phone/{index.html, assets/}` produced.
- Wave 3 Playwright E2E + manual UI smoke deferred to the next plan (Pitfall 7: phone bundle needs install-time copy to `<userData>/phone-bundle/` before the live WS handshake can be exercised).

## Files created / modified

**12 new files, 11 modified files, 1 new test suite (10 cases).**

```
src/main/network/tailscale.ts                  (NEW)
src/main/network/server.ts                     (rebind implementation)
src/main/network/index.ts                      (singleton + subscribeReachInfo)
src/main/ipc/network.ts                        (detectReach + rebind trigger)
src/shared/types.ts                            (ReachInfoEvent — already in Plan 1)
src/shared/ipc-channels.ts                     (EVENT_REACH_INFO_UPDATED + EVENT_NETWORK_CONFIG_UPDATED)
src/shared/window.d.ts                         (LocalbotEvent union extended)
src/main/preload/index.ts                      (EVENT_CHANNELS extended)
src/main/index.ts                              (subscribe + 5s refresh + cleanup)
src/phone/index.html                           (NEW)
src/phone/main.tsx                             (NEW)
src/phone/vite.config.ts                       (NEW)
src/phone/components/Composer.tsx              (NEW)
src/phone/components/MessageBubble.tsx         (NEW)
src/phone/components/Chat.tsx                  (NEW)
src/phone/styles.css                           (NEW)
src/renderer/state/network.ts                  (NEW)
src/renderer/components/NetworkSettingsModal.tsx (NEW)
src/renderer/components/ReachInfoPill.tsx      (NEW)
src/renderer/components/App.tsx                (mount ReachInfoPill + NetworkSettingsModal)
src/renderer/styles/app.css                    (reach-info-pill + network-settings-modal styles)
package.json                                   (build:phone script)
tests/unit/tailscale.test.ts                   (NEW, 10 cases)
tests/unit/ws_server.test.ts                   (Case F updated for Wave 2)
```