// Phase 9 Plan 3: electron-updater integration.
//
// MANUAL update flow (PKG-02; RESEARCH §Pattern 4):
//   - autoDownload = false → the user clicks Download explicitly
//   - autoInstallOnAppQuit = false → the user clicks Install & Restart
//   - channel is set FROM <userData>/network.json#updateChannel at startup,
//     BEFORE the first checkForUpdates() (Pitfall 6: channel-mismatch
//     otherwise auto-selects 'latest' and the user has no way to switch).
//   - status changes broadcast via the onChange callback so the renderer's
//     UpdateToast renders the matching UI per state (checking / available
//     with Download button / downloaded with Install & Restart button /
//     downloading progress / error dismiss).

import { autoUpdater } from 'electron-updater';
import { loadNetworkConfig } from '../../daemon/network/config.cjs';
import { userDataDir } from '../paths';
import type { UpdateStatusEvent } from '../../shared/types';

let status: UpdateStatusEvent = { state: 'idle' };
let initialized = false;

export function getUpdateStatus(): UpdateStatusEvent {
  return status;
}

export async function initUpdater(
  onChange: (s: UpdateStatusEvent) => void,
): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    const cfg = await loadNetworkConfig(userDataDir());
    // Pitfall 6: set channel BEFORE first checkForUpdates() so the user's
    // persisted choice (latest / beta / nightly) is honored on the very
    // first check. Mid-session channel changes require an app restart
    // (the renderer surfaces this hint in NetworkSettingsModal).
    autoUpdater.channel = cfg.updateChannel;
  } catch {
    autoUpdater.channel = 'latest';
  }

  // PKG-02 / Pitfall 4: MANUAL flow only. The user always clicks Download
  // and Install & Restart explicitly — never silently auto-update.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    status = { state: 'checking' };
    onChange(status);
  });
  autoUpdater.on('update-available', (info: { version: string }) => {
    status = { state: 'available', currentVersion: info.version, availableVersion: info.version };
    onChange(status);
  });
  autoUpdater.on('download-progress', (p: { percent: number }) => {
    status = { state: 'downloading', progress: { percent: p.percent } };
    onChange(status);
  });
  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    status = { state: 'downloaded', availableVersion: info.version };
    onChange(status);
  });
  autoUpdater.on('error', (err: Error) => {
    status = { state: 'error', error: err.message };
    onChange(status);
  });
}

export async function checkNow(): Promise<void> {
  await autoUpdater.checkForUpdates();
}

export async function downloadNow(): Promise<void> {
  await autoUpdater.downloadUpdate();
}

export function installNow(): void {
  autoUpdater.quitAndInstall();
}