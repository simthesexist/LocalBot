// Single bot row in the BotSidebar. Phase 4 Wave 1.
//
// Renders: status dot + name + last-run text + delete button. The
// settings button is wired to a no-op (Wave 3 owns the settings page).

import type { BotConfig } from '../../shared/types';

export interface SidebarBotRowProps {
  bot: BotConfig;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onSettings?: () => void;
}

function formatRelative(iso: string | undefined): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never';
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function SidebarBotRow({
  bot,
  isActive,
  onSelect,
  onDelete,
  onSettings,
}: SidebarBotRowProps) {
  const lastRunText = bot.lastRunAt ? formatRelative(bot.lastRunAt) : 'never';
  return (
    <li
      className="bot-row"
      role="button"
      tabIndex={0}
      aria-current={isActive ? 'true' : undefined}
      data-testid={`bot-row-${bot.id}`}
      data-bot-id={bot.id}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span
        className="bot-row-status"
        data-status={bot.status}
        aria-hidden="true"
        title={bot.status}
      />
      <span className="bot-row-name">{bot.name}</span>
      <span className="bot-row-lastrun">({lastRunText})</span>
      <span className="bot-row-actions">
        <button
          type="button"
          className="bot-row-settings"
          aria-label={`Settings for ${bot.name}`}
          data-testid={`bot-settings-${bot.id}`}
          onClick={(e) => {
            e.stopPropagation();
            onSettings?.();
          }}
        >
          ⚙
        </button>
        <button
          type="button"
          className="bot-row-delete"
          aria-label={`Delete ${bot.name}`}
          data-testid={`bot-delete-${bot.id}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          ×
        </button>
      </span>
    </li>
  );
}
