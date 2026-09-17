// Shared types between main, preload, and renderer.

import type Anthropic from '@anthropic-ai/sdk';

export type Role = 'user' | 'assistant';

// Phase 2: discriminated union for renderer blocks. Legacy JSONL rows from
// Phase 1 only carry `content: string`; the renderer falls back to wrapping
// `content` as a single `{kind:'text'}` block when `blocks` is absent.
export type MessageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean };

export interface ChatMessage {
  ts: number;
  role: Role;
  content: string;
  blocks?: MessageBlock[];        // NEW (Phase 2) — back-compat: legacy rows omit it
  stopped?: boolean;
  interrupted?: boolean;
  msgId?: string;
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
