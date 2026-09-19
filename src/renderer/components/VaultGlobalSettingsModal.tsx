// Phase 7 Plan 3: global Obsidian vault settings modal.
//
// Reached from the top-bar Vault button. Wraps AppModal primitive (escape
// close, click-outside close, focus trap). Two fields mirror the
// persisted `<userData>/vault.json` shape:
//   - rootPath:    absolute path to the Obsidian vault on disk (required)
//   - globalDeny:  newline-delimited picomatch globs applied to every bot
//
// Save validates rootPath non-empty BEFORE calling the IPC bridge so the
// user gets an inline error rather than a daemon-side rejection. On save
// success the modal closes; on save error the error surfaces inline.

import { useEffect, useState } from 'react';
import { AppModal } from './AppModal';
import { useVaultConfig, vaultActions } from '../state/vault';
import type { VaultGlobalConfig } from '../../shared/types';

export interface VaultGlobalSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

function parseGlobList(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function joinGlobList(globs: string[] | undefined): string {
  return Array.isArray(globs) ? globs.join('\n') : '';
}

export function VaultGlobalSettingsModal({ open, onClose }: VaultGlobalSettingsModalProps) {
  const { config, loading, error } = useVaultConfig();
  const [rootPath, setRootPath] = useState<string>('');
  const [globalDenyText, setGlobalDenyText] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Hydrate the form once the daemon-supplied config lands. We only
  // hydrate when the field is currently empty so a user mid-edit doesn't
  // see their input clobbered by an EVENT_VAULT_CONFIG_UPDATED bounce.
  useEffect(() => {
    if (!config) return;
    if (!rootPath && typeof config.rootPath === 'string') {
      setRootPath(config.rootPath);
    }
    if (!globalDenyText && Array.isArray(config.globalDeny)) {
      setGlobalDenyText(joinGlobList(config.globalDeny));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // Reset transient save state whenever the modal opens fresh.
  useEffect(() => {
    if (open) {
      setSaving(false);
      setSaveError(null);
    }
  }, [open]);

  const trimmedRoot = rootPath.trim();
  const canSave = !saving && !loading && trimmedRoot.length > 0;

  const onSave = async () => {
    setSaveError(null);
    if (trimmedRoot.length === 0) {
      setSaveError('Vault root path is required.');
      return;
    }
    setSaving(true);
    try {
      const next: VaultGlobalConfig = {
        rootPath: trimmedRoot,
        globalDeny: parseGlobList(globalDenyText),
      };
      const res = await vaultActions.setConfig(next);
      if (!res.ok) {
        setSaveError(res.error ?? 'Failed to save vault settings');
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
      title="Obsidian vault settings"
      onClose={onClose}
      cardClassName="vault-global-modal"
      ariaLabel="Global Obsidian vault settings"
      zIndex={1200}
    >
      <div className="vault-global-modal-body">
        <section className="form-section">
          <label className="form-label" htmlFor="vault-global-rootpath">
            Global vault root path
          </label>
          <input
            id="vault-global-rootpath"
            type="text"
            className="modal-input"
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            placeholder="C:/Users/you/Documents/Vault"
            data-testid="vault-global-rootpath"
            autoFocus
          />
          <small className="form-hint">
            Absolute path to your Obsidian vault. Per-bot vault paths
            (Bot Settings → Obsidian) override this.
          </small>
        </section>

        <section className="form-section">
          <label className="form-label" htmlFor="vault-global-deny">
            Global deny globs (vault-relative, one per line)
          </label>
          <textarea
            id="vault-global-deny"
            className="modal-input obsidian-glob-textarea"
            value={globalDenyText}
            onChange={(e) => setGlobalDenyText(e.target.value)}
            rows={5}
            placeholder={'Private/**\nCredentials/**'}
            data-testid="vault-global-deny"
          />
          <small className="form-hint">
            Evaluated BEFORE every bot&apos;s allow / deny. A path
            matching any of these globs is invisible to all bots, even
            if their per-bot allow list permits it.
          </small>
        </section>

        {error && !saveError && (
          <div className="modal-error" role="alert" data-testid="vault-global-load-error">
            {error}
          </div>
        )}
        {saveError && (
          <div className="modal-error" role="alert" data-testid="vault-global-save-error">
            {saveError}
          </div>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="modal-button secondary"
            onClick={onClose}
            disabled={saving}
            data-testid="vault-global-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="modal-button primary"
            onClick={() => void onSave()}
            disabled={!canSave}
            data-testid="vault-global-save"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </AppModal>
  );
}