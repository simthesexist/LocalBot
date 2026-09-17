// First-launch blocking modal for API key onboarding.

import { useState } from 'react';

export interface KeyModalProps {
  onSaved: () => void;
}

export function KeyModal({ onSaved }: KeyModalProps) {
  const [key, setKey] = useState('');
  const [probeState, setProbeState] = useState<'idle' | 'probing' | 'ok' | 'error'>('idle');
  const [probeError, setProbeError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onTest = async () => {
    if (!key.trim()) return;
    setProbeState('probing');
    setProbeError(null);
    try {
      const result = await window.localbot.key.probe(key);
      if (result.ok) {
        setProbeState('ok');
      } else {
        setProbeState('error');
        setProbeError(result.error ?? 'Probe failed');
      }
    } catch (err: any) {
      setProbeState('error');
      setProbeError(err?.message ?? 'Probe failed');
    }
  };

  const onSave = async () => {
    if (probeState !== 'ok') return;
    setSaving(true);
    try {
      const result = await window.localbot.key.set(key);
      if (result.ok) {
        onSaved();
      } else {
        setProbeState('error');
        setProbeError(result.error ?? 'Save failed');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" data-testid="key-modal">
      <div className="modal-card">
        <h1 className="modal-title">Welcome to Localbot</h1>
        <p className="modal-body">
          Enter your MiniMax API key to start. Your key is encrypted and stored via your operating
          system's secure storage — it never leaves this machine.
        </p>

        <input
          type="password"
          className="modal-input"
          placeholder="M3 API key"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setProbeState('idle');
            setProbeError(null);
          }}
          data-testid="key-input"
          autoFocus
        />

        <div className="modal-probe-row">
          <button
            type="button"
            className="modal-button secondary"
            onClick={onTest}
            disabled={!key.trim() || probeState === 'probing'}
            data-testid="probe-button"
          >
            {probeState === 'probing' ? 'Testing…' : 'Test connection'}
          </button>
          {probeState === 'ok' && <span className="modal-probe-ok">OK</span>}
          {probeState === 'error' && (
            <span className="modal-probe-error">{probeError ?? 'Failed'}</span>
          )}
        </div>

        <div className="modal-actions">
          <a
            className="modal-link"
            href="https://MiniMax.io/m3/apikeys"
            target="_blank"
            rel="noopener noreferrer"
          >
            Get API key
          </a>
          <button
            type="button"
            className="modal-button primary"
            onClick={onSave}
            disabled={probeState !== 'ok' || saving}
            data-testid="save-button"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
