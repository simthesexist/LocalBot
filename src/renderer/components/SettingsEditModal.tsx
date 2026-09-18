// SettingsEditModal — AGENT-04 settings edit form. Phase 4 Wave 2.
//
// Lets the user edit persona, workspace, allowlist, cron, cronEnabled
// for an existing bot. Submits via window.localbot.bot.update. Wave 2
// uses an explicit Save button (debounced autosave on blur is deferred
// per the AGENT-04 contract).

import { useState } from 'react';
import { AppModal } from './AppModal';
import type { BotConfig } from '../../shared/types';

export interface SettingsEditModalProps {
  bot: BotConfig;
  onClose: () => void;
  onUpdated: (bot: BotConfig) => void;
}

const TOOL_OPTIONS: Array<{ name: string; label: string; informational?: boolean }> = [
  { name: 'read_file', label: 'read_file' },
  { name: 'write_file', label: 'write_file' },
  { name: 'edit_file', label: 'edit_file' },
  { name: 'list_dir', label: 'list_dir' },
  { name: 'code_search', label: 'code_search' },
  { name: 'memory.update', label: 'memory.update' },
  { name: 'tree.list', label: 'tree.list (system-only)', informational: true },
];

export function SettingsEditModal({ bot, onClose, onUpdated }: SettingsEditModalProps) {
  const [persona, setPersona] = useState(bot.persona || '');
  const [workspace, setWorkspace] = useState(bot.workspace || '');
  const [allowlist, setAllowlist] = useState<string[]>(
    Array.isArray(bot.allowlist) ? [...bot.allowlist] : [],
  );
  const [cron, setCron] = useState(bot.cron || '');
  const [cronEnabled, setCronEnabled] = useState(Boolean(bot.cronEnabled));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleTool = (toolName: string) => {
    setAllowlist((prev) =>
      prev.includes(toolName) ? prev.filter((t) => t !== toolName) : [...prev, toolName],
    );
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {
        persona,
        workspace: workspace.trim(),
        allowlist,
        cronEnabled,
      };
      if (cron.trim()) patch.cron = cron.trim();

      const result = (await window.localbot.bot.update({ bot: bot.id, patch })) as {
        ok: boolean; bot?: BotConfig; error?: string;
      };
      if (!result.ok) {
        setError(result.error ?? 'Failed to update bot');
        return;
      }
      if (result.bot) onUpdated(result.bot);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppModal
      title={`Edit "${bot.name}"`}
      onClose={onClose}
      cardClassName="settings-edit-modal"
      ariaLabel="Edit bot settings"
      zIndex={1050}
    >
      <form
        className="settings-edit-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="form-label">
          Persona
          <textarea
            className="modal-input"
            value={persona}
            maxLength={4096}
            rows={4}
            onChange={(e) => setPersona(e.target.value)}
            data-testid="settings-persona"
          />
        </label>

        <label className="form-label">
          Workspace
          <input
            type="text"
            className="modal-input"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            data-testid="settings-workspace"
            placeholder="D:\\projects\\myproject (absolute path)"
          />
        </label>

        <fieldset className="form-fieldset">
          <legend>Allowed tools</legend>
          {TOOL_OPTIONS.map((t) => (
            <label key={t.name} className="form-checkbox">
              <input
                type="checkbox"
                checked={allowlist.includes(t.name)}
                onChange={() => toggleTool(t.name)}
                disabled={t.informational}
                data-testid={`settings-tool-${t.name}`}
              />
              <span>{t.label}</span>
            </label>
          ))}
        </fieldset>

        <label className="form-label">
          Cron expression (optional)
          <input
            type="text"
            className="modal-input"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            data-testid="settings-cron"
            placeholder="e.g. 0 9 * * 1-5 (Phase 6 wires the scheduler)"
          />
        </label>

        <label className="form-checkbox">
          <input
            type="checkbox"
            checked={cronEnabled}
            onChange={(e) => setCronEnabled(e.target.checked)}
            data-testid="settings-cron-enabled"
          />
          <span>Enable cron (Phase 6)</span>
        </label>

        {error && (
          <div className="modal-error" role="alert" data-testid="settings-error">
            {error}
          </div>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="modal-button secondary"
            onClick={onClose}
            disabled={submitting}
            data-testid="settings-cancel"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="modal-button primary"
            disabled={submitting}
            data-testid="settings-save"
          >
            {submitting ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </AppModal>
  );
}
