// Phase 9 Plan 2: NetworkSettingsModal.
//
// Mirrors VaultGlobalSettingsModal's shape. Three fields:
//   - port         (number 1..65535)
//   - bindMode     (radio: localhost / lan)
//   - updateChannel (radio: latest / beta / nightly — disabled in v1)
//
// On save the action routes through `networkActions.setConfig` which
// proxies to `network/set_config` in main. Main triggers a rebind on
// bindMode/port change and broadcasts EVENT_NETWORK_CONFIG_UPDATED on
// success. A rebind failure surfaces inline as `rebindError`.

import { useEffect, useState } from 'react';
import { AppModal } from './AppModal';
import { networkActions, useNetworkConfig } from '../state/network';
import type { NetworkConfig } from '../../shared/types';

export interface NetworkSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function NetworkSettingsModal({ open, onClose }: NetworkSettingsModalProps) {
  const { config, loading, error } = useNetworkConfig();
  const [port, setPort] = useState<number>(7878);
  const [bindMode, setBindMode] = useState<'localhost' | 'lan'>('localhost');
  const [updateChannel, setUpdateChannel] =
    useState<'latest' | 'beta' | 'nightly'>('latest');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [rebindError, setRebindError] = useState<string | null>(null);

  // Hydrate from the persisted config when it lands.
  useEffect(() => {
    if (!config) return;
    if (Number.isInteger(config.port) && config.port >= 1 && config.port <= 65535) {
      setPort(config.port);
    }
    if (config.bindMode === 'localhost' || config.bindMode === 'lan') {
      setBindMode(config.bindMode);
    }
    if (
      config.updateChannel === 'latest' ||
      config.updateChannel === 'beta' ||
      config.updateChannel === 'nightly'
    ) {
      setUpdateChannel(config.updateChannel);
    }
  }, [config]);

  // Reset transient save state when the modal opens.
  useEffect(() => {
    if (open) {
      setSaving(false);
      setSaveError(null);
      setRebindError(null);
    }
  }, [open]);

  const portValid =
    Number.isInteger(port) && port >= 1 && port <= 65535;
  const canSave = !saving && !loading && portValid;

  const onSave = async () => {
    setSaveError(null);
    setRebindError(null);
    if (!portValid) {
      setSaveError('Port must be an integer between 1 and 65535.');
      return;
    }
    setSaving(true);
    try {
      const next: NetworkConfig = { port, bindMode, updateChannel };
      const res = await networkActions.setConfig(next);
      if (!res.ok) {
        const err = res.error ?? 'Failed to save network settings';
        if (err.startsWith('rebind_failed:')) {
          setRebindError(err.slice('rebind_failed:'.length));
        } else {
          setSaveError(err);
        }
        return;
      }
      onClose();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppModal
      title="Network settings"
      onClose={onClose}
      cardClassName="network-settings-modal"
      ariaLabel="Network settings"
      zIndex={1200}
    >
      <div className="network-settings-modal-body">
        <section className="form-section">
          <label className="form-label" htmlFor="network-settings-port">
            Port
          </label>
          <input
            id="network-settings-port"
            type="number"
            min={1}
            max={65535}
            className="modal-input"
            value={port}
            onChange={(e) => setPort(parseInt(e.target.value, 10) || 0)}
            data-testid="network-settings-port"
            autoFocus
          />
          <small className="form-hint">
            TCP port the HTTP + WebSocket server binds on.
          </small>
        </section>

        <section className="form-section">
          <span className="form-label">Bind mode</span>
          <div className="radio-group">
            <label className="form-radio">
              <input
                type="radio"
                name="bindMode"
                value="localhost"
                checked={bindMode === 'localhost'}
                onChange={() => setBindMode('localhost')}
                data-testid="network-settings-bind-localhost"
              />
              <span>Localhost (127.0.0.1)</span>
            </label>
            <label className="form-radio">
              <input
                type="radio"
                name="bindMode"
                value="lan"
                checked={bindMode === 'lan'}
                onChange={() => setBindMode('lan')}
                data-testid="network-settings-bind-lan"
              />
              <span>LAN (0.0.0.0)</span>
            </label>
          </div>
          <small className="form-hint">
            LAN exposes the server to everyone on your network; consider
            Tailscale ACLs for cross-network access.
          </small>
        </section>

        <section className="form-section">
          <span className="form-label">Update channel</span>
          <div className="radio-group">
            {(['latest', 'beta', 'nightly'] as const).map((ch) => (
              <label key={ch} className="form-radio">
                <input
                  type="radio"
                  name="updateChannel"
                  value={ch}
                  checked={updateChannel === ch}
                  onChange={() => setUpdateChannel(ch)}
                  disabled
                  data-testid={`network-settings-channel-${ch}`}
                />
                <span>{ch}</span>
              </label>
            ))}
          </div>
          <small className="form-hint">
            Changing the update channel requires restarting Localbot to take
            effect (Pitfall 6 mitigation).
          </small>
          <div className="form-actions" style={{ marginTop: '0.5rem' }}>
            <button
              type="button"
              className="modal-button secondary"
              onClick={() => {
                void window.localbot?.network.checkForUpdate();
              }}
              data-testid="network-settings-check-update"
            >
              Check for updates
            </button>
          </div>
        </section>

        {error && !saveError && !rebindError && (
          <div className="modal-error" role="alert" data-testid="network-settings-load-error">
            {error}
          </div>
        )}
        {saveError && (
          <div className="modal-error" role="alert" data-testid="network-settings-save-error">
            {saveError}
          </div>
        )}
        {rebindError && (
          <div className="modal-error" role="alert" data-testid="network-settings-rebind-error">
            Rebind failed: {rebindError}. Old server kept alive.
          </div>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="modal-button secondary"
            onClick={onClose}
            disabled={saving}
            data-testid="network-settings-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="modal-button primary"
            onClick={() => void onSave()}
            disabled={!canSave}
            data-testid="network-settings-save"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </AppModal>
  );
}