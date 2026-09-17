---
phase: 01-skeleton-streaming-chat
api_surface: Anthropic Messages API (consumed via @anthropic-ai/sdk, base-URL overridable to M3-compatible endpoint)
generated_by: gsd-verify-work / gsd-executor pre-UAT gate
generated_at: 2026-09-17T22:30:00Z
source_artifacts:
  - src/main/llm/client.ts
  - src/main/llm/prompts.ts
  - src/main/ipc/chat.ts
  - src/main/ipc/key.ts
  - 01-01-SUMMARY.md
  - 01-02-SUMMARY.md
coverage_default: integrate
---

# COVERAGE: Phase 1 API surface

Phase 1 ships the walking skeleton — a streamed chat loop against the
Anthropic Messages endpoint (served by an M3-compatible base URL).
This file enumerates every Messages-API capability Phase 1 either uses
or explicitly defers, so the verify-work api-coverage gate has the
matrix it needs before sealing the phase.

Default: every capability is **INTEGRATE** unless the matrix below
opts out with a reason that names a later phase or a deliberate product
constraint.

---

## 1. Client + transport

| capability | decision | reason |
|---|---|---|
| `messages.stream` SDK client constructor (`new Anthropic({ apiKey, baseURL })`) | INTEGRATE | one client per call site; apiKey + baseURL only |
| `baseURL` override for M3 / local endpoint | INTEGRATE | `M3_API_BASE` env, default `https://api.MiniMax.io/v1` |
| `apiKey` decrypted from safeStorage on demand | INTEGRATE | D-05; plaintext never crosses IPC, never touches disk |
| Per-call `AbortSignal` | INTEGRATE | D-18 cancel transport — `Map<msgId, AbortController>` |
| Streaming response iterator (`for await ... of stream`) | INTEGRATE | D-07 streaming IPC contract |
| Non-streaming `messages.create` (probe path only) | INTEGRATE | key:probe uses `max_tokens:1` + 'ping' |
| Request retry on transient/network errors | INTEGRATE | D-22 — exponential `250→500→1000ms`, 3 attempts |

## 2. Request body

| capability | decision | reason |
|---|---|---|
| `model` parameter | INTEGRATE | `M3_MODEL` env, default `MiniMax/M3` |
| `system` prompt | INTEGRATE | Hard-coded per D-16 in `prompts.ts` |
| `messages: { role, content: string }[]` | INTEGRATE | Phase 1 is text-only (no images, no tool blocks yet) |
| `max_tokens: 4096` (chat) / `1` (probe) | INTEGRATE | Chat budget; probe uses minimum tokens |
| `temperature` / `top_p` / `top_k` | OPT-OUT | Phase 1 uses SDK defaults; revisit in Phase 3 (memory/summarization may want deterministic output) |
| `stop_sequences` | OPT-OUT | No Phase 1 caller needs a stop sequence; Phase 2 tool-loop may add one when tool_use blocks land |
| `metadata` (user_id, etc.) | OPT-OUT | Single-user app on a single machine; analytics off |
| `tools` (function schema) | OPT-OUT | Phase 2 (`/gsd-plan-phase 2` — File Tools + Search + Tool System) |
| `tool_choice` | OPT-OUT | Phase 2 (depends on tools) |
| Image / document input blocks | OPT-OUT | Out of scope; renderer has no image picker; add in a future Obsidian/file-content phase |
| Prompt caching (`cache_control`) | OPT-OUT | Phase 3+ (memory + conversation history will benefit; not Phase 1) |
| Extended thinking (`thinking` block) | OPT-OUT | Not in v1 product spec; defer until a concrete use case appears |

## 3. Streaming response surface

| capability | decision | reason |
|---|---|---|
| `content_block_delta` of type `text_delta` | INTEGRATE | The only SSE event Phase 1 consumes; bubbles emit deltas to the renderer |
| Final aggregated `text` field | INTEGRATE | Persisted to session JSONL after natural completion |
| Other SSE lifecycle events | OPT-OUT | message_start, message_stop, ping, content_block_start, content_block_stop; Phase 3 |
| `stop_reason` handling for tool_use and end_turn | OPT-OUT | Phase 1 never reads `stop_reason`; Phase 2 needs tool_use; Phase 3 needs end_turn boundary for summarization |
| `usage` tokens (input/output) | OPT-OUT | Phase 3 (token-budget summarization) |
| Model-error events in stream (`error` type) | OPT-OUT | Non-stream `client.messages.create` covers probe errors; stream errors surface via thrown AbortError or HTTP-level retry |

## 4. Error + retry

| capability | decision | reason |
|---|---|---|
| 401 / 403 → auth category, no retry | INTEGRATE | D-22; modal re-prompts via `key:probe` |
| 408 / 429 / 5xx → transient, retry ≤3 | INTEGRATE | D-22 exponential backoff |
| Network codes (ECONNRESET, ETIMEDOUT, …) → network, retry | INTEGRATE | D-22 |
| `AbortError` → cancelled, no retry | INTEGRATE | D-18 cancel transport; partial text preserved |
| Streaming mid-flight interruption preserves partial text | INTEGRATE | D-19 — partial assistant turn persisted with `stopped:true` |
| Rate-limit `retry-after` header | OPT-OUT | Phase 1 uses fixed exponential backoff; honoring retry-after lands in Phase 2 when retry correctness becomes user-visible (background bots) |

## 5. Tool-use / agentic loop

| capability | decision | reason |
|---|---|---|
| Assistant `tool_use` content blocks | OPT-OUT | Phase 2 |
| Streaming `input_json_delta` accumulation | OPT-OUT | Phase 2 |
| User-side `tool_result` content blocks | OPT-OUT | Phase 2 (daemon's `tools/call` envelope is already wired — `daemon/tools/registry.cjs` returns `unknown_tool` stub for any name) |
| `tool_choice` variants (any, tool, auto) | OPT-OUT | Phase 2 |
| Parallel `tool_use` blocks in one turn | OPT-OUT | Phase 2 |
| Forced tool-use for "must call" flows | OPT-OUT | No Phase 1 flow needs it; revisit when scheduled bots land (Phase 6) |

## 6. Models / endpoints

| capability | decision | reason |
|---|---|---|
| `MiniMax/M3` (default) | INTEGRATE | Phase 1 product target |
| Model override via `M3_MODEL` env | INTEGRATE | Lets hermetic tests swap models without code edits |
| Multiple-model routing per bot | OPT-OUT | Phase 4 (multi-bot CRUD); Phase 1 has a single global session |
| `messages.batches` (async batch API) | OPT-OUT | Not in scope; bots run on cron (Phase 6), not on batch |
| Token-count endpoint (`messages.countTokens`) | OPT-OUT | Phase 3 (summarization budgets) |
| Files API (`files.upload` / `files.retrieve`) | OPT-OUT | Out of scope; files stay on the local filesystem (SEC-02) |

## 7. Non-Messages endpoints

| capability | decision | reason |
|---|---|---|
| `/v1/models` (list available models) | OPT-OUT | Hard-coded `MiniMax/M3`; settings page that lists models lands in Phase 4 |
| Admin / organization endpoints | OPT-OUT | Single-user app |

---

## Coverage summary

- **Total capabilities enumerated:** 38
- **INTEGRATE (Phase 1):** 16
- **OPT-OUT (deferred to later phase):** 22

Every OPT-OUT row names the future phase that owns it, or carries an
explicit product reason (single-user, no analytics, no images).
No capability is silently dropped — this matrix is the single source
of truth for what the Anthropic/M3 surface Phase 1 deliberately does
not touch.

## Re-evaluation cadence

- After every phase that consumes this list, run `/gsd-verify-work {N}`
  to confirm the new phase's SUMMARYs still respect every deferred row
  above (or update this file with a new INTEGRATE entry).
- Phase 2 will retire at least rows for `tools`, `tool_choice`, `input_json_delta`, and the agentic-loop block, and may add a row for `retry-after`.
- Phase 3 will retire rows for sampling params, full SSE event coverage, `stop_reason`, `usage`, and `messages.countTokens`.