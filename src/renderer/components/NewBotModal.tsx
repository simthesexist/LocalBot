// NewBotModal — AGENT-01 form-driven bot creation. Phase 4 Wave 1.
//
// Collects name (required), persona (textarea), workspace (text),
// allowlist (checkboxes), cron (string), cronEnabled (checkbox).
// Submits via window.localbot.bot.create(). The id is auto-derived
// from the name by the daemon's deriveSlug helper — the renderer does
// not expose id editing (per UI-SPEC §5.1 / plan prohibition).
//
// The checkbox list is sourced from a hardcoded Phase 2 tool name set
// because Phase 2 has no `tools:list` IPC; the daemon's allowlist loader
// will silently accept any allowlisted tool name so the form is forward-
// compatible when Wave 2 adds the dynamic registry query.

import { useState } from 'react';
import { AppModal } from './AppModal';
import type { BotConfig } from '../../shared/types';

export interface NewBotModalProps {
  onClose: () => void;
  onCreated: (bot: BotConfig) => void;
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

const DEFAULT_ALLOWLIST = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'code_search',
  'memory.update',
];

export function NewBotModal({ onClose, onCreated }: NewBotModalProps) {
  const [name, setName] = useState('');
  const [persona, setPersona] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [allowlist, setAllowlist] = useState<string[]>(DEFAULT_ALLOWLIST);
  const [cron, setCron] = useState('');
  const [cronEnabled, setCronEnabled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleTool = (toolName: string) => {
    setAllowlist((prev) =>
      prev.includes(toolName) ? prev.filter((t) => t !== toolName) : [...prev, toolName],
    );
  };

  const submit = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = (await window.localbot.bot.create({
        name: name.trim(),
        persona,
        workspace: workspace.trim(),
        allowlist,
        ...(cron.trim() ? { cron: cron.trim() } : {}),
        cronEnabled,
      })) as { ok: boolean; bot?: BotConfig; error?: string };
      if (!result.ok) {
        setError(result.error ?? 'Failed to create bot');
        return;
      }
      if (result.bot) onCreated(result.bot);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppModal
      title="New bot"
      onClose={onClose}
      cardClassName="new-bot-modal"
      ariaLabel="Create a new bot"
      zIndex={1000}
    >
      <form
        className="new-bot-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="form-label">
          Name
          <input
            type="text"
            className="modal-input"
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
            data-testid="new-bot-name"
            autoFocus
            required
          />
        </label>

        <label className="form-label">
          Persona
          <textarea
            className="modal-input"
            value={persona}
            maxLength={4096}
            rows={4}
            onChange={(e) => setPersona(e.target.value)}
            data-testid="new-bot-persona"
            placeholder="What is this bot's role? What tone does it use?"
          />
        </label>

        <label className="form-label">
          Workspace
          <input
            type="text"
            className="modal-input"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            data-testid="new-bot-workspace"
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
                data-testid={`new-bot-tool-${t.name}`}
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
            data-testid="new-bot-cron"
            placeholder="e.g. 0 9 * * 1-5 (Phase 6 wires the scheduler)"
          />
        </label>

        <label className="form-checkbox">
          <input
            type="checkbox"
            checked={cronEnabled}
            onChange={(e) => setCronEnabled(e.target.checked)}
            data-testid="new-bot-cron-enabled"
          />
          <span>Enable cron (Phase 6)</span>
        </label>

        {error && (
          <div className="modal-error" role="alert" data-testid="new-bot-error">
            {error}
          </div>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="modal-button secondary"
            onClick={onClose}
            disabled={submitting}
            data-testid="new-bot-cancel"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="modal-button primary"
            disabled={submitting || !name.trim()}
            data-testid="new-bot-submit"
          >
            {submitting ? 'Creating…' : 'Create bot'}
          </button>
        </div>
      </form>
    </AppModal>
  );
}
