// Shared types between main, preload, and renderer.

import type Anthropic from '@anthropic-ai/sdk';

export type Role = 'user' | 'assistant';

// Phase 3: extended discriminated union. The renderer ignores unknown kinds
// gracefully (MessageBlock falls back to a generic renderer) so adding a
// new kind (like `summary`) does not break older builds.
export type MessageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'summary'; summary: SummaryRecord };

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