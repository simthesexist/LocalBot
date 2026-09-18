// Phase 4 Wave 3: BotSettingsPage — full settings page with 4 tabs.
// Replaces Wave 2's SettingsEditModal for the primary edit flow; the
// modal component stays around for reuse but no longer mounted.
//
// URL hash sync via window.location.hash: '#/bot/<id>/settings/<tab>'.
// Tab keyboard nav with ArrowLeft/ArrowRight + per-tab submit-on-blur
// that calls bots:update with a per-tab patch. Esc and the X button
// close the page.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotConfig } from '../../shared/types';
import { RunHistoryTable } from './RunHistoryTable';

export interface BotSettingsPageProps {
  bot: BotConfig;
  onClose: () => void;
  onUpdated: (bot: BotConfig) => void;
}

type TabId = 'general' | 'permissions' | 'schedule' | 'history';
const TAB_IDS: TabId[] = ['general', 'permissions', 'schedule', 'history'];
const TAB_LABELS: Record<TabId, string> = {
  general: 'General',
  permissions: 'Permissions',
  schedule: 'Schedule',
  history: 'Run History',
};

const TOOL_OPTIONS: Array<{ name: string; label: string }> = [
  { name: 'read_file', label: 'read_file' },
  { name: 'write_file', label: 'write_file' },
  { name: 'edit_file', label: 'edit_file' },
  { name: 'list_dir', label: 'list_dir' },
  { name: 'code_search', label: 'code_search' },
  { name: 'memory.update', label: 'memory.update' },
];

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

function parseTabFromHash(hash: string, botId: string): TabId {
  // #/bot/<id>/settings/<tab>
  const expected = `#/bot/${botId}/settings/`;
  if (hash.startsWith(expected)) {
    const candidate = hash.slice(expected.length).trim();
    if ((TAB_IDS as string[]).includes(candidate)) {
      return candidate as TabId;
    }
  }
  return 'general';
}

export function BotSettingsPage({ bot, onClose, onUpdated }: BotSettingsPageProps) {
  const initialTab = useMemo<TabId>(
    () => (typeof window !== 'undefined' ? parseTabFromHash(window.location.hash, bot.id) : 'general'),
    [bot.id],
  );
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const [name, setName] = useState(bot.name || '');
  const [persona, setPersona] = useState(bot.persona || '');
  const [workspace, setWorkspace] = useState(bot.workspace || '');
  const [allowlist, setAllowlist] = useState<string[]>(
    Array.isArray(bot.allowlist) ? [...bot.allowlist] : [],
  );
  const [cron, setCron] = useState(bot.cron || '');
  const [cronEnabled, setCronEnabled] = useState(Boolean(bot.cronEnabled));
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // URL hash sync — push on tab change; restore on popstate.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const desired = `#/bot/${bot.id}/settings/${activeTab}`;
    if (window.location.hash !== desired) {
      window.history.replaceState(null, '', desired);
    }
    const onPop = () => {
      const next = parseTabFromHash(window.location.hash, bot.id);
      setActiveTab(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [activeTab, bot.id]);

  // Esc closes the page.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Auto-clear save indicator after 1.5s.
  useEffect(() => {
    if (saveStatus !== 'saved' && saveStatus !== 'error') return;
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => {
      setSaveStatus('idle');
      setSaveError(null);
    }, 1500);
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, [saveStatus]);

  const persistPatch = useCallback(
    async (patch: Record<string, unknown>) => {
      setSaveStatus('saving');
      setSaveError(null);
      try {
        if (!window.localbot) throw new Error('localbot not available');
        const res = (await window.localbot.bot.update({ bot: bot.id, patch })) as {
          ok: boolean; bot?: BotConfig; error?: string;
        };
        if (!res.ok) {
          setSaveStatus('error');
          setSaveError(res.error ?? 'failed to update');
          return;
        }
        if (res.bot) onUpdated(res.bot);
        setSaveStatus('saved');
      } catch (e) {
        setSaveStatus('error');
        setSaveError((e as Error).message);
      }
    },
    [bot.id, onUpdated],
  );

  // Per-tab blur handlers (debounced 250ms per T-P4-25).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleGeneralSave = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void persistPatch({
        name: name.trim() || bot.name,
        persona,
        workspace: workspace.trim(),
      });
    }, 250);
  };

  const schedulePermissionsSave = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void persistPatch({ allowlist });
    }, 250);
  };

  const scheduleScheduleSave = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const patch: Record<string, unknown> = { cronEnabled };
      if (cron.trim()) patch.cron = cron.trim();
      else patch.cron = '';
      void persistPatch(patch);
    }, 250);
  };

  const toggleTool = (toolName: string) => {
    setAllowlist((prev) =>
      prev.includes(toolName) ? prev.filter((t) => t !== toolName) : [...prev, toolName],
    );
  };

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const next = (idx + 1) % TAB_IDS.length;
      setActiveTab(TAB_IDS[next]);
      const nextEl = document.querySelector<HTMLButtonElement>(
        `[data-tab-id="${TAB_IDS[next]}"]`,
      );
      nextEl?.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = (idx - 1 + TAB_IDS.length) % TAB_IDS.length;
      setActiveTab(TAB_IDS[prev]);
      const prevEl = document.querySelector<HTMLButtonElement>(
        `[data-tab-id="${TAB_IDS[prev]}"]`,
      );
      prevEl?.focus();
    }
  };

  return (
    <div className="bot-settings-page" data-testid="bot-settings-page" role="dialog" aria-label={`Settings for ${bot.name}`}>
      <header className="bot-settings-header">
        <div className="bot-settings-title-row">
          <h1 className="bot-settings-title">{bot.name}</h1>
          <button
            type="button"
            className="bot-settings-close"
            aria-label="Close settings"
            data-testid="bot-settings-close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="bot-settings-status" data-status={saveStatus} role="status">
          {saveStatus === 'saving' && 'Saving…'}
          {saveStatus === 'saved' && 'Saved'}
          {saveStatus === 'error' && `Error: ${saveError ?? 'failed to save'}`}
        </div>
      </header>

      <div className="bot-settings-tabs" role="tablist">
        {TAB_IDS.map((id, idx) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-tab-id={id}
            aria-selected={activeTab === id}
            data-active={activeTab === id}
            data-testid={`bot-settings-tab-${id}`}
            className="bot-settings-tab"
            onClick={() => setActiveTab(id)}
            onKeyDown={(e) => onTabKeyDown(e, idx)}
          >
            {TAB_LABELS[id]}
          </button>
        ))}
      </div>

      {activeTab === 'general' && (
        <section role="tabpanel" data-testid="bot-settings-panel-general" className="bot-settings-panel">
          <label className="form-label">
            Name
            <input
              type="text"
              className="modal-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={scheduleGeneralSave}
              data-testid="settings-name"
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
              onBlur={scheduleGeneralSave}
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
              onBlur={scheduleGeneralSave}
              data-testid="settings-workspace"
              placeholder="D:\\projects\\myproject (absolute path)"
            />
          </label>
        </section>
      )}

      {activeTab === 'permissions' && (
        <section role="tabpanel" data-testid="bot-settings-panel-permissions" className="bot-settings-panel">
          <fieldset className="form-fieldset">
            <legend>Allowed tools</legend>
            {TOOL_OPTIONS.map((t) => (
              <label key={t.name} className="form-checkbox">
                <input
                  type="checkbox"
                  checked={allowlist.includes(t.name)}
                  onChange={() => toggleTool(t.name)}
                  onBlur={schedulePermissionsSave}
                  data-testid={`settings-tool-${t.name}`}
                />
                <span>{t.label}</span>
              </label>
            ))}
          </fieldset>
        </section>
      )}

      {activeTab === 'schedule' && (
        <section role="tabpanel" data-testid="bot-settings-panel-schedule" className="bot-settings-panel">
          <label className="form-label">
            Cron expression
            <input
              type="text"
              className="modal-input"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              onBlur={scheduleScheduleSave}
              data-testid="settings-cron"
              placeholder="e.g. 0 9 * * 1-5 (Phase 6 wires the scheduler)"
            />
          </label>
          <label className="form-checkbox">
            <input
              type="checkbox"
              checked={cronEnabled}
              onChange={(e) => setCronEnabled(e.target.checked)}
              onBlur={scheduleScheduleSave}
              data-testid="settings-cron-enabled"
            />
            <span>Enable cron (Phase 6)</span>
          </label>
        </section>
      )}

      {activeTab === 'history' && (
        <section role="tabpanel" data-testid="bot-settings-panel-history" className="bot-settings-panel">
          <RunHistoryTable bot={bot} />
        </section>
      )}
    </div>
  );
}
