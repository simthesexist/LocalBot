// Shared types between main, preload, and renderer.

export type Role = 'user' | 'assistant';

export interface ChatMessage {
  ts: number;
  role: Role;
  content: string;
  stopped?: boolean;
  interrupted?: boolean;
  msgId?: string;
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
