// contextBridge surface for the renderer.

import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '../../shared/ipc-channels';
import type {
  AppInitPayload,
  DaemonStatus,
  DoneEvent,
  ErrorEvent,
  KeyClearResult,
  KeyGetResult,
  KeyProbeResult,
  KeySetResult,
  TokenEvent,
  ToolResultEvent,
  ToolUseEvent,
} from '../../shared/types';

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

const api = {
  sendMessage: (content: string, msgId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CHANNELS.SEND_MESSAGE, { content, msgId }),
  cancel: (msgId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(CHANNELS.CANCEL, msgId),
  key: {
    get: (): Promise<KeyGetResult> => ipcRenderer.invoke(CHANNELS.KEY_GET),
    set: (key: string): Promise<KeySetResult> => ipcRenderer.invoke(CHANNELS.KEY_SET, { key }),
    probe: (key: string): Promise<KeyProbeResult> => ipcRenderer.invoke(CHANNELS.KEY_PROBE, { key }),
    clear: (): Promise<KeyClearResult> => ipcRenderer.invoke(CHANNELS.KEY_CLEAR),
  },
  on,
};

contextBridge.exposeInMainWorld('localbot', api);

// Type declarations for renderer.
declare global {
  interface Window {
    localbot: {
      sendMessage: (content: string, msgId: string) => Promise<{ ok: boolean; error?: string }>;
      cancel: (msgId: string) => Promise<{ ok: boolean }>;
      key: {
        get: () => Promise<KeyGetResult>;
        set: (key: string) => Promise<KeySetResult>;
        probe: (key: string) => Promise<KeyProbeResult>;
        clear: () => Promise<KeyClearResult>;
      };
      on: (
        channel:
          | typeof CHANNELS.EVENT_MESSAGE_TOKEN
          | typeof CHANNELS.EVENT_MESSAGE_DONE
          | typeof CHANNELS.EVENT_MESSAGE_ERROR
          | typeof CHANNELS.EVENT_MESSAGE_TOOL_USE
          | typeof CHANNELS.EVENT_MESSAGE_TOOL_RESULT
          | typeof CHANNELS.EVENT_DAEMON_STATUS
          | typeof CHANNELS.EVENT_APP_INIT,
        handler: (
          payload:
            | TokenEvent
            | DoneEvent
            | ErrorEvent
            | ToolUseEvent
            | ToolResultEvent
            | DaemonStatus
            | AppInitPayload,
        ) => void,
      ) => () => void;
    };
  }
}
