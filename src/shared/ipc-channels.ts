// Single source of truth for IPC channel names.

export const CHANNELS = {
  // Renderer -> main (invoke)
  SEND_MESSAGE: 'sendMessage',
  CANCEL: 'cancel',
  KEY_GET: 'key:get',
  KEY_SET: 'key:set',
  KEY_PROBE: 'key:probe',
  KEY_CLEAR: 'key:clear',

  // Phase 3: history + memory + tree.
  HISTORY_LIST: 'history:listSessions',
  HISTORY_LOAD: 'history:load',
  MEMORY_READ: 'memory:read',
  TREE_LIST: 'tree:list',

  // Phase 4 Wave 1: bot metadata CRUD IPC channels.
  BOTS_LIST: 'bots:list',
  BOTS_CREATE: 'bots:create',
  BOTS_DELETE: 'bots:delete',

  // Phase 4 Wave 2: settings edit, manual trigger, cancel.
  BOTS_UPDATE: 'bots:update',
  BOTS_TRIGGER: 'bots:trigger',
  BOTS_CANCEL: 'bots:cancel',

  // Phase 4 Wave 3: paginated run history read.
  BOTS_RUNS: 'bots:runs',

  // Renderer -> main (one-way): ask main to re-send app:init so the renderer
  // can close the race window between `did-finish-load` (main fires the
  // initial send) and React's first `useEffect` (renderer registers the
  // listener). The handler in src/main/window.ts re-fires EVENT_APP_INIT to
  // the requesting webContents.
  REQUEST_APP_INIT: 'app:init:request',

  // Main -> renderer (events)
  EVENT_MESSAGE_TOKEN: 'message:token',
  EVENT_MESSAGE_DONE: 'message:done',
  EVENT_MESSAGE_ERROR: 'message:error',
  EVENT_MESSAGE_TOOL_USE: 'message:tool_use',     // Phase 2
  EVENT_MESSAGE_TOOL_RESULT: 'message:tool_result', // Phase 2
  EVENT_DAEMON_STATUS: 'daemon:status',
  EVENT_APP_INIT: 'app:init',

  // Phase 3: event channels.
  EVENT_TREE_REFRESH: 'tree:refresh',
  EVENT_MEMORY_UPDATED: 'memory:updated',
  EVENT_HISTORY_LOADED: 'history:loaded',
  EVENT_HISTORY_APPENDED: 'history:appended',

  // Phase 4 Wave 1: bot events.
  EVENT_BOT_LIST_UPDATED: 'bot:list:updated',
  EVENT_BOT_STATUS: 'bot:status',

  // Phase 5 Wave 2: shell approval + streaming.
  SHELLS_RESPOND: 'shells:respond',
  EVENT_SHELL_REQUEST_APPROVAL: 'shell:request-approval',
  EVENT_SHELL_TOKEN: 'shell:token',
  EVENT_SHELL_EXIT: 'shell:exit',

  // Phase 6 Wave 2: scheduled-error notification bridge (daemon -> main -> renderer).
  EVENT_NOTIFICATION_SCHEDULED_ERROR: 'notification:scheduled-error',
  // Phase 6 Wave 2: main -> renderer, fired when the user clicks the
  // scheduled-error toast so the renderer can switch to the bot's chat pane.
  EVENT_NAVIGATE_TO_BOT: 'event:navigate-to-bot',

  // Phase 7 Plan 1: Obsidian vault config get/set + change event.
  VAULT_GET_CONFIG: 'vault:get_config',
  VAULT_SET_CONFIG: 'vault:set_config',
  EVENT_VAULT_CONFIG_UPDATED: 'vault:config:updated',

  // Lifecycle
  LIFECYCLE: 'lifecycle',
} as const;

export type ChannelName = typeof CHANNELS[keyof typeof CHANNELS];