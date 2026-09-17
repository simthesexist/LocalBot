// Central renderer state hook for messages + streaming + error + daemon status.
//
// Phase 2: subscribes to message:tool_use + message:tool_result and appends
// the corresponding blocks to a per-msgId blocks store. On message:done the
// blocks array is frozen into the persisted ChatMessage.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatMessage,
  DaemonStatus,
  ErrorEvent,
  MessageBlock,
  TokenEvent,
  ToolResultEvent,
  ToolUseEvent,
} from '../../shared/types';

export interface UseMessagesApi {
  messages: ChatMessage[];
  streaming: boolean;
  activeMsgId: string | null;
  activeRole: 'assistant' | 'user' | null;
  error: ErrorEvent | null;
  daemonStatus: DaemonStatus;
  pendingAssistantContent: Record<string, string>;
  /** Phase 2: per-msgId blocks table driving the renderer bubble. */
  pendingBlocks: Record<string, MessageBlock[]>;
  setMessages: (m: ChatMessage[]) => void;
  appendUserMsg: (content: string, msgId: string) => void;
  appendDelta: (msgId: string, delta: string) => void;
  appendToolUse: (msgId: string, block: MessageBlock) => void;
  appendToolResult: (msgId: string, block: MessageBlock) => void;
  finalizeMsg: (msgId: string, content: string, blocks?: MessageBlock[], flags?: { stopped?: boolean; interrupted?: boolean }) => void;
  setStreaming: (b: boolean) => void;
  setActiveMsgId: (id: string | null, role?: 'assistant' | 'user' | null) => void;
  setError: (e: ErrorEvent | null) => void;
  setDaemonStatus: (s: DaemonStatus) => void;
  clearError: () => void;
}

export function useMessages(): UseMessagesApi {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [activeMsgId, setActiveMsgIdState] = useState<string | null>(null);
  const [activeRole, setActiveRole] = useState<'assistant' | 'user' | null>(null);
  const [error, setError] = useState<ErrorEvent | null>(null);
  const [daemonStatus, setDaemonStatusState] = useState<DaemonStatus>({ state: 'connecting' });
  const [pendingAssistantContent, setPendingAssistantContent] = useState<Record<string, string>>({});
  const [pendingBlocks, setPendingBlocks] = useState<Record<string, MessageBlock[]>>({});

  // Keep a stable ref to the active msg id for cancel transport.
  const activeMsgIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeMsgIdRef.current = activeMsgId;
  }, [activeMsgId]);

  useEffect(() => {
    if (!window.localbot) return;

    const offToken = window.localbot.on('message:token', ((p: TokenEvent) => {
      setPendingAssistantContent((prev) => ({
        ...prev,
        [p.msgId]: (prev[p.msgId] ?? '') + p.delta,
      }));
    }) as (p: unknown) => void);

    const offToolUse = window.localbot.on('message:tool_use', ((p: ToolUseEvent) => {
      const block: MessageBlock = { kind: 'tool_use', id: p.toolUseId, name: p.name, input: p.input };
      setPendingBlocks((prev) => ({
        ...prev,
        [p.msgId]: [...(prev[p.msgId] ?? []), block],
      }));
    }) as (p: unknown) => void);

    const offToolResult = window.localbot.on('message:tool_result', ((p: ToolResultEvent) => {
      const block: MessageBlock = {
        kind: 'tool_result',
        toolUseId: p.toolUseId,
        content: p.content,
        isError: p.isError,
      };
      setPendingBlocks((prev) => ({
        ...prev,
        [p.msgId]: [...(prev[p.msgId] ?? []), block],
      }));
    }) as (p: unknown) => void);

    const offDone = window.localbot.on('message:done', ((p: { msgId: string }) => {
      setPendingAssistantContent((prev) => {
        const content = prev[p.msgId] ?? '';
        setPendingBlocks((curBlocks) => {
          const live = curBlocks[p.msgId] ?? [];
          const merged: MessageBlock[] = [...live];
          if (content.length > 0) {
            merged.push({ kind: 'text', text: content });
          }
          setMessages((cur) => [
            ...cur,
            { ts: Date.now(), role: 'assistant', content, blocks: merged, msgId: p.msgId },
          ]);
          const nextBlocks = { ...curBlocks };
          delete nextBlocks[p.msgId];
          return nextBlocks;
        });
        const next = { ...prev };
        delete next[p.msgId];
        return next;
      });
      setStreaming(false);
      setActiveMsgIdState(null);
      setActiveRole(null);
    }) as (p: unknown) => void);

    const offError = window.localbot.on('message:error', ((p: ErrorEvent) => {
      setError(p);
      setPendingAssistantContent((prev) => {
        const content = prev[p.msgId] ?? '';
        if (content.length > 0) {
          setMessages((cur) => {
            const exists = cur.some((m) => m.msgId === p.msgId);
            if (exists) return cur;
            return [
              ...cur,
              {
                ts: Date.now(),
                role: 'assistant',
                content,
                stopped: !p.retryable,
                interrupted: p.retryable,
                msgId: p.msgId,
              },
            ];
          });
        }
        const next = { ...prev };
        delete next[p.msgId];
        return next;
      });
      setPendingBlocks((prev) => {
        if (!(p.msgId in prev)) return prev;
        const next = { ...prev };
        delete next[p.msgId];
        return next;
      });
      setStreaming(false);
      setActiveMsgIdState(null);
      setActiveRole(null);
    }) as (p: unknown) => void);

    const offDaemon = window.localbot.on('daemon:status', ((p: DaemonStatus) => {
      setDaemonStatusState(p);
    }) as (p: unknown) => void);

    return () => {
      offToken();
      offToolUse();
      offToolResult();
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

  const appendToolUse = useCallback((msgId: string, block: MessageBlock) => {
    setPendingBlocks((prev) => ({
      ...prev,
      [msgId]: [...(prev[msgId] ?? []), block],
    }));
  }, []);

  const appendToolResult = useCallback((msgId: string, block: MessageBlock) => {
    setPendingBlocks((prev) => ({
      ...prev,
      [msgId]: [...(prev[msgId] ?? []), block],
    }));
  }, []);

  const finalizeMsg = useCallback(
    (msgId: string, content: string, blocks?: MessageBlock[], flags?: { stopped?: boolean; interrupted?: boolean }) => {
      setMessages((cur) => [
        ...cur,
        {
          ts: Date.now(),
          role: 'assistant',
          content,
          blocks,
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
      setPendingBlocks((prev) => {
        if (!(msgId in prev)) return prev;
        const next = { ...prev };
        delete next[msgId];
        return next;
      });
    },
    [],
  );

  const setActiveMsgId = useCallback((id: string | null, role?: 'assistant' | 'user' | null) => {
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
    pendingBlocks,
    setMessages,
    appendUserMsg,
    appendDelta,
    appendToolUse,
    appendToolResult,
    finalizeMsg,
    setStreaming,
    setActiveMsgId,
    setError,
    setDaemonStatus: setDaemonStatusState,
    clearError,
  };
}
