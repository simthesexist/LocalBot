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
  on: ((channel: LocalbotChannel, handler: (payload: any) => void) => {
    return on(channel, handler);
  }) as LocalbotApi['on'],
};

contextBridge.exposeInMainWorld('localbot', api);
