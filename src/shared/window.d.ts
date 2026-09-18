// Global Window augmentation for the renderer. Lives in src/shared so both
// the preload bundle (which defines window.localbot at runtime) and the
// renderer TypeScript code (which consumes it) reference the same shape.

import type {
  AppInitPayload,
  DaemonStatus,
  DoneEvent,
  ErrorEvent,
  HistoryAppendedEvent,
  HistoryLoadResult,
  HistoryLoadedEvent,
  KeyClearResult,
  KeyGetResult,
  KeyProbeResult,
  KeySetResult,
  MemoryReadResult,
  MemoryUpdatedEvent,
  SessionEntry,
  TokenEvent,
  ToolResultEvent,
  ToolUseEvent,
  TreeListRequest,
  TreeListResult,
  TreeRefreshEvent,
} from './types';

export type LocalbotChannel =
  | 'message:token'
  | 'message:done'
  | 'message:error'
  | 'message:tool_use'
  | 'message:tool_result'
  | 'daemon:status'
  | 'app:init'
  // Phase 3 channels:
  | 'tree:refresh'
  | 'memory:updated'
  | 'history:loaded'
  | 'history:appended';

export type LocalbotEventPayload =
  | TokenEvent
  | DoneEvent
  | ErrorEvent
  | ToolUseEvent
  | ToolResultEvent
  | DaemonStatus
  | AppInitPayload
  | HistoryAppendedEvent
  | HistoryLoadedEvent
  | MemoryUpdatedEvent
  | TreeRefreshEvent;

export interface LocalbotApi {
  sendMessage: (content: string, msgId: string) => Promise<{ ok: boolean; error?: string }>;
  cancel: (msgId: string) => Promise<{ ok: boolean }>;
  key: {
    get: () => Promise<KeyGetResult>;
    set: (key: string) => Promise<KeySetResult>;
    probe: (key: string) => Promise<KeyProbeResult>;
    clear: () => Promise<KeyClearResult>;
  };
  history: {
    listSessions: (bot: string) => Promise<{ ok: boolean; sessions?: SessionEntry[]; error?: string }>;
    load: (bot: string, sessionId: string) => Promise<HistoryLoadResult>;
  };
  memory: {
    read: (bot: string) => Promise<MemoryReadResult>;
  };
  tree: {
    list: (req: TreeListRequest) => Promise<TreeListResult>;
  };
  on: (channel: LocalbotChannel, handler: (payload: LocalbotEventPayload) => void) => () => void;
}

declare global {
  interface Window {
    localbot: LocalbotApi;
  }
}

export {};
