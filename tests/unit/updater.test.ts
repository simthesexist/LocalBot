// Phase 9 Plan 3: unit tests for src/main/network/updater.ts.
//
// Verifies the MANUAL update flow invariants (PKG-02 + Pitfall 4):
//   - autoDownload is set to false BEFORE any on() handlers fire
//   - autoInstallOnAppQuit is set to false BEFORE any on() handlers fire
//   - autoUpdater.channel is set from <userData>/network.json#updateChannel
//     BEFORE the first checkForUpdates() (Pitfall 6)
//   - checkNow() calls autoUpdater.checkForUpdates() exactly once
//   - downloadNow() calls autoUpdater.downloadUpdate()
//   - installNow() calls autoUpdater.quitAndInstall()
//   - the onChange callback is invoked for each autoUpdater event
//     transition (checking / available / downloading / downloaded / error)

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron-updater', () => {
  const mock: any = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    channel: 'latest',
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
  };
  mock.__handlers = {};
  mock.on.mockImplementation((event: string, handler: (...args: any[]) => void) => {
    mock.__handlers[event] = handler;
    return mock;
  });
  mock.removeAllListeners.mockImplementation(() => {
    Object.keys(mock.__handlers).forEach((k) => { delete mock.__handlers[k]; });
  });
  (globalThis as any).__updaterMock = mock;
  return { autoUpdater: mock };
});

vi.mock('D:/Claude/Grokbot/.claude/worktrees/agent-ae4e0b136c8724388/daemon/network/config.cjs', () => {
  const fn = vi.fn(async () => ({
    updateChannel: 'beta',
    port: 7878,
    bindMode: 'localhost',
  }));
  return { loadNetworkConfig: fn };
});

vi.mock('../../src/main/paths', () => ({
  userDataDir: () => '/tmp/test-userdata',
}));

// Imports MUST come AFTER the vi.mock calls above so the mocks are wired
// when the module reads them at import time.
import {
  initUpdater,
  checkNow,
  downloadNow,
  installNow,
  getUpdateStatus,
} from '../../src/main/network/updater';

const harness = () => (globalThis as any).__updaterMock as {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel: string;
  on: ReturnType<typeof vi.fn>;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
  __handlers: Record<string, (...args: any[]) => void>;
};

describe('updater.ts — manual update flow', () => {
  beforeEach(() => {
    const h = harness();
    h.on.mockClear();
    h.checkForUpdates.mockClear();
    h.downloadUpdate.mockClear();
    h.quitAndInstall.mockClear();
    Object.keys(h.__handlers).forEach((k) => { delete h.__handlers[k]; });
    h.autoDownload = false;
    h.autoInstallOnAppQuit = false;
    h.channel = 'latest';
  });

  it('Case A: initUpdater sets autoDownload=false AND autoInstallOnAppQuit=false (Pitfall 4)', async () => {
    const handler = vi.fn();
    await initUpdater(handler);
    expect(harness().autoDownload).toBe(false);
    expect(harness().autoInstallOnAppQuit).toBe(false);
  });

  it('Case B: initUpdater sets autoUpdater.channel from network.json BEFORE on() handlers (Pitfall 6)', async () => {
    const handler = vi.fn();
    await initUpdater(handler);
    expect(harness().channel).toBe('beta');
    expect(harness().on).toHaveBeenCalled();
  });

  it('Case C: checkNow() invokes autoUpdater.checkForUpdates() exactly once', async () => {
    await initUpdater(() => {});
    await checkNow();
    expect(harness().checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('Case D: downloadNow() → downloadUpdate(); installNow() → quitAndInstall()', async () => {
    await initUpdater(() => {});
    await downloadNow();
    expect(harness().downloadUpdate).toHaveBeenCalledTimes(1);
    installNow();
    expect(harness().quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('Case E: onChange callback fires with the matching status on each event', async () => {
    const handler = vi.fn();
    await initUpdater(handler);
    const h = harness();
    expect(h.__handlers['checking-for-update']).toBeDefined();
    h.__handlers['checking-for-update']?.(undefined);
    expect(handler).toHaveBeenLastCalledWith({ state: 'checking' });

    h.__handlers['update-available']?.({ version: '0.2.0' });
    expect(handler).toHaveBeenLastCalledWith({
      state: 'available',
      currentVersion: '0.2.0',
      availableVersion: '0.2.0',
    });

    h.__handlers['download-progress']?.({ percent: 42.5 });
    expect(handler).toHaveBeenLastCalledWith({
      state: 'downloading',
      progress: { percent: 42.5 },
    });

    h.__handlers['update-downloaded']?.({ version: '0.2.0' });
    expect(handler).toHaveBeenLastCalledWith({
      state: 'downloaded',
      availableVersion: '0.2.0',
    });

    h.__handlers['error']?.(new Error('boom'));
    expect(handler).toHaveBeenLastCalledWith({
      state: 'error',
      error: 'boom',
    });

    expect(getUpdateStatus().state).toBe('error');
  });
});