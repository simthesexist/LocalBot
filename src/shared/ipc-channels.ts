// Single source of truth for IPC channel names.

export const CHANNELS = {
  // Renderer -> main (invoke)
  SEND_MESSAGE: 'sendMessage',
  CANCEL: 'cancel',
  KEY_GET: 'key:get',
  KEY_SET: 'key:set',
  KEY_PROBE: 'key:probe',
  KEY_CLEAR: 'key:clear',

  // Main -> renderer (events)
  EVENT_MESSAGE_TOKEN: 'message:token',
  EVENT_MESSAGE_DONE: 'message:done',
  EVENT_MESSAGE_ERROR: 'message:error',
  EVENT_MESSAGE_TOOL_USE: 'message:tool_use',     // Phase 2
  EVENT_MESSAGE_TOOL_RESULT: 'message:tool_result', // Phase 2
  EVENT_DAEMON_STATUS: 'daemon:status',
  EVENT_APP_INIT: 'app:init',

  // Lifecycle
  LIFECYCLE: 'lifecycle',
} as const;

export type ChannelName = typeof CHANNELS[keyof typeof CHANNELS];
