// Central renderer state hook for messages + streaming + error + daemon status.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, DaemonStatus, ErrorEvent, TokenEvent } from '../../shared/types';

export interface UseMessagesApi {
  messages: ChatMessage[];
  streaming: boolean;
  activeMsgId: string | null;
  activeRole: 'assistant' | null;
  error: ErrorEvent | null;
  daemonStatus: DaemonStatus;
  pendingAssistantContent: Record<string, string>;
  setMessages: (m: ChatMessage[]) => void;
  appendUserMsg: (content: string, msgId: string) => void;
  appendDelta: (msgId: string, delta: string) => void;
  finalizeMsg: (msgId: string, content: string, flags?: { stopped?: boolean; interrupted?: boolean }) => void;
  setStreaming: (b: boolean) => void;
  setActiveMsgId: (id: string | null, role?: 'assistant' | null) => void;
  setError: (e: ErrorEvent | null) => void;
  setDaemonStatus: (s: DaemonStatus) => void;
  clearError: () => void;
}

export function useMessages(): UseMessagesApi {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [activeMsgId, setActiveMsgIdState] = useState<string | null>(null);
  const [activeRole, setActiveRole] = useState<'assistant' | null>(null);
  const [error, setError] = useState<ErrorEvent | null>(null);
  const [daemonStatus, setDaemonStatusState] = useState<DaemonStatus>({ state: 'connecting' });
  const [pendingAssistantContent, setPendingAssistantContent] = useState<Record<string, string>>({});

  // Keep a stable ref to the active msg id for cancel transport.
  const activeMsgIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeMsgIdRef.current = activeMsgId;
  }, [activeMsgId]);

  useEffect(() => {
    if (!window.localbot) return;

    const offToken = window.localbot.on('message:token', (p) => {
      const evt = p as TokenEvent;
      setPendingAssistantContent((prev) => ({
        ...prev,
        [evt.msgId]: (prev[evt.msgId] ?? '') + evt.delta,
      }));
    });

    const offDone = window.localbot.on('message:done', (p) => {
      const evt = p as { msgId: string };
      setPendingAssistantContent((prev) => {
        const content = prev[evt.msgId] ?? '';
        setMessages((cur) => [
          ...cur,
          { ts: Date.now(), role: 'assistant', content, msgId: evt.msgId },
        ]);
        const next = { ...prev };
        delete next[evt.msgId];
        return next;
      });
      setStreaming(false);
      setActiveMsgIdState(null);
      setActiveRole(null);
    });

    const offError = window.localbot.on('message:error', (p) => {
      const evt = p as ErrorEvent;
      setError(evt);
      setPendingAssistantContent((prev) => {
        const content = prev[evt.msgId] ?? '';
        if (content.length > 0) {
          setMessages((cur) => {
            // If message wasn't finalized yet, persist partial + stopped.
            const exists = cur.some((m) => m.msgId === evt.msgId);
            if (exists) return cur;
            return [
              ...cur,
              {
                ts: Date.now(),
                role: 'assistant',
                content,
                stopped: !evt.retryable,
                msgId: evt.msgId,
              },
            ];
          });
        }
        const next = { ...prev };
        delete next[evt.msgId];
        return next;
      });
      setStreaming(false);
      setActiveMsgIdState(null);
      setActiveRole(null);
    });

    const offDaemon = window.localbot.on('daemon:status', (p) => {
      setDaemonStatusState(p as DaemonStatus);
    });

    return () => {
      offToken();
      offDone();
      offError();
      offDaemon();
    };
  }, []);

  const appendUserMsg = useCallback((content: string, msgId: string) => {
    setMessages((cur) => [...cur, { ts: Date.now(), role: 'user', content, msgId }]);
    setActiveMsgIdState(msgId);
    setActiveRole('user');
  }, []);

  const appendDelta = useCallback((msgId: string, delta: string) => {
    setPendingAssistantContent((prev) => ({
      ...prev,
      [msgId]: (prev[msgId] ?? '') + delta,
    }));
  }, []);

  const finalizeMsg = useCallback(
    (msgId: string, content: string, flags?: { stopped?: boolean; interrupted?: boolean }) => {
      setMessages((cur) => [
        ...cur,
        {
          ts: Date.now(),
          role: 'assistant',
          content,
          stopped: flags?.stopped,
          interrupted: flags?.interrupted,
          msgId,
        },
      ]);
      setPendingAssistantContent((prev) => {
        const next = { ...prev };
        delete next[msgId];
        return next;
      });
    },
    [],
  );

  const setActiveMsgId = useCallback((id: string | null, role?: 'assistant' | null) => {
    setActiveMsgIdState(id);
    setActiveRole(role ?? null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    messages,
    streaming,
    activeMsgId,
    activeRole,
    error,
    daemonStatus,
    pendingAssistantContent,
    setMessages,
    appendUserMsg,
    appendDelta,
    finalizeMsg,
    setStreaming,
    setActiveMsgId,
    setError,
    setDaemonStatus: setDaemonStatusState,
    clearError,
  };
}
