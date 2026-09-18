// Session list + current session state. Phase 3 Wave 2.
//
// Tracks the active session id, hydrates messages on switch, and exposes
// `useSessionList()` + `useCurrentSession()`. The chat header's
// SessionSwitcher reads from `useSessionList()`; Chat.tsx calls
// `useCurrentSession()` to know which session is loaded and to drive
// `history:load` when the user picks a different one.

import { useCallback, useEffect, useState } from 'react';
import type { ChatMessage, HistoryLoadResult, SessionEntry, SummaryRecord } from '../../shared/types';

export interface UseSessionListApi {
  sessions: SessionEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useSessionList(bot: string = 'default'): UseSessionListApi {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await window.localbot.history.listSessions(bot)) as {
        ok: boolean;
        sessions?: SessionEntry[];
        error?: string;
      };
      if (!res.ok) {
        setError(res.error ?? 'failed to list sessions');
      } else {
        setSessions(res.sessions ?? []);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [bot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { sessions, loading, error, refresh };
}

export interface UseCurrentSessionApi {
  currentSessionId: string | null;
  messages: ChatMessage[];
  headSummary: SummaryRecord | null;
  loading: boolean;
  error: string | null;
  switchSession: (sessionId: string) => Promise<void>;
  setCurrentSessionId: (id: string | null) => void;
  setMessages: (m: ChatMessage[]) => void;
  setHeadSummary: (s: SummaryRecord | null) => void;
}

/**
 * Track the active session id + its loaded messages + the head summary.
 * The first invocation loads the most-recent session for the bot; later
 * `switchSession` calls re-hydrate via `history:load`.
 */
export function useCurrentSession(bot: string = 'default'): UseCurrentSessionApi {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [headSummary, setHeadSummary] = useState<SummaryRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (sessionId: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const result = (await window.localbot.history.load(bot, sessionId)) as HistoryLoadResult;
        setMessages(result.messages ?? []);
        setHeadSummary(result.headSummary ?? null);
        setCurrentSessionId(sessionId);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [bot],
  );

  const switchSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (sessionId === currentSessionId) return;
      // Switching mid-stream cancels the in-flight message (matches Phase 1/2
      // Stop semantics; UI-SPEC §14.5 deferred decision).
      const activeId = messages.length > 0 ? messages[messages.length - 1]?.msgId : null;
      if (activeId) {
        try { await window.localbot.cancel(activeId); } catch { /* ignore */ }
      }
      await load(sessionId);
    },
    [currentSessionId, messages, load],
  );

  // First mount: pull the most-recent session via listSessions, then load it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = (await window.localbot.history.listSessions(bot)) as {
          ok: boolean;
          sessions?: SessionEntry[];
          error?: string;
        };
        if (cancelled) return;
        if (!list.ok || !list.sessions || list.sessions.length === 0) return;
        await load(list.sessions[0].sessionId);
      } catch {
        // best-effort; render with empty messages
      }
    })();
    return () => { cancelled = true; };
  }, [bot, load]);

  return {
    currentSessionId,
    messages,
    headSummary,
    loading,
    error,
    switchSession,
    setCurrentSessionId,
    setMessages,
    setHeadSummary,
  };
}
