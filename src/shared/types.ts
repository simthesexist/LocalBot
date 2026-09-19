// Shared types between main, preload, and renderer.

import type Anthropic from '@anthropic-ai/sdk';

export type Role = 'user' | 'assistant';

// Phase 3: extended discriminated union. The renderer ignores unknown kinds
// gracefully (MessageBlock falls back to a generic renderer) so adding a
// new kind (like `summary`) does not break older builds.
// Phase 5 Wave 2: shell_stream variant for live stdout/stderr from exec_command.
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