// Session switcher dropdown. Phase 3 Wave 2.
//
// Renders in the chat header. Click toggles a dropdown listing the bot's
// session files newest-first per UI-SPEC §7.1 / §7.2. Closes on Escape
// and click outside.

import { useEffect, useRef, useState } from 'react';
import type { SessionEntry } from '../../shared/types';

export interface SessionSwitcherProps {
  bot: string;
  currentSessionId: string | null;
  onSelect: (sessionId: string) => void;
}

function formatSessionDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  } catch {
    return iso;
  }
}

function formatSessionDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

export function SessionSwitcher({ bot, currentSessionId, onSelect }: SessionSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await window.localbot.history.listSessions(bot)) as {
        ok: boolean;
        sessions?: SessionEntry[];
        error?: string;
      };
      if (!res.ok) {
        setError(res.error ?? 'failed to load sessions');
      } else {
        setSessions(
          (res.sessions ?? []).map((s) => ({
            ...s,
            isActive: s.sessionId === currentSessionId,
          })),
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const off = window.localbot.on('history:appended', ((p: { kind?: string }) => {
      if (p?.kind === 'message') void refresh();
    }) as (p: unknown) => void);
    return () => off();
    // currentSessionId change should not refetch; the listen hook handles live updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot]);

  // Click outside + Escape to close.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (
        triggerRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const triggerLabel = (() => {
    if (!currentSessionId) return 'Current session';
    if (sessions.length <= 1) return 'Current session';
    const match = sessions.find((s) => s.sessionId === currentSessionId);
    return match ? `Current session <${formatSessionDate(match.startedAt)}>` : 'Current session';
  })();

  return (
    <div className="session-switcher" data-testid="session-switcher">
      <button
        ref={triggerRef}
        type="button"
        className="session-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {triggerLabel}
      </button>
      {open && (
        <div
          ref={dropdownRef}
          className="session-dropdown"
          role="menu"
          data-testid="session-dropdown"
        >
          {loading && <div className="session-dropdown-loading">loading…</div>}
          {error && <div className="session-dropdown-error">{error}</div>}
          {!loading && !error && sessions.length === 0 && (
            <div className="session-dropdown-empty">(no sessions yet)</div>
          )}
          {!loading && !error && sessions.map((s) => (
            <button
              key={s.sessionId}
              type="button"
              role="menuitem"
              className={`session-dropdown-item ${s.isActive ? 'is-active' : ''}`}
              onClick={() => {
                setOpen(false);
                if (!s.isActive) onSelect(s.sessionId);
              }}
            >
              <span className="session-dropdown-time">{formatSessionDateTime(s.startedAt)}</span>
              <span className="session-dropdown-count"> — {s.messageCount} messages</span>
              {s.isActive && <span className="session-dropdown-active"> (active)</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
