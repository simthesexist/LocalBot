# Phase 1, Plan 01-02 — Test Infrastructure Summary

**Date:** 2026-09-17
**Phase:** 01-skeleton-streaming-chat
**Plan:** 01-02 (Test infrastructure: Vitest unit suites + Playwright smoke)

## Outcome

Both tasks completed in two atomic commits. Phase 1 now ships with the
locked test surface (D-29..D-32): three Vitest suites covering the small
pure modules, one Playwright daemon smoke that proves SEC-04 end-to-end,
and one Playwright Electron smoke that drives the real built app against
an in-process fake M3.

## What Landed

### Task 1 — Vitest unit suites (21 passing assertions)

- **vitest 2.1.9** added to `devDependencies`. Pinned to v2 because vitest
  v5 dropped Node 20 from its `peerOptional @types/node` range and would
  have forced a `@types/node` bump outside this plan's scope.
- **vitest.config.ts**: pure-Node environment; `include: ['tests/unit/**']`;
  excludes the Playwright tree. Inline-deps `electron` so per-test
  `vi.mock('electron', ...)` factories actually take effect (vitest's
  dep optimizer otherwise caches the real electron CJS entry which throws
  outside an Electron runtime).
- **`src/main/keychain.ts`** (new): extracted `encryptToFile(path, plaintext)`
  and `decryptFromFile(path)` from `src/main/ipc/key.ts` plus a typed
  `KeychainError`. The pure module has no ipcMain coupling, so unit tests
  import it directly without instantiating IPC handlers.
- **`src/main/ipc/key.ts`**: refactored to delegate to `keychain.ts`;
  `KeychainError` surfaces as `{ ok: false, error }` in the IPC reply.
- **`src/main/paths.ts`**: `userDataDir()` honors `LOCALBOT_USER_DATA_DIR`
  env var when set (default still falls back to `app.getPath('userData')`).
  This unblocks both the unit suites and the Playwright daemon smoke
  without touching production behavior.
- **`tests/unit/ndjson.test.ts`** (8 cases): writeMessage emits a
  single-line `\n`-terminated JSON frame (spy on a fake Writable);
  readMessage parses valid JSON, returns null on malformed input,
  rejects lines > 1 MiB per T-01-03; two JSON-RPC error envelopes
  (-32700 / -32600) round-trip cleanly; unicode + nested-array
  key-ordering round-trip; real `fs.WriteStream` round-trip.
- **`tests/unit/session.test.ts`** (7 cases): loadSession returns `[]`
  for missing file; appendMessage → loadSession round-trips role/content;
  two-message sequence with non-decreasing ts; full D-13 schema
  (ts/role/content + optional stopped/interrupted) round-trip;
  trailing-newline repair on read; malformed lines skipped without
  throwing. Uses `fs.mkdtempSync` for per-test isolation; mocks electron
  to a stub `app.getPath`.
- **`tests/unit/safeStorage.test.ts`** (6 cases): vi.mock('electron')
  shim where encryptString prepends 'enc:' and decryptString throws on
  bad-magic. Covers full round-trip, empty-string round-trip, missing
  file returns null, wrong-magic ciphertext throws `KeychainError`,
  ciphertext never contains plaintext, multiple encrypt/decrypt cycles
  against the same path are stable.
- **`tests/unit/safeStorage.real.test.ts`**: skipped under plain `npm
  test`; enabled via `ELECTRON_REAL_SAFESTORAGE=1` and launching vitest
  under `electron` so `require('electron')` resolves to the real module.
  Lives in a separate file because colocating a `vi.unmock` body with
  the shim caused vitest's mock registry to reset even for the non-real
  tests.

`npm test` runs all 21 assertions in under 1 second on Windows.

### Task 2 — Playwright smoke (daemon passes; Electron gated on display)

- **`@playwright/test@1.63.0`** added to `devDependencies`.
- **`playwright.config.ts`**: single project, `testDir: 'tests/playwright'`,
  60 s timeout, 1 worker, no webServer (each test spawns its own deps),
  `trace: 'retain-on-failure'`.
- **`tests/setup/file-url.ts`**: `fileURLForCwd()` + `tempUserData()` —
  per-test `mkdtempSync` under `os.tmpdir()` so each smoke run isolates
  its user-data + audit tree.
- **`tests/playwright/fake-m3-server.ts`**: in-process HTTP server bound
  to `127.0.0.1:0`. Replays the canonical Anthropic SSE envelope
  (`message_start` → `content_block_delta` → `content_block_stop` →
  `message_stop`) so the real `@anthropic-ai/sdk` parses the response
  without modification. The probe path (max_tokens:1 + `ping` content)
  replies with a one-token "ok" response.
- **`tests/playwright/daemon.test.ts`**: pure-Node test (no Electron).
  Spawns `process.execPath` with `daemon/main.cjs` and env
  `LOCALBOT_USER_DATA_DIR=<tmp>`. Awaits the `{kind:'ready'}` handshake,
  sends `initialize` (asserts `result.server === 'localbot-daemon'`),
  sends `tools/call { name: 'echo', arguments: {hello:'world'} }`, asserts
  the `unknown_tool` error envelope. Then reads back
  `<tmp>/audit/<UTC-day>.jsonl` and asserts the canonical D-12 line
  shape: `{ ts, bot:'daemon', tool:'echo', params:{hello:'world'},
  outcome:'error', durationMs, error:{ code:'unknown_tool', ... } }`.
  Passes in <500ms.
- **`tests/playwright/smoke.test.ts`**: full Electron launch against the
  built `dist/main/main/index.js` with `M3_API_BASE=<fakeM3>`,
  `LOCALBOT_USER_DATA_DIR=<tmp>`, `M3_MODEL='MiniMax/M3'`,
  `ELECTRON_DISABLE_SANDBOX=1`. First-launch key modal flow: paste key,
  click probe, wait for "OK", click save, wait for modal unmount. Then
  type into `[data-testid="composer-input"]`, click
  `[data-testid="send-button"]`, wait for an assistant bubble containing
  "Hello" from the fake M3. Gated behind `LOCALBOT_SMOKE_OK` env so the
  headed run is opt-in on CI machines without a display.
- **`.gitignore`**: ignore `test-results/`, `playwright-report/`,
  `playwright/.cache/`, `coverage/`.

`npx playwright test tests/playwright/daemon.test.ts` passes the audit
assertion in 458 ms. The headed `smoke.test.ts` is skipped in this
environment but its file structure, selectors, and wiring all match the
plan's acceptance criteria (the grep checks all return ≥1).

## Files Created / Modified

```
.gitignore
package-lock.json
package.json
playwright.config.ts
src/main/ipc/key.ts          (refactored to delegate to keychain.ts)
src/main/keychain.ts         (new — extracted safeStorage helpers)
src/main/paths.ts            (LOCALBOT_USER_DATA_DIR support)
tests/setup/file-url.ts
tests/playwright/fake-m3-server.ts
tests/playwright/smoke.test.ts
tests/playwright/daemon.test.ts
tests/unit/ndjson.test.ts
tests/unit/safeStorage.test.ts
tests/unit/safeStorage.real.test.ts
tests/unit/session.test.ts
vitest.config.ts
```

## Acceptance Criteria — Verified

Task 1:
- `vitest.config.ts` contains `include: ['tests/unit/**/*.test.ts']` and the
  `deps.inline` / `deps.optimizer` entries that make `vi.mock('electron')`
  effective.
- `tests/unit/ndjson.test.ts` imports from `daemon/protocol.cjs` (via
  `createRequire(import.meta.url)`) and runs 8 cases — round-trip,
  malformed, oversized, JSON-RPC error envelopes, unicode, real file
  stream.
- `tests/unit/session.test.ts` uses `fs.mkdtempSync` for per-test
  isolation and asserts `loadSession()` returns `[]` for a missing file.
- `tests/unit/safeStorage.test.ts` uses `vi.mock('electron', ...)` with
  the enc:/bad-magic shim and round-trips a key through
  encrypt/decrypt.
- `npm test` → 3 test files passed, 21 tests passed, 1 skipped (the real
  electron test gated on env var). Zero failures.
- `package.json` adds `vitest` to `devDependencies` and the `test`,
  `test:watch`, `test:smoke`, `test:all` scripts.

Task 2:
- `playwright.config.ts` exists and sets `testDir: 'tests/playwright'`.
- `tests/playwright/fake-m3-server.ts` exports `createFakeM3Server()`
  returning `{ url, port, close, getRequestCount }`, bound to
  `127.0.0.1:0`.
- `tests/playwright/smoke.test.ts` references both `M3_API_BASE` and the
  fake M3 helper (proof the renderer route is isolated from real
  `MiniMax.io`).
- `tests/playwright/daemon.test.ts` spawns `process.execPath` with the
  daemon entry as the first arg and asserts the `unknown_tool` error
  code in the JSON-RPC response.
- `tests/playwright/daemon.test.ts` reads the audit JSONL file under
  `LOCALBOT_USER_DATA_DIR` and asserts at least one line with the
  canonical D-12 shape (`tool='echo'`, `bot='daemon'`,
  `outcome='error'`, `error.code='unknown_tool'`).
- `@playwright/test` listed in `devDependencies`; `test:smoke` script
  present.

## Key Architectural Anchors (Locked)

| Decision | Where | Why it matters |
|---|---|---|
| D-29 Vitest unit tests | `tests/unit/{ndjson,session,safeStorage}.test.ts` | Locked contract coverage for the pure modules; <60s |
| D-30 Playwright smoke | `tests/playwright/{smoke,daemon}.test.ts` | E2E coverage: real Electron + real daemon against fake M3 |
| D-31 Hermetic M3 | `tests/playwright/fake-m3-server.ts` | `127.0.0.1:0` binding, no real network calls |
| D-32 Vitest + Playwright | `package.json devDependencies` | No node-gyp, no native modules, pre-built only |

## Constraints Honored

- No `node-gyp`, no `electron-rebuild`, no compile-on-install.
- Tests are hermetic: in-process fake M3 server, per-test `mkdtempSync`
  user-data dirs.
- `M3_API_BASE` env override points the Electron app at the fake M3.
- `LOCALBOT_USER_DATA_DIR` env override isolates the audit JSONL tree
  per smoke run.
- Vitest pinned to v2 because vitest v5 requires Node 22+ types; v2
  still receives patches and works under Node 20/24.

## Deviations

- **Vitest v2 instead of v5.** Vitest 5 dropped `@types/node ^20` from
  its `peerOptional` range; the project is on `@types/node ^20.11.0`.
  Vitest 2.x is the latest series that still satisfies the project's
  existing type pin and was installed in 5 seconds with no peer-dep
  warning. No behavior regression for the locked D-32 toolset.
- **`safeStorage.real.test.ts` lives in its own file.** Putting
  `describe.skipIf(...)` with `vi.unmock('electron')` in the same file
  as the shim caused vitest's mock registry to reset for the non-real
  tests even though the describe block was skipped. Splitting the real
  test into its own file keeps the shim active for the mocked suite.
  The CI opt-in via `ELECTRON_REAL_SAFESTORAGE=1` still works.
- **Vitest config `deps.inline` + `deps.optimizer` entries added.**
  Required to force vitest to bypass the electron dep-pre-bundle so
  per-test `vi.mock('electron')` factories take effect. Documented in
  the config file's header comment.
- **`LOCALBOT_USER_DATA_DIR` added to `src/main/paths.ts`.** Required
  for unit tests and the daemon smoke to point paths at per-test temp
  dirs without instantiating Electron's app. Production behavior
  unchanged when the env var is absent.
- **smoke.test.ts gated by `LOCALBOT_SMOKE_OK`.** The headed Electron
  run requires a display; this environment has none. The test file
  structure, env wiring, and assertions are all in place and the
  daemon smoke (which proves SEC-04 end-to-end) runs green.

## Combined Runtime

- `npm test`: <1 second (21 passing assertions + 1 skipped).
- `npx playwright test tests/playwright/daemon.test.ts`: ~500 ms.
- Combined `npm test && npm run test:smoke`: well under 30 seconds on
  this developer machine, satisfying the plan's <120 s budget.

## Next Steps

- Plan 01-03 — extend the smoke surface to cover retry/respawn paths and
  add Playwright coverage for the cancel UX (D-17..D-20).
- Phase 2 — bot CRUD + first five file tools (read_file, write_file,
  edit_file, list_dir, code_search) plug into the locked
  `tools/call` envelope via `daemon/tools/registry.cjs`.
