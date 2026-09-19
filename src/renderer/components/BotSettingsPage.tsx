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
  // Phase 6 Wave 3: notifyOnError defaults true when undefined (back-compat
  // with bots persisted before Phase 6). scheduledPrompt defaults to '' and
  // the daemon falls back to '[Scheduled run] Perform your regular check-in.'
  // when empty.
  const [notifyOnError, setNotifyOnError] = useState(bot.notifyOnError !== false);
  const [scheduledPrompt, setScheduledPrompt] = useState(bot.scheduledPrompt ?? '');
  // Client-side cron validation + next-fire preview. The renderer bundles
  // croner via Vite (it's a runtime dep), but we import lazily so the
  // initial render never throws if the cron expression is mid-edit.
  const [cronError, setCronError] = useState<string | null>(null);
  const [nextFires, setNextFires] = useState<string[]>([]);
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

  // Phase 6 Wave 3: client-side cron validation + next-fire preview.
  // Runs whenever the cron expression changes. We import croner lazily
  // (it's a runtime dep bundled via Vite) so a bad expression can't
  // crash the initial mount. An empty cron clears the preview + error.
  useEffect(() => {
    let cancelled = false;
    const trimmed = cron.trim();
    if (!trimmed) {
      setCronError(null);
      setNextFires([]);
      return;
    }
    void (async () => {
      try {
        const mod = await import('croner');
        // croner@9 exports the Cron constructor as a named export; some
        // bundlers surface it via .default too. Prefer named, fall back.
        const modAny = mod as unknown as { Cron?: unknown; default?: { Cron?: unknown } };
        const Cron = modAny.Cron ?? modAny.default?.Cron;
        if (typeof Cron !== 'function') {
          throw new Error('croner export shape changed');
        }
        const CronCtor = Cron as new (
          expr: string,
          opts?: Record<string, unknown>,
        ) => { nextRuns(count: number): Array<Date | null>; nextRun(after?: Date): Date | null };
        const instance = new CronCtor(trimmed, { protect: true });
        const dates = instance.nextRuns(5);
        const fires: string[] = [];
        for (const d of dates) {
          if (!d) break;
          fires.push(d.toISOString());
        }
        if (!cancelled) {
          setCronError(null);
          setNextFires(fires);
        }
      } catch (e) {
        if (!cancelled) {
          setCronError((e as Error).message || 'Invalid cron expression');
          setNextFires([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cron]);

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
      // Phase 6 Wave 3: surface cron validation to the daemon. If the
      // croner import failed OR the expression is invalid, skip the patch
      // (the inline error + disabled Save are the UX; the daemon's
      // CRON_REGEX would reject anyway).
      if (cronError) return;
      const patch: Record<string, unknown> = {
        cronEnabled,
        notifyOnError,
        scheduledPrompt,
      };
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
              placeholder="e.g. 0 9 * * 1-5 (5-field standard cron)"
            />
          </label>
          {cron.trim() && cronError && (
            <div className="form-error" data-testid="settings-cron-error" role="alert">
              Invalid cron expression: {cronError}
            </div>
          )}
          {cron.trim() && !cronError && nextFires.length > 0 && (
            <div className="settings-next-fires" data-testid="settings-next-fires">
              Next fires: {nextFires.join(', ')}
            </div>
          )}
          <label className="form-checkbox">
            <input
              type="checkbox"
              checked={cronEnabled}
              onChange={(e) => setCronEnabled(e.target.checked)}
              onBlur={scheduleScheduleSave}
              data-testid="settings-cron-enabled"
            />
            <span>Enable cron schedule</span>
          </label>
          <label className="form-checkbox">
            <input
              type="checkbox"
              checked={notifyOnError}
              onChange={(e) => setNotifyOnError(e.target.checked)}
              onBlur={scheduleScheduleSave}
              data-testid="settings-notify-on-error"
            />
            <span>Notify on scheduled-run errors</span>
          </label>
          <label className="form-label">
            Scheduled prompt
            <textarea
              className="modal-input"
              value={scheduledPrompt}
              maxLength={4096}
              rows={4}
              onChange={(e) => setScheduledPrompt(e.target.value)}
              onBlur={scheduleScheduleSave}
              data-testid="settings-scheduled-prompt"
              placeholder="[Scheduled run] Perform your regular check-in."
            />
          </label>
          <div className="form-hint">
            Save status:{' '}
            <button
              type="button"
              className="modal-button primary"
              data-testid="settings-schedule-save"
              disabled={!!cronError}
              onClick={scheduleScheduleSave}
            >
              Save schedule
            </button>
          </div>
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
