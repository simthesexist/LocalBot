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

  // Lifecycle
  LIFECYCLE: 'lifecycle',
} as const;

export type ChannelName = typeof CHANNELS[keyof typeof CHANNELS];