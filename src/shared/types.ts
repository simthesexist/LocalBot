// Shared types between main, preload, and renderer.

import type Anthropic from '@anthropic-ai/sdk';

export type Role = 'user' | 'assistant';

// Phase 3: extended discriminated union. The renderer ignores unknown kinds
// gracefully (MessageBlock falls back to a generic renderer) so adding a
// new kind (like `summary`) does not break older builds.
// Phase 5 Wave 2: shell_stream variant for live stdout/stderr from exec_command.
// Phase 7 Plan 1: vault_read + vault_write variants (vault_search lands in
// Plan 07-02).
// Phase 7 Plan 2: vault_search variant added. VaultReadBlock / VaultSearchBlock
// / VaultWriteBlock render these three inline in MessageBlock dispatch.
export type MessageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'summary'; summary: SummaryRecord }
  | {
      kind: 'shell_stream';
      shellId: string;
      bot: string;
      command: string;
      approvedBy: 'user-once' | 'user-always' | null;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      durationMs: number | null;
      isError: boolean;
      startedAt: number;
    }
  | {
      kind: 'vault_read';
      path: string;
      content: string;
      bytes: number;
      startLine?: number;
      endLine?: number;
      truncated: boolean;
    }
  | {
      kind: 'vault_search';
      query: string;
      matches: Array<{ path: string; line: number; text: string }>;
      truncated: boolean;
    }
  | {
      kind: 'vault_write';
      path: string;
      bytesWritten: number;
    }
  | {
      // Phase 8 Plan 1: browser.navigate result. `url` is normalized
      // hostname + pathname (NO query string per Pitfall 5). The remaining
      // 5 browser_* MessageBlock variants land in Plan 2.
      kind: 'browser_navigate';
      url: string;
      status: number | null;
      title: string;
      text: string;
      bytes: number;
      durationMs: number;
    }
  | {
      // Phase 8 Plan 2: browser.click result. `hostname` + `path` carry
      // page.url() with the query string stripped (Pitfall 5). `text`
      // is the 5KB-clipped innerText of the clicked element; never the
      // raw HTML or any attribute value the agent shouldn't see.
      kind: 'browser_click';
      selector: string;
      hostname: string;
      path: string;
      text: string;
      durationMs: number;
    }
  | {
      // Phase 8 Plan 2: browser.type result. The actual typed text is
      // NEVER included in the audit OR the MessageBlock (Pitfall 5).
      // Only `textBytes` (byte count) is exposed; renderer uses this
      // to show "Typed 12 chars" without leaking the secret.
      kind: 'browser_type';
      selector: string;
      textBytes: number;
      hostname: string;
      path: string;
      submitted: boolean;
      durationMs: number;
    }
  | {
      // Phase 8 Plan 2: browser.screenshot result. PNG bytes are NEVER
      // included in the MessageBlock (Pitfall 5); only the byte count +
      // app:// URI. The renderer fetches the actual image via the app://
      // protocol handler in src/main/ipc/browser.ts.
      kind: 'browser_screenshot';
      filename: string;
      fileUri: string;
      bytes: number;
      hostname: string;
      path: string;
      fullPage: boolean;
      durationMs: number;
    }
  | {
      // Phase 8 Plan 2: browser.evaluate result. The expression source
      // and the raw evaluation result are NEVER included (Pitfall 5).
      // Only byte counts + a truncated string preview for visual
      // rendering. Tool throws {code:'result_too_large'} when the
      // serialized result exceeds 50KB.
      kind: 'browser_evaluate';
      expressionBytes: number;
      resultBytes: number;
      resultPreview: string;
      hostname: string;
      path: string;
      durationMs: number;
    }
  | {
      // Phase 8 Plan 2: browser.fill_form result. Individual field values
      // are NEVER included (Pitfall 5). Only the field count + a
      // human-readable "filled N fields" summary that omits the values.
      kind: 'browser_fill_form';
      fieldCount: number;
      hostname: string;
      path: string;
      submitted: boolean;
      summary: string;
      durationMs: number;
    };

/** Phase 5 Wave 2: pending shell approval request from the daemon. */
export interface ApprovalRequest {
  shellId: string;
  command: string;
  bot: string;
  requestedAt: number;
}

export interface ShellTokenEvent {
  shellId: string;
  stream: 'stdout' | 'stderr';
  line: string;
  ts: number;
}

export interface ShellExitEvent {
  shellId: string;
  exitCode: number;
  durationMs: number;
  isError: boolean;
}

export interface ShellRequestApprovalEvent {
  shellId: string;
  command: string;
  bot: string;
  ts: number;
}

/**
 * Phase 6 Wave 2: emitted by the daemon croner tick when a scheduled run
 * errors AND the bot's `notifyOnError !== false`. Main forwards the event
 * to the renderer (which displays nothing directly) AND constructs an
 * Electron `Notification` toast. Body is sliced to 120 chars at the
 * notification constructor site to minimize disclosure in the toast.
 */
export interface ScheduledErrorEvent {
  bot: string;
  runId: string;
  errorMessage: string;
  ts: string;
}

/**
 * Phase 6 Wave 2: emitted by main when the user clicks the
 * scheduled-error toast. The renderer subscribes and calls
 * `setActiveBotId(botId)` so the chat pane switches to the errored bot.
 */
export interface NavigateToBotEvent {
  botId: string;
}

/**
 * Phase 3: head-of-file summary record. Persisted as the first JSONL row of
 * a session when the token soft-cap triggers summarization.
 */
export interface SummaryRecord {
  summary: string;
  turnsFolded: number;
  ranAt: string;
  msgId: string;
}

export interface FactsPayload {
  value: unknown;
  source: 'user' | 'tool' | 'summary';
  updatedAt: string;
}

export type Facts = Record<string, FactsPayload>;

export interface MemoryPayload {
  markdown: string;
  facts: Facts;
  bytes: number;
  factCount: number;
  updatedAt: string;
  parseError?: string;
}

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: TreeNode[] | null;
  truncated?: boolean;
}

export interface SessionEntry {
  sessionId: string;
  startedAt: string;
  messageCount: number;
  isActive: boolean;
}

export interface ChatMessage {
  ts: number;
  role: Role | 'summary';
  content: string;
  blocks?: MessageBlock[];        // NEW (Phase 2) — back-compat: legacy rows omit it
  stopped?: boolean;
  interrupted?: boolean;
  msgId?: string;
  // Phase 3: head-of-file summary payload (mirrors `summary` row in JSONL).
  summary?: SummaryRecord;
  // Typed carrier for Anthropic-shaped content blocks between streamChat
  // and runAgenticLoop. Used in Phase 2 to thread tool_use / tool_result
  // blocks across multi-turn resumes without `(m as any)` casts. Not
  // serialised to the renderer; not persisted in the JSONL row.
  anthropicBlocks?: Anthropic.Messages.ContentBlock[];
}

export interface SendMessageRequest {
  content: string;
  msgId: string;
  /** Phase 4 Wave 2: per-bot routing. Defaults to 'default' for Phase 3 back-compat. */
  bot?: string;
}

export interface TokenEvent {
  msgId: string;
  delta: string;
}

export interface DoneEvent {
  msgId: string;
}

export interface ErrorEvent {
  msgId: string;
  error: string;
  retryable: boolean;
  category?: 'auth' | 'network' | 'transient' | 'fatal';
}

// Phase 2: new IPC event payloads.
export interface ToolUseEvent {
  msgId: string;
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface ToolResultEvent {
  msgId: string;
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface KeyGetResult {
  hasKey: boolean;
}

export interface KeySetResult {
  ok: boolean;
  error?: string;
}

export interface KeyProbeResult {
  ok: boolean;
  error?: string;
  category?: 'auth' | 'network' | 'transient' | 'fatal';
}

export interface KeyClearResult {
  ok: boolean;
}

export interface AppInitPayload {
  hasKey: boolean;
  messages: ChatMessage[];
  headSummary: SummaryRecord | null;
  /**
   * Phase 4 Wave 1: bot list shipped with the first paint so the renderer's
   * sidebar hydrates synchronously. `bots` defaults to `[]` when the daemon
   * hasn't finished its initialize handshake yet — the renderer's own
   * `useBots().refresh()` reconciles via `EVENT_BOT_LIST_UPDATED` once
   * the daemon reports ready.
   */
  bots?: BotConfig[];
}

export interface DaemonStatus {
  state: 'connecting' | 'ready' | 'down';
  message?: string;
}

export interface AuditLine {
  ts: string;
  bot: string;
  tool: string;
  params: Record<string, unknown>;
  outcome: 'ok' | 'error';
  durationMs: number;
  error?: { code: string; message: string };
  /** Phase 2: Anthropic tool_use_id carried through the audit line. */
  tool_use_id?: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number | string; message: string };
}

// Phase 3: history + memory + tree IPC payloads.

export interface HistoryListRequest {
  bot: string;
}

export interface HistoryLoadRequest {
  bot: string;
  sessionId: string;
}

export interface HistoryLoadResult {
  messages: ChatMessage[];
  headSummary: SummaryRecord | null;
}

export interface MemoryReadRequest {
  bot: string;
}

export interface MemoryReadResult {
  markdown: string;
  facts: Facts;
  bytes: number;
  factCount: number;
  updatedAt: string;
  parseError?: string;
}

export interface TreeListRequest {
  path: string;
  maxDepth?: number;
  maxEntriesPerDir?: number;
  exclude?: string[];
}

export interface TreeListResult {
  entries: TreeNode[];
  truncated: boolean;
}

export interface HistoryAppendedEvent {
  kind: 'message' | 'summary';
  bot: string;
  sessionId: string;
  msgId?: string;
  summary?: SummaryRecord;
  /** Phase 3 Wave 2: emitted true when a mid-flight summary was aborted by
   *  user cancel so the SessionSwitcher dropdown can omit it from the
   *  messageCount delta. */
  aborted?: boolean;
}

export interface TreeRefreshEvent {
  bot: string;
  rootPath: string;
  changedPaths: string[];
}

export interface MemoryUpdatedEvent {
  bot: string;
  factCount: number;
  bytes: number;
  updatedAt: string;
}

export interface HistoryLoadedEvent {
  bot: string;
  sessionId: string;
}

// ─── Phase 4 Wave 1: bot metadata CRUD + sidebar. ─────────────────────────

/**
 * Per-bot lifecycle status. The daemon emits `EVENT_BOT_STATUS` to flip a
 * bot between these states during manual/cron runs. Wave 1 bots are
 * created with status='idle'; Wave 2 introduces the running / cancelled
 * transitions via bots/trigger + bots/cancel.
 */
export type BotStatus = 'idle' | 'running' | 'errored' | 'scheduled';

/**
 * Source of truth for a bot's metadata. Mirrors `<userData>/bots/<id>/config.json`.
 * The renderer treats this as the canonical display record; the daemon
 * treats `allowlist` as the per-bot policy source (SEC-02).
 */
export interface BotConfig {
  id: string;
  name: string;
  persona: string;
  workspace: string;
  allowlist: string[];
  cron?: string;
  cronEnabled?: boolean;
  /**
   * Phase 6: when true (default), the daemon emits a
   * `notification:scheduled-error` event when a cron-fired run errors.
   * Renderer-supplied via the BotSettingsPage Schedule tab.
   */
  notifyOnError?: boolean;
  /**
   * Phase 6: custom prompt injected when the cron fires. Defaults to
   * `'[Scheduled run] Perform your regular check-in.'` at the daemon
   * consumer site. Capped at 4096 chars by `daemon/bots/loader.cjs`.
   */
  scheduledPrompt?: string;
  /**
   * Phase 7 Plan 1: optional per-bot Obsidian vault root override. When
   * non-empty, the daemon uses this path instead of the global
   * `<userData>/vault.json` rootPath. `null` is an explicit "no vault for
   * this bot"; empty/undefined falls back to the global rootPath.
   */
  vaultPath?: string | null;
  /**
   * Phase 7 Plan 1: per-bot vault allowlist (picomatch globs evaluated
   * against vault-relative paths). Empty/undefined blocks reads entirely
   * (Pitfall: never silently allow).
   */
  vaultAllow?: string[];
  /**
   * Phase 7 Plan 1: per-bot vault denylist (picomatch globs). Evaluated
   * AFTER globalDeny but BEFORE vaultAllow (deny-wins pipeline).
   */
  vaultDeny?: string[];
  /**
   * Phase 8 Plan 1: per-bot URL allowlist for browser.navigate +
   * (later) browser.click / browser.type / browser.fill_form. picomatch
   * globs evaluated against the URL pathname. Empty/undefined blocks
   * navigation entirely (default-deny — never silently allow).
   */
  browserAllow?: string[];
  /**
   * Phase 8 Plan 1: per-bot URL denylist. Evaluated AFTER SSRF shield
   * but BEFORE browserAllow (deny-wins pipeline mirrors Phase 7 vault).
   */
  browserDeny?: string[];
  /**
   * Phase 8 Plan 1: opt-out flag for the SSRF shield. When true, RFC1918
   * / 127.0.0.0/8 / 169.254.0.0/16 / IPv6 link-local/ULA/loopback
   * addresses pass through checkBrowserUrl. Used for hermetic E2E + dev.
   */
  ssrfAllowInternal?: boolean;
  createdAt: string;
  updatedAt: string;
  status: BotStatus;
  lastRunAt?: string;
  lastRunExitReason?: 'completed' | 'cancelled' | 'errored';
  lastRunError?: string;
  schemaVersion: 1;
}

export interface BotListResult {
  ok: boolean;
  bots: BotConfig[];
  error?: string;
}

export interface BotCreateRequest {
  id?: string;
  name: string;
  persona: string;
  workspace: string;
  allowlist: string[];
  cron?: string;
  cronEnabled?: boolean;
  /** Phase 6: opt in/out of scheduled-error notifications. */
  notifyOnError?: boolean;
  /** Phase 6: custom prompt injected on cron fire. */
  scheduledPrompt?: string;
}

export interface BotCreateResult {
  ok: boolean;
  bot?: BotConfig;
  error?: string;
}

export interface BotDeleteRequest {
  bot: string;
}

export interface BotDeleteResult {
  ok: boolean;
  error?: string;
}

export interface BotListUpdatedEvent {
  reason: 'create' | 'update' | 'delete';
  bot?: string;
}

export interface BotStatusEvent {
  bot: string;
  status: BotStatus;
  runId?: string;
  ts?: string;
}

// Phase 4 Wave 2: settings edit, manual trigger, cancel, run history.
export interface BotUpdateRequest {
  bot: string;
  patch: Partial<Omit<BotConfig, 'id' | 'createdAt'>>;
}

export interface BotUpdateResult {
  ok: boolean;
  bot?: BotConfig;
  error?: string;
}

export interface BotTriggerRequest {
  bot: string;
  content: string;
}

export interface BotTriggerResult {
  ok: boolean;
  runId?: string;
  exitReason?: 'completed' | 'cancelled' | 'errored';
  error?: string;
}

export interface BotCancelRequest {
  runId: string;
}

export interface BotCancelResult {
  ok: boolean;
  error?: string;
}

export interface RunRecord {
  ts: string;
  runId: string;
  /**
   * Phase 6: source of the run.
   *   - `manual` — user clicked Send / programmatically triggered via bots/trigger.
   *   - `cron`   — daemon croner fired the schedule and invoked
   *                runSendMessageCycle directly. The scheduler module writes
   *                a RunRecord with trigger='cron' on close.
   */
  trigger: 'manual' | 'cron';
  durationMs: number;
  exitReason: 'completed' | 'cancelled' | 'errored';
  error?: { code: string; message: string };
  messageCount: number;
}

// Phase 4 Wave 3: paginated run history read surface.
export interface BotRunsRequest {
  bot: string;
  limit?: number;
  offset?: number;
}

export interface BotRunsResult {
  ok: boolean;
  runs: RunRecord[];
  hasMore: boolean;
  error?: string;
}

// ─── Phase 7: Obsidian vault integration ──────────────────────────────────

/**
 * Phase 7 Plan 1: persisted global vault config. Mirrors the on-disk
 * `<userData>/vault.json` shape. `rootPath` is the absolute path to the
 * Obsidian vault on disk; `globalDeny` is an array of picomatch globs
 * applied to every bot, evaluated BEFORE per-bot vaultDeny/vaultAllow
 * (deny-wins precedence).
 */
export interface VaultGlobalConfig {
  rootPath: string;
  globalDeny: string[];
}

/**
 * Phase 7 Plan 1: wire shape returned by `vault/get_config` and
 * `vault/set_config`. `ok:false` carries an `error` string for renderer
 * surfaces; `config` is undefined on error.
 */
export interface VaultConfigResult {
  ok: boolean;
  config?: VaultGlobalConfig;
  error?: string;
}

/**
 * Phase 7 Plan 1: emitted by main when the persisted vault config
 * changes (renderer subscribes via `EVENT_VAULT_CONFIG_UPDATED`).
 */
export interface VaultConfigUpdatedEvent {
  config: VaultGlobalConfig;
}

// ─── Phase 8: browser automation ───────────────────────────────────────────

/**
 * Phase 8 Plan 1: renderer → main IPC request for fetching a screenshot
 * PNG by `app://` URI. `runId` + `n` (filename suffix) identify the
 * specific screenshot in `<userData>/screenshots/<runId>/<n>.png`. The
 * Plan 2 `app://` protocol handler resolves the URI; this request is the
 * placeholder used for the renderer-side UI hook today and the actual
 * delivery path tomorrow.
 */
export interface BrowserScreenshotRequest {
  runId: string;
  n: string;
}

/**
 * Phase 8 Plan 1: renderer-side result shape. `fileUri` is the
 * `app://localhost/screenshots/<runId>/<n>.png` URI the renderer can
 * pass to `<img src>`. `bytes` is the PNG byte count (audit-friendly
 * counter; never the PNG bytes themselves).
 */
export interface BrowserScreenshotResult {
  ok: boolean;
  fileUri?: string;
  bytes?: number;
  error?: string;
}

/**
 * Phase 8 Plan 1: renderer → main IPC request for closing + removing
 * the bot's per-bot BrowserContext (Pitfall 7 cleanup). Useful when the
 * renderer wants to immediately forget cookies / localStorage without
 * deleting the bot.
 */
export interface BrowserDeleteContextRequest {
  bot: string;
}