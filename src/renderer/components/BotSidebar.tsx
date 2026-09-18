// BotSidebar — Phase 4 Wave 1 left rail.
//
// Replaces Phase 3's `WorkspaceTree` left rail (260 px). Renders one
// `SidebarBotRow` per bot with a status dot, name, last-run text, and
// delete button. The `+` button opens `NewBotModal`; clicking a row's
// delete icon opens `DeleteConfirmModal` for that bot. The renderer's
// `useBots()` hook subscribes to `EVENT_BOT_LIST_UPDATED` so the
// sidebar refreshes transparently after any mutation.

import { useEffect, useState } from 'react';
import { useBots, useActiveBotId, seedBots } from '../state/bots';
import type { BotConfig } from '../../shared/types';
import { SidebarBotRow } from './SidebarBotRow';
import { NewBotModal } from './NewBotModal';
import { DeleteConfirmModal } from './DeleteConfirmModal';

export interface BotSidebarProps {
  /**
   * Bot list shipped via `app:init.bots`. Used to synchronously hydrate
   * the sidebar on first paint. The sidebar's own `useBots().refresh()`
   * keeps it live afterwards.
   */
  initialBots?: BotConfig[];
}

export function BotSidebar({ initialBots }: BotSidebarProps = {}) {
  const { bots, loading, error, activeBotId, setActiveBotId, refresh } = useBots();
  // useActiveBotId shares the same module-scope store as useBots; we
  // call it explicitly here so a future refactor that splits them
  // doesn't break the row-click handler.
  const { setActiveBotId: setActive } = useActiveBotId();
  const [showNewBotModal, setShowNewBotModal] = useState(false);
  const [confirmDeleteBot, setConfirmDeleteBot] = useState<BotConfig | null>(null);

  // Synchronous first-paint hydration from app:init, then a refresh so
  // the sidebar reflects the latest daemon state.
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
            onSettings={() => {
              // Wave 3 owns the settings page; for now this is a no-op.
              // T-P4-08: do not silently fail — the click target exists
              // so the user can discover the affordance.
              /* eslint-disable-next-line no-console */
              console.info('[bot-row] settings not implemented yet', bot.id);
            }}
          />
        ))}
      </ul>

      {showNewBotModal && (
        <NewBotModal
          onClose={() => setShowNewBotModal(false)}
          onCreated={(bot) => {
            setActive(bot.id);
            // EVENT_BOT_LIST_UPDATED already triggers useBots().refresh();
            // the explicit refresh below is belt-and-suspenders for the
            // rare case where the daemon broadcast arrives before our
            // subscription is wired.
            void refresh();
          }}
        />
      )}
      {confirmDeleteBot && (
        <DeleteConfirmModal
          bot={confirmDeleteBot}
          onClose={() => setConfirmDeleteBot(null)}
          onDeleted={() => {
            // If the user deleted their active bot, fall back to the
            // implicit 'default' so the chat view never has a dangling
            // selected row.
            if (activeBotId === confirmDeleteBot.id) setActive('default');
            void refresh();
          }}
        />
      )}
    </aside>
  );
}
