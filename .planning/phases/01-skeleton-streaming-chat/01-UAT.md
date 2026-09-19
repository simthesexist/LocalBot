---
status: testing
phase: 01-skeleton-streaming-chat
source: [01-01-SUMMARY.md, 01-02-SUMMARY.md, 01-VERIFICATION.md]
started: 2026-09-17T22:20:00Z
updated: 2026-09-17T22:20:00Z
---

## Current Test

number: 1
name: Headed Electron smoke (full launch + key modal + streamed token against fake M3)
expected: |
  Run `LOCALBOT_SMOKE_OK=1 npx playwright test tests/playwright/smoke.test.ts` on a Windows machine with a display. The test boots the in-process fake M3 server, launches the built Electron app, completes the key-modal flow against the fake server, types "say hello", and asserts an assistant bubble containing "Hello" becomes visible.
awaiting: user response

## Tests

### 1. Headed Electron smoke (full launch + key modal + streamed token against fake M3)
expected: Test passes in under 30s. The fake M3 server receives at least one POST /v1/messages request (`m3.getRequestCount() > 0`). After the test, the temp `userData` directory contains a `sessions/global.jsonl` file and a `audit/<UTC-day>.jsonl` line.
result: [pending]

### 2. Real safeStorage round-trip (real OS keychain via Electron)
expected: Run `ELECTRON_REAL_SAFESTORAGE=1 ELECTRON_RUN_AS_NODE=1 npx electron node_modules/vitest/vitest.mjs run tests/unit/safeStorage.real.test.ts`. Test passes — proving Windows DPAPI (or the host's OS keychain) can store and retrieve the ciphertext written under `app.getPath('userData')/api-key.bin`.
result: [pending]

### 3. Manual full-stack smoke against the real M3 endpoint
expected: Launch the app with `npm start` (after `npm run build`). Verify the first-launch modal appears, paste a fake key, click "Test connection" against the real M3 endpoint, save, type a message, and watch tokens stream back into an assistant bubble. Then close the window and inspect `~/.config/Localbot` (or `%APPDATA%/Localbot` on Windows) for `sessions/global.jsonl` and `audit/<UTC-day>.jsonl`. Streaming works end-to-end; a session line and an audit line land on disk per turn.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0

## Gaps

[none yet]
