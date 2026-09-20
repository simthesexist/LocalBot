// Phase 9 Plan 3: UpdateToast.
//
// Renders a fixed bottom-right toast with state-aware UI for the
// electron-updater manual flow. Subscribes to 'network:update:status'
// (EVENT_UPDATE_STATUS_CHANGED) which main broadcasts from initUpdater's
// onChange callback on every autoUpdater event transition.
//
// The toast NEVER auto-dismisses; the user must explicitly click the
// action button (Download / Install & Restart / Dismiss). idle state
// renders nothing (so the toast disappears between checks).

import { useEffect, useState } from 'react';
import type { UpdateStatusEvent } from '../../shared/types';

export function UpdateToast(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatusEvent | null>(null);

  useEffect(() => {
    const localbot = (window as Window & {
      localbot?: {
        on: (channel: string, handler: (payload: UpdateStatusEvent) => void) => () => void;
        network: {
          checkForUpdate: () => Promise<{ ok: boolean; error?: string }>;
          downloadUpdate: () => Promise<{ ok: boolean; error?: string }>;
          installUpdate: () => Promise<{ ok: boolean; error?: string }>;
        };
      };
    }).localbot;
    if (!localbot) return;
    const off = localbot.on('network:update:status', (payload) => {
      setStatus(payload);
    });
    return off;
  }, []);

  if (!status || status.state === 'idle') return null;

  const dismiss = () => setStatus(null);

  const onDownload = async () => {
    const localbot = (window as Window & {
      localbot?: { network: { downloadUpdate: () => Promise<{ ok: boolean; error?: string }> } };
    }).localbot;
    if (!localbot) return;
    await localbot.network.downloadUpdate();
  };

  const onInstall = async () => {
    const localbot = (window as Window & {
      localbot?: { network: { installUpdate: () => Promise<{ ok: boolean; error?: string }> } };
    }).localbot;
    if (!localbot) return;
    await localbot.network.installUpdate();
  };

  return (
    <div className="update-toast" data-testid={`update-toast-${status.state}`} role="status">
      {status.state === 'checking' && (
        <div>Checking for updates…</div>
      )}
      {status.state === 'available' && (
        <>
          <div>Update available — v{status.availableVersion}</div>
          <button type="button" onClick={() => void onDownload()} data-testid="update-toast-download">
            Download
          </button>
          <button type="button" onClick={dismiss} data-testid="update-toast-dismiss">
            Dismiss
          </button>
        </>
      )}
      {status.state === 'downloading' && (
        <>
          <div>Downloading{status.progress ? ` ${Math.round(status.progress.percent)}%` : ''}…</div>
          <div className="progress" data-testid="update-toast-progress">
            <div
              className="progress-bar"
              style={{ width: `${Math.max(0, Math.min(100, status.progress?.percent ?? 0))}%` }}
            />
          </div>
          <button type="button" onClick={dismiss} data-testid="update-toast-dismiss">
            Dismiss
          </button>
        </>
      )}
      {status.state === 'downloaded' && (
        <>
          <div>Downloaded v{status.availableVersion} — restart to apply</div>
          <button type="button" onClick={() => void onInstall()} data-testid="update-toast-install">
            Install & Restart
          </button>
          <button type="button" onClick={dismiss} data-testid="update-toast-dismiss">
            Later
          </button>
        </>
      )}
      {status.state === 'error' && (
        <>
          <div>Update error: {status.error ?? 'unknown'}</div>
          <button type="button" onClick={dismiss} data-testid="update-toast-dismiss">
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}