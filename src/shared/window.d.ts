// Global Window augmentation for the renderer. Lives in src/shared so both
// the preload bundle (which defines window.localbot at runtime) and the
// renderer TypeScript code (which consumes it) reference the same shape.

import type {
  AppInitPayload,
  BotCancelRequest,
  BotCancelResult,
  BotCreateRequest,
  BotCreateResult,
  BotDeleteRequest,
  BotDeleteResult,
  BotListResult,
  BotListUpdatedEvent,
  BotRunsRequest,
  BotRunsResult,
  BotStatusEvent,
  BotTriggerRequest,
  BotTriggerResult,
  BotUpdateRequest,
  BotUpdateResult,
  BrowserDeleteContextRequest,
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
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
  NavigateToBotEvent,
  ScheduledErrorEvent,
  SessionEntry,
  ShellExitEvent,
  ShellRequestApprovalEvent,
  ShellTokenEvent,
  TokenEvent,
  ToolResultEvent,
  ToolUseEvent,
  TreeListRequest,
  TreeListResult,
  TreeRefreshEvent,
  VaultConfigResult,
  VaultConfigUpdatedEvent,
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
  | 'history:appended'
  // Phase 4 Wave 1 channels (invoke + events):
  | 'bots:list'
  | 'bots:create'
  | 'bots:delete'
  | 'bot:list:updated'
  | 'bot:status'
  // Phase 4 Wave 2 channels (invoke):
  | 'bots:update'
  | 'bots:trigger'
  | 'bots:cancel'
  // Phase 4 Wave 3:
  | 'bots:runs'
  // Phase 5 Wave 2:
  | 'shells:respond'
  | 'shell:request-approval'
  | 'shell:token'
  | 'shell:exit'
  // Phase 6 Wave 2:
  | 'notification:scheduled-error'
  | 'event:navigate-to-bot'
  // Phase 7 Plan 1:
  | 'vault:config:updated'
  // Phase 8 Plan 1: browser automation channels.
  | 'browser:get_screenshot'
  | 'browser:delete_context'
  | 'browser:config:updated'
  | 'browser:page:closed';

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
  | TreeRefreshEvent
  | BotListUpdatedEvent
  | BotStatusEvent
  // Phase 5 Wave 2:
  | ShellRequestApprovalEvent
  | ShellTokenEvent
  | ShellExitEvent
  // Phase 6 Wave 2:
  | ScheduledErrorEvent
  | NavigateToBotEvent
  // Phase 7 Plan 1:
  | VaultConfigUpdatedEvent;

export interface LocalbotApi {
  sendMessage: (content: string, msgId: string, bot?: string) => Promise<{ ok: boolean; error?: string }>;
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
   * Phase 4 Wave 1: per-bot metadata CRUD. The renderer never touches the
   * filesystem directly — every call routes through the daemon's
   * bots/{list,create,delete} JSON-RPC methods via `src/main/ipc/bots.ts`.
   */
  bot: {
    list: () => Promise<BotListResult>;
    create: (req: BotCreateRequest) => Promise<BotCreateResult>;
    delete: (req: BotDeleteRequest) => Promise<BotDeleteResult>;
    // Phase 4 Wave 2: settings edit, manual trigger, cancel.
    update: (req: BotUpdateRequest) => Promise<BotUpdateResult>;
    trigger: (req: BotTriggerRequest) => Promise<BotTriggerResult>;
    cancel: (req: BotCancelRequest) => Promise<BotCancelResult>;
    // Phase 4 Wave 3: paginated run history read.
    runs: (req: BotRunsRequest) => Promise<BotRunsResult>;
  };
  /**
   * Phase 5 Wave 2: shell approval + streaming IPC surface.
   */
  shell: {
    respond: (shellId: string, decision: 'allow-once' | 'allow-always' | 'deny') => Promise<void>;
  };
  /**
   * Phase 7 Plan 1: Obsidian vault config get/set IPC surface. Both
   * invocations go through `src/main/ipc/vault.ts` which proxies to the
   * daemon's vault/get_config + vault/set_config JSON-RPC cases. On a
   * successful set, main broadcasts EVENT_VAULT_CONFIG_UPDATED to all
   * windows; the renderer subscribes via the generic `on` proxy.
   */
  vault: {
    getConfig: () => Promise<VaultConfigResult>;
    setConfig: (req: { rootPath: string; globalDeny: string[] }) => Promise<VaultConfigResult>;
  };
  /**
   * Phase 8 Plan 1: browser automation IPC surface. getScreenshot
   * resolves a screenshot PNG by runId + n; deleteContext closes + removes
   * the per-bot BrowserContext (cookies / localStorage cleanup). The
   * Plan 2 `app://` protocol handler backs getScreenshot; the
   * `BrowserScreenshotResult.fileUri` carries the resolved URI.
   */
  browser: {
    getScreenshot: (req: BrowserScreenshotRequest) => Promise<BrowserScreenshotResult>;
    deleteContext: (req: BrowserDeleteContextRequest) => Promise<{ ok: boolean; error?: string }>;
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
