// Unit tests for src/main/preload/index.ts — preload bridge surface.
//
// Mirrors the `tests/unit/window.test.ts` + `tests/unit/spawn.test.ts` style:
//   - vi.mock('electron', ...) satisfies `contextBridge` + `ipcRenderer` so
//     the preload module side-effect import does not require an actual
//     Electron runtime.
//   - The mock factory exposes `exposeInMainWorld` as a vi.fn so the test
//     can grab the api object the bridge registered and assert its shape.
//   - ipcRenderer.invoke / ipcRenderer.on are vi.fn()s so we can assert
//     forwarding for both the new `invoke` proxy and the existing typed
//     surface (regression guard).
//
// The preload module is imported as a side effect (`import '../../src/main/preload/index'`)
// so that `contextBridge.exposeInMainWorld(...)` runs at module-load time
// and registers the api on `globalThis` via Vitest's module registry.
//
// IMPORTANT: vitest's `vi.clearAllMocks()` clears ALL mocks including the
// `contextBridge.exposeInMainWorld` call history. The bridge only runs its
// expose call once at module load, so we capture the api object in a
// module-scoped variable immediately after the preload import and avoid
// clearing the contextBridge mock in beforeEach (we only clear the
// renderer-side mocks: ipcRenderer.invoke / on / removeListener / send).

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock is hoisted above all imports. The factory must NOT reference any
// outer-scope variables.
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  },
}));

// eslint-disable-next-line import/first
import { contextBridge, ipcRenderer } from 'electron';
// eslint-disable-next-line import/first
import { CHANNELS } from '../../src/shared/ipc-channels';
// eslint-disable-next-line import/first
import '../../src/main/preload/index';

// Capture the api the preload module registered, once, before any
// beforeEach clears mock call history. This is the only reliable way to
// grab the exposed api across tests: a fresh re-import wouldn't re-run
// the bridge (it's a module side effect), and re-running the bridge would
// double-register a second `exposeInMainWorld` call that the dev-only
// contextBridge refuses anyway.
type ExposedApi = Record<string, unknown>;
const exposeMock = contextBridge.exposeInMainWorld as unknown as {
  mock: { calls: unknown[][] };
};
const firstCall = exposeMock.mock.calls[0];
if (!firstCall) {
  throw new Error('contextBridge.exposeInMainWorld was never called at module load — preload bridge did not register');
}
const [, EXPOSED_API] = firstCall as [string, ExposedApi];
const WORLD_NAME = firstCall[0] as string;

beforeEach(() => {
  // Clear ONLY the ipcRenderer mocks so each test gets a fresh call
  // history. Do NOT call vi.clearAllMocks() — that would also wipe the
  // contextBridge.exposeInMainWorld mock calls, leaving the next test
  // unable to find the registered api.
  (ipcRenderer.invoke as unknown as { mockClear: () => void }).mockClear();
  (ipcRenderer.on as unknown as { mockClear: () => void }).mockClear();
  (ipcRenderer.removeListener as unknown as { mockClear: () => void }).mockClear();
  (ipcRenderer.send as unknown as { mockClear: () => void }).mockClear();
});

describe('preload bridge — registration', () => {
  it('exposes the api under the "localbot" world name', () => {
    expect(WORLD_NAME).toBe('localbot');
    expect(typeof EXPOSED_API).toBe('object');
    expect(EXPOSED_API).not.toBeNull();
  });

  it('exposes an invoke method on the api', () => {
    expect(typeof EXPOSED_API.invoke).toBe('function');
  });
});

describe('preload bridge — invoke(channel, payload?)', () => {
  it('invoke(channel) forwards to ipcRenderer.invoke with no payload when payload is omitted (KEY_GET case)', async () => {
    const api = EXPOSED_API as { invoke: (channel: string, payload?: unknown) => Promise<unknown> };
    // KEY_GET is a no-payload invoke channel.
    await api.invoke(CHANNELS.KEY_GET);
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('key:get');
  });

  it('invoke(channel, undefined) normalizes to a single positional arg (KEY_CLEAR / CANCEL case)', async () => {
    // Per the preload implementation, `payload === undefined` short-circuits
    // to the single-arg ipcRenderer.invoke form. JS calls
    // `api.invoke(CH, undefined)` collapse to `payload === undefined`, so
    // the IPC handler never sees a literal `undefined` positional arg.
    // This is the guard that keeps KEY_GET / KEY_CLEAR / CANCEL safe
    // across Electron versions.
    const api = EXPOSED_API as { invoke: (channel: string, payload?: unknown) => Promise<unknown> };
    await api.invoke(CHANNELS.CANCEL, undefined);
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CHANNELS.CANCEL);
  });

  it('invoke(channel, payload) forwards to ipcRenderer.invoke(channel, payload)', async () => {
    const api = EXPOSED_API as { invoke: (channel: string, payload?: unknown) => Promise<unknown> };
    await api.invoke(CHANNELS.HISTORY_LIST, { bot: 'default' });
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('history:listSessions', { bot: 'default' });
  });
});

describe('preload bridge — existing typed surface (regression guard)', () => {
  it('history.listSessions forwards with the CHANNELS.HISTORY_LIST constant + payload { bot }', async () => {
    const api = EXPOSED_API as {
      history: { listSessions: (bot: string) => Promise<unknown> };
    };
    await api.history.listSessions('default');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('history:listSessions', { bot: 'default' });
  });

  it('sendMessage forwards with { content, msgId }', async () => {
    const api = EXPOSED_API as {
      sendMessage: (content: string, msgId: string) => Promise<unknown>;
    };
    await api.sendMessage('hi', 'm1');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CHANNELS.SEND_MESSAGE, { content: 'hi', msgId: 'm1' });
  });

  it('on(event, handler) registers via ipcRenderer.on and returns an unsubscribe fn', () => {
    const api = EXPOSED_API as {
      on: (channel: string, handler: (payload: unknown) => void) => () => void;
    };
    const handler = () => undefined;
    const off = api.on(CHANNELS.EVENT_HISTORY_APPENDED, handler);
    expect(typeof off).toBe('function');
    expect(ipcRenderer.on).toHaveBeenCalledTimes(1);
    const callArgs = (ipcRenderer.on as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(callArgs[0]).toBe(CHANNELS.EVENT_HISTORY_APPENDED);
  });
});
