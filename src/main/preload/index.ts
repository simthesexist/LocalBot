// contextBridge surface for the renderer.

import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '../../shared/ipc-channels';
import type { LocalbotApi, LocalbotChannel } from '../../shared/window';

const EVENT_CHANNELS = new Set<string>([
  CHANNELS.EVENT_MESSAGE_TOKEN,
  CHANNELS.EVENT_MESSAGE_DONE,
  CHANNELS.EVENT_MESSAGE_ERROR,
  CHANNELS.EVENT_MESSAGE_TOOL_USE,
  CHANNELS.EVENT_MESSAGE_TOOL_RESULT,
  CHANNELS.EVENT_DAEMON_STATUS,
  CHANNELS.EVENT_APP_INIT,
  // Phase 3 channels:
  CHANNELS.EVENT_TREE_REFRESH,
  CHANNELS.EVENT_MEMORY_UPDATED,
  CHANNELS.EVENT_HISTORY_LOADED,
  CHANNELS.EVENT_HISTORY_APPENDED,
  // Phase 4 Wave 1 channels:
  CHANNELS.EVENT_BOT_LIST_UPDATED,
  CHANNELS.EVENT_BOT_STATUS,
]);

function on(channel: string, handler: (payload: any) => void): () => void {
  if (!EVENT_CHANNELS.has(channel)) {
    throw new Error(`bad channel: ${channel}`);
  }
  const wrapped = (_e: unknown, payload: any) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: LocalbotApi = {
  sendMessage: (content, msgId) => ipcRenderer.invoke(CHANNELS.SEND_MESSAGE, { content, msgId }),
  cancel: (msgId) => ipcRenderer.invoke(CHANNELS.CANCEL, msgId),
  key: {
    get: () => ipcRenderer.invoke(CHANNELS.KEY_GET),
    set: (key) => ipcRenderer.invoke(CHANNELS.KEY_SET, { key }),
    probe: (key) => ipcRenderer.invoke(CHANNELS.KEY_PROBE, { key }),
    clear: () => ipcRenderer.invoke(CHANNELS.KEY_CLEAR),
  },
  history: {
    listSessions: (bot) => ipcRenderer.invoke(CHANNELS.HISTORY_LIST, { bot }),
    load: (bot, sessionId) => ipcRenderer.invoke(CHANNELS.HISTORY_LOAD, { bot, sessionId }),
  },
  memory: {
    read: (bot) => ipcRenderer.invoke(CHANNELS.MEMORY_READ, { bot }),
  },
  tree: {
    list: (req) => ipcRenderer.invoke(CHANNELS.TREE_LIST, req),
  },
  bot: {
    list: () => ipcRenderer.invoke(CHANNELS.BOTS_LIST),
    create: (req) => ipcRenderer.invoke(CHANNELS.BOTS_CREATE, req),
    delete: (req) => ipcRenderer.invoke(CHANNELS.BOTS_DELETE, req),
    // Phase 4 Wave 2: settings edit, manual trigger, cancel.
    update: (req) => ipcRenderer.invoke(CHANNELS.BOTS_UPDATE, req),
    trigger: (req) => ipcRenderer.invoke(CHANNELS.BOTS_TRIGGER, req),
    cancel: (req) => ipcRenderer.invoke(CHANNELS.BOTS_CANCEL, req),
  },
  // One-way: renderer asks main to re-send EVENT_APP_INIT. Used in App.tsx
  // after the app:init listener is registered to close the
  // did-finish-load vs React useEffect race window.
  requestAppInit: () => ipcRenderer.send(CHANNELS.REQUEST_APP_INIT),
  // Generic IPC proxy: forwards `ipcRenderer.invoke(channel, payload?)` so
  // that callers (e.g. Playwright tests, future generic tools, ad-hoc dev
  // console probing) can address any registered invoke-channel by name
  // without the preload having to enumerate every handler. The typed
  // namespace surface above (`history.*`, `memory.*`, `tree.*`, `key.*`,
  // `sendMessage`, `cancel`) is preserved; this is purely additive.
  // The `payload === undefined` branch keeps no-arg invokes (KEY_GET,
  // KEY_CLEAR, CANCEL) from forwarding a literal `undefined` positional
  // arg to the IPC handler.
  invoke: (channel: LocalbotChannel | string, payload?: unknown) =>
    payload === undefined
      ? ipcRenderer.invoke(channel as string)
      : ipcRenderer.invoke(channel as string, payload),
  on: ((channel: LocalbotChannel, handler: (payload: any) => void) => {
    return on(channel, handler);
  }) as LocalbotApi['on'],
};

contextBridge.exposeInMainWorld('localbot', api);
