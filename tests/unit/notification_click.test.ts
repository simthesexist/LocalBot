// Unit tests for the click-handler branch of the scheduled-error toast.
// Phase 6 Wave 2 — exercises the focus-window + emit-navigate path that
// runs when the user clicks the Windows toast.
//
// Threat model coverage:
//   T-P6-13 click DoS: case F (webContents.send throws)
//   T-P6-14 navigate subscription: cases A + B + D (correct botId + correct
//     window lifecycle)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const clickTracker = vi.hoisted(() => ({
  ctorArgs: [] as Array<{ title: string; body: string; silent: boolean }>,
  clickHandlers: [] as Array<(...args: unknown[]) => void>,
}));

vi.mock('electron', () => ({
  Notification: class {
    static isSupported = vi.fn(() => true);
    public show = vi.fn();
    public on(event: string, handler: (...args: unknown[]) => void): void {
      if (event === 'click') clickTracker.clickHandlers.push(handler);
    }
    public constructor(public options: { title: string; body: string; silent: boolean }) {
      clickTracker.ctorArgs.push(options);
    }
  },
  BrowserWindow: class {
    public static getAllWindows = vi.fn(() => []);
    public webContents = { send: vi.fn() };
    public isDestroyed = vi.fn(() => false);
    public isMinimized = vi.fn(() => false);
    public restore = vi.fn();
    public show = vi.fn();
    public focus = vi.fn();
  },
  app: {
    setAppUserModelId: vi.fn(),
    getPath: vi.fn(() => os.tmpdir()),
  },
}));

import * as electronMock from 'electron';
import {
  handleScheduledError,
  __test__,
} from '../../src/main/ipc/notifications';
import type { ScheduledErrorEvent } from '../../src/shared/types';

let userDataDir = '';
beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-notif-click-'));
  process.env.LOCALBOT_USER_DATA_DIR = userDataDir;
  clickTracker.ctorArgs.length = 0;
  clickTracker.clickHandlers.length = 0;
  __test__._resetForTest();
  vi.mocked(electronMock.Notification.isSupported).mockReturnValue(true);
  vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([] as unknown as ReturnType<typeof electronMock.BrowserWindow.getAllWindows>);
  vi.mocked(electronMock.app.setAppUserModelId).mockClear();
});
afterEach(() => {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LOCALBOT_USER_DATA_DIR;
});

function writeBotConfig(bot: string, cfg: Record<string, unknown>): void {
  const dir = path.join(userDataDir, 'bots', bot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
}

function makeFakeWindow(overrides: Partial<{
  webContentsSend: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
}> = {}) {
  const webContentsSend = overrides.webContentsSend ?? vi.fn();
  return {
    webContents: { send: webContentsSend },
    isDestroyed: overrides.isDestroyed ?? vi.fn(() => false),
    isMinimized: overrides.isMinimized ?? vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

function fireClickFor(bot: string, errMessage = 'boom'): ScheduledErrorEvent {
  handleScheduledError({
    bot,
    runId: `r-${bot}`,
    errorMessage: errMessage,
    ts: new Date().toISOString(),
  });
  // The most recent click handler corresponds to the most recent toast.
  const handler = clickTracker.clickHandlers[clickTracker.clickHandlers.length - 1];
  expect(handler).toBeDefined();
  handler!();
  return {
    bot,
    runId: `r-${bot}`,
    errorMessage: errMessage,
    ts: new Date().toISOString(),
  };
}

describe('Notification click handler — focus + navigate', () => {
  it('A. focuses existing non-destroyed window + emits EVENT_NAVIGATE_TO_BOT with correct botId', () => {
    writeBotConfig('alpha', { id: 'alpha', name: 'Alpha', schemaVersion: 1, allowlist: [] });
    const win = makeFakeWindow();
    vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([win as unknown as ReturnType<typeof electronMock.BrowserWindow.getAllWindows>[number]] as unknown as ReturnType<typeof electronMock.BrowserWindow.getAllWindows>);

    fireClickFor('alpha');

    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.restore).not.toHaveBeenCalled(); // not minimized
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    const sentArgs = win.webContents.send.mock.calls[0];
    expect(sentArgs[0]).toBe('event:navigate-to-bot');
    expect(sentArgs[1]).toEqual({ botId: 'alpha' });
  });

  it('B. calls createMainWindow() when getMainWindow() returns null (no window)', () => {
    writeBotConfig('alpha', { id: 'alpha', name: 'Alpha', schemaVersion: 1, allowlist: [] });
    vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([] as unknown as ReturnType<typeof electronMock.BrowserWindow.getAllWindows>);
    const newWin = makeFakeWindow();
    // Default deps createMainWindow uses the real window module; we override
    // by calling handleScheduledError with explicit deps so we don't pull in
    // the real electron window module from this isolated test file.
    handleScheduledError(
      {
        bot: 'alpha',
        runId: 'r-alpha',
        errorMessage: 'boom',
        ts: new Date().toISOString(),
      },
      {
        getMainWindow: () => null,
        createMainWindow: () => newWin as unknown as ReturnType<typeof electronMock.BrowserWindow.getAllWindows>[number],
      },
    );
    // The click handler uses deps.createMainWindow() since getMainWindow returns null.
    const handler = clickTracker.clickHandlers[clickTracker.clickHandlers.length - 1];
    handler!();

    expect(newWin.show).toHaveBeenCalledTimes(1);
    expect(newWin.focus).toHaveBeenCalledTimes(1);
    expect(newWin.webContents.send).toHaveBeenCalledWith('event:navigate-to-bot', { botId: 'alpha' });
  });

  it('C. restores + shows + focuses a minimized window', () => {
    writeBotConfig('alpha', { id: 'alpha', name: 'Alpha', schemaVersion: 1, allowlist: [] });
    const win = makeFakeWindow({ isMinimized: () => true });
    vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([win as unknown as ReturnType<typeof electronMock.BrowserWindow.getAllWindows>[number]] as unknown as ReturnType<typeof electronMock.BrowserWindow.getAllWindows>);

    fireClickFor('alpha');

    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it('D. calls createMainWindow() when existing window is destroyed', () => {
    writeBotConfig('alpha', { id: 'alpha', name: 'Alpha', schemaVersion: 1, allowlist: [] });
    const destroyedWin = makeFakeWindow({ isDestroyed: () => true });
    const newWin = makeFakeWindow();
    handleScheduledError(
      {
        bot: 'alpha',
        runId: 'r-alpha',
        errorMessage: 'boom',
        ts: new Date().toISOString(),
      },
      {
        getMainWindow: () => destroyedWin as unknown as ReturnType<typeof electronMock.BrowserWindow.getAllWindows>[number],
        createMainWindow: () => newWin as unknown as ReturnType<typeof electronMock.BrowserWindow.getAllWindows>[number],
      },
    );
    const handler = clickTracker.clickHandlers[clickTracker.clickHandlers.length - 1];
    handler!();

    // Destroyed window must NOT have been shown/focused.
    expect(destroyedWin.show).not.toHaveBeenCalled();
    expect(destroyedWin.focus).not.toHaveBeenCalled();
    // New window replaces it.
    expect(newWin.show).toHaveBeenCalledTimes(1);
    expect(newWin.focus).toHaveBeenCalledTimes(1);
    expect(newWin.webContents.send).toHaveBeenCalledWith('event:navigate-to-bot', { botId: 'alpha' });
  });

  it('E. 2 toasts for DIFFERENT bots have SEPARATE click handlers — each emits its own botId', () => {
    writeBotConfig('alpha', { id: 'alpha', name: 'Alpha', schemaVersion: 1, allowlist: [] });
    writeBotConfig('beta', { id: 'beta', name: 'Beta', schemaVersion: 1, allowlist: [] });
    // __resetForTest clears lastToastAt — but we use different bots, so even
    // without reset the debounce won't fire. Reset to be deterministic.
    __test__._resetForTest();
    const alphaWin = makeFakeWindow();
    const betaWin = makeFakeWindow();
    let next = 0;
    const wins = [alphaWin, betaWin];
    vi.mocked(electronMock.BrowserWindow.getAllWindows).mockImplementation(
      () => [wins[next++] as unknown as ReturnType<typeof electronMock.BrowserWindow.getAllWindows>[number]] as unknown as ReturnType<typeof electronMock.BrowserWindow.getAllWindows>,
    );

    fireClickFor('alpha');
    fireClickFor('beta');

    // Two distinct click handlers were captured.
    expect(clickTracker.clickHandlers).toHaveLength(2);
    expect(alphaWin.webContents.send).toHaveBeenCalledWith('event:navigate-to-bot', { botId: 'alpha' });
    expect(betaWin.webContents.send).toHaveBeenCalledWith('event:navigate-to-bot', { botId: 'beta' });
  });

  it('F. click handler does NOT throw when webContents.send throws (T-P6-13 click DoS)', () => {
    writeBotConfig('alpha', { id: 'alpha', name: 'Alpha', schemaVersion: 1, allowlist: [] });
    const send = vi.fn(() => {
      throw new Error('webContents destroyed mid-send');
    });
    const win = makeFakeWindow({ webContentsSend: send });
    vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([win as unknown as ReturnType<typeof electronMock.BrowserWindow.getAllWindows>[number]] as unknown as ReturnType<typeof electronMock.BrowserWindow.getAllWindows>);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => fireClickFor('alpha')).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
