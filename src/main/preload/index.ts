// contextBridge surface for the renderer.

import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '../../shared/ipc-channels';
import type { LocalbotApi, LocalbotChannel } from '../../shared/window';
import type {
  BrowserDeleteContextRequest,
  BrowserScreenshotRequest,
  NetworkConfig,
} from '../../shared/types';

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
  // Phase 5 Wave 2: shell approval + streaming.
  CHANNELS.EVENT_SHELL_REQUEST_APPROVAL,
  CHANNELS.EVENT_SHELL_TOKEN,
  CHANNELS.EVENT_SHELL_EXIT,
  // Phase 6 Wave 2: scheduled-error toast + click-to-navigate.
  CHANNELS.EVENT_NOTIFICATION_SCHEDULED_ERROR,
  CHANNELS.EVENT_NAVIGATE_TO_BOT,
  // Phase 7 Plan 1: vault config change event (broadcast by main when
  // the persisted global vault config is updated via vault/set_config).
  CHANNELS.EVENT_VAULT_CONFIG_UPDATED,
  // Phase 8 Plan 1: browser automation events (broadcast by main when
  // the per-bot browser config changes via bots/update OR when a
  // browser page is closed).
  CHANNELS.EVENT_BROWSER_CONFIG_UPDATED,
  CHANNELS.EVENT_BROWSER_PAGE_CLOSED,
  // Phase 9 Plan 2: network config change (post-rebind) + reach-info
  // refresh (5s TTL). Renderer subscribes via the renderer's state/network.ts
  // module and refreshes on each event.
  CHANNELS.EVENT_NETWORK_CONFIG_UPDATED,
  CHANNELS.EVENT_REACH_INFO_UPDATED,
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
  sendMessage: (content, msgId, bot) => ipcRenderer.invoke(CHANNELS.SEND_MESSAGE, { content, msgId, bot }),
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
    // Phase 4 Wave 3: paginated run history read.
    runs: (req) => ipcRenderer.invoke(CHANNELS.BOTS_RUNS, req),
  },
  // One-way: renderer asks main to re-send EVENT_APP_INIT. Used in App.tsx
  // after the app:init listener is registered to close the
  // did-finish-load vs React useEffect race window.
  requestAppInit: () => ipcRenderer.send(CHANNELS.REQUEST_APP_INIT),
  // Phase 5 Wave 2: renderer decides a pending shell approval via the
  // `shells:respond` IPC invoke. The main-process handler in
  // src/main/ipc/shells.ts validates the decision shape and forwards it to
  // the daemon's pendingApprovals map. Returns when the daemon acks.
  shell: {
    respond: (shellId, decision) => ipcRenderer.invoke(CHANNELS.SHELLS_RESPOND, { shellId, decision }),
  },
  // Phase 7 Plan 1: Obsidian vault config get/set. The main-process
  // handler in src/main/ipc/vault.ts validates the shape and proxies to
  // the daemon's vault/get_config + vault/set_config JSON-RPC cases. On a
  // successful set, main broadcasts EVENT_VAULT_CONFIG_UPDATED to all
  // windows; subscribers (renderer state/vault.ts) refresh from there.
  vault: {
    getConfig: () => ipcRenderer.invoke(CHANNELS.VAULT_GET_CONFIG),
    setConfig: (req: { rootPath: string; globalDeny: string[] }) =>
      ipcRenderer.invoke(CHANNELS.VAULT_SET_CONFIG, req),
  },
  // Phase 8 Plan 1: browser automation IPC surface. Plan 2 wires the
  // src/main/ipc/browser.ts handlers (getScreenshot resolves the
  // `app://localhost/screenshots/<runId>/<n>.png` URI; deleteContext
  // closes + removes the per-bot BrowserContext). Today the surface
  // exists so the renderer's BotSettingsBrowserTab (Plan 3) can wire
  // without a preload reload.
  browser: {
    getScreenshot: (req: BrowserScreenshotRequest) =>
      ipcRenderer.invoke(CHANNELS.BROWSER_GET_SCREENSHOT, req),
    deleteContext: (req: BrowserDeleteContextRequest) =>
      ipcRenderer.invoke(CHANNELS.BROWSER_DELETE_CONTEXT, req),
  },
  // Phase 9 Plan 1: phone-reach network config IPC surface. The preload
  // forwards each method to its corresponding invoke channel; main's
  // src/main/ipc/network.ts validates config shape before callBot, so
  // the renderer gets a clean inline error without round-tripping to the
  // daemon. No event channels in Wave 1 — Wave 2 adds
  // EVENT_REACH_INFO_UPDATED + EVENT_NETWORK_CONFIG_UPDATED.
  network: {
    getConfig: () => ipcRenderer.invoke(CHANNELS.NETWORK_GET_CONFIG),
    setConfig: (cfg: NetworkConfig) =>
      ipcRenderer.invoke(CHANNELS.NETWORK_SET_CONFIG, cfg),
    getReachInfo: () => ipcRenderer.invoke(CHANNELS.NETWORK_GET_REACH_INFO),
  },
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
