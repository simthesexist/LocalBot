// BotSidebar — Phase 4 Wave 1+2 left rail.
//
// Replaces Phase 3's `WorkspaceTree` left rail (260 px). Renders one
// `SidebarBotRow` per bot with a status dot, name, last-run text, and
// delete button. Wave 2 adds:
//   - `SidebarComposer` mounted at the bottom (Enter submits; disabled
//     while the active bot's status === 'running').
//   - `SettingsEditModal` opened from each row's settings icon
//     (AGENT-04 settings edit surface — full settings page is Wave 3).
//   - Play/stop actions in `SidebarBotRow` that call triggerBot / cancelBotRun.

import { useEffect, useState } from 'react';
import { useBots, useActiveBotId, seedBots, triggerBot } from '../state/bots';
import type { BotConfig } from '../../shared/types';
import { SidebarBotRow } from './SidebarBotRow';
import { NewBotModal } from './NewBotModal';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { SettingsEditModal } from './SettingsEditModal';
import { SidebarComposer } from './SidebarComposer';

export interface BotSidebarProps {
  initialBots?: BotConfig[];
}

export function BotSidebar({ initialBots }: BotSidebarProps = {}) {
  const { bots, loading, error, activeBotId, setActiveBotId, refresh } = useBots();
  const { setActiveBotId: setActive } = useActiveBotId();
  const [showNewBotModal, setShowNewBotModal] = useState(false);
  const [confirmDeleteBot, setConfirmDeleteBot] = useState<BotConfig | null>(null);
  const [settingsBot, setSettingsBot] = useState<BotConfig | null>(null);

  useEffect(() => {
    if (initialBots && initialBots.length > 0) {
      seedBots(initialBots);
    }
    void refresh();
  }, [initialBots, refresh]);

  const onSelect = (id: string) => {
    setActive(id);
    setActiveBotId(id);
  };

  const activeBot = bots.find((b) => b.id === activeBotId) ?? null;
  const composerDisabled = activeBot?.status === 'running';

  return (
    <aside
      className="bot-sidebar"
      role="navigation"
      aria-label="Bots"
      data-testid="bot-sidebar"
    >
      <div className="bot-sidebar-header">
        <h2 className="bot-sidebar-title">Bots</h2>
        <button
          type="button"
          className="bot-sidebar-add"
          aria-label="New bot"
          onClick={() => setShowNewBotModal(true)}
          data-testid="bot-sidebar-add"
        >
          +
        </button>
      </div>
      {error && (
        <div className="bot-sidebar-error" role="alert" data-testid="bot-sidebar-error">
          {error}
        </div>
      )}
      <ul className="bot-sidebar-list" data-testid="bot-sidebar-list">
        {bots.length === 0 && !loading && (
          <li className="bot-sidebar-empty">No bots yet — click + to create one.</li>
        )}
        {loading && bots.length === 0 && (
          <li className="bot-sidebar-empty">Loading bots…</li>
        )}
        {bots.map((bot) => (
          <SidebarBotRow
            key={bot.id}
            bot={bot}
            isActive={bot.id === activeBotId}
            onSelect={() => onSelect(bot.id)}
            onDelete={() => setConfirmDeleteBot(bot)}
            onSettings={() => setSettingsBot(bot)}
          />
        ))}
      </ul>

      <SidebarComposer
        activeBotId={activeBotId}
        disabled={composerDisabled}
        onSend={async (content) => {
          await triggerBot(activeBotId, content);
        }}
      />

      {showNewBotModal && (
        <NewBotModal
          onClose={() => setShowNewBotModal(false)}
          onCreated={(bot) => {
            setActive(bot.id);
            void refresh();
          }}
        />
      )}
      {confirmDeleteBot && (
        <DeleteConfirmModal
          bot={confirmDeleteBot}
          onClose={() => setConfirmDeleteBot(null)}
          onDeleted={() => {
            if (activeBotId === confirmDeleteBot.id) setActive('default');
            void refresh();
          }}
        />
      )}
      {settingsBot && (
        <SettingsEditModal
          bot={settingsBot}
          onClose={() => setSettingsBot(null)}
          onUpdated={() => {
            void refresh();
          }}
        />
      )}
    </aside>
  );
}
