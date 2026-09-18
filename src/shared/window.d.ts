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
  /**
   * One-way: ask the main process to re-send `app:init`. The renderer calls
   * this immediately after registering its `app:init` listener so that the
   * race between `did-finish-load` (main fires the initial send) and the
   * React `useEffect` that registers the listener cannot drop the event.
   */
  requestAppInit: () => void;
  /**
   * Generic IPC proxy: forwards `ipcRenderer.invoke(channel, payload?)` so
   * renderer code (and Playwright tests) can address any registered
   * channel by name without the preload having to enumerate every
   * handler. Mirrors the typed namespace surface above; the channel
   * names must match `CHANNELS` in `src/shared/ipc-channels.ts`.
   */
  invoke: <T = unknown>(channel: LocalbotChannel | string, payload?: unknown) => Promise<T>;
  on: (channel: LocalbotChannel, handler: (payload: LocalbotEventPayload) => void) => () => void;
}

declare global {
  interface Window {
    localbot: LocalbotApi;
  }
}

export {};
