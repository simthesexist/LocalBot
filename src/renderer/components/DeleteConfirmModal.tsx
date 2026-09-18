// DeleteConfirmModal — AGENT-02 typed-name confirmation. Phase 4 Wave 1.
//
// The user must type the bot's exact name (trimmed equality) before the
// destructive submit button enables. Per T-P4-09, the match is
// `typed.trim() === bot.name.trim()` so a stray space-padded match is
// rejected. The actual deletion routes through window.localbot.bot.delete
// (which lands on the daemon's bots/delete JSON-RPC method via main).

import { useState } from 'react';
import { AppModal } from './AppModal';
import type { BotConfig } from '../../shared/types';

export interface DeleteConfirmModalProps {
  bot: BotConfig;
  onClose: () => void;
  onDeleted: () => void;
}

export function DeleteConfirmModal({ bot, onClose, onDeleted }: DeleteConfirmModalProps) {
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = typed.trim() === bot.name.trim() && bot.name.trim().length > 0;
  const submit = async () => {
    if (!matches) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = (await window.localbot.bot.delete({ bot: bot.id })) as {
        ok: boolean;
        error?: string;
      };
      if (!result.ok) {
        setError(result.error ?? 'Failed to delete bot');
        return;
      }
      onDeleted();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppModal
      title={`Delete "${bot.name}"`}
      onClose={onClose}
      cardClassName="delete-confirm-modal"
      ariaLabel="Confirm bot deletion"
      zIndex={1100}
    >
      <p className="modal-body">
        This permanently removes the bot&apos;s folder, sessions, and run history. This action
        cannot be undone.
      </p>
      <label className="form-label">
        Type <code>{bot.name}</code> to confirm
        <input
          type="text"
          className="modal-input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
          data-testid="delete-confirm-input"
        />
      </label>

      {error && (
        <div className="modal-error" role="alert" data-testid="delete-confirm-error">
          {error}
        </div>
      )}

      <div className="modal-actions">
        <button
          type="button"
          className="modal-button secondary"
          onClick={onClose}
          disabled={submitting}
          data-testid="delete-confirm-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          className="modal-button destructive"
          onClick={() => void submit()}
          disabled={!matches || submitting}
          data-testid="delete-confirm-submit"
        >
          {submitting ? 'Deleting…' : 'Delete bot'}
        </button>
      </div>
    </AppModal>
  );
}
