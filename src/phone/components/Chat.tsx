// Phase 9 Plan 2: phone chat orchestrator.
//
// Owns the WebSocket lifecycle (exponential-backoff reconnect, capped at
// 30s per RESEARCH §Pattern 5) and the message list. Dispatches incoming
// JSON frames by `m.type` against the same WS envelope the desktop
// renderer uses (handlers.ts in main mirrors chat.ts in src/main/ipc/).
//
// Messages flow:
//   phone -> main  : {type:'sendMessage', msgId, content, bot?}
//   main -> phone  : {type:'messageStarted', msgId, bot}
//                    {type:'token', msgId, delta}
//                    {type:'toolUse', msgId, toolUseId, name, input}
//                    {type:'toolResult', msgId, toolUseId, content, isError}
//                    {type:'messageDone', msgId}
//                    {type:'messageError', msgId, error}
//
// crypto.randomUUID() generates the msgId locally so we can match the
// echo'd events back to our own optimistic user bubble.

import { useEffect, useRef, useState, useCallback } from 'react';
import { Composer } from './Composer';
import { MessageBubble, type ChatMessage } from './MessageBubble';
import type { MessageBlock } from '../../shared/types';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

interface IncomingFrame {
  type: string;
  msgId?: string;
  bot?: string;
  delta?: string;
  toolUseId?: string;
  name?: string;
  input?: unknown;
  content?: string;
  isError?: boolean;
  error?: string;
}

function isIncomingFrame(value: unknown): value is IncomingFrame {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === 'string';
}

export function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let attempts = 0;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        attempts = 0;
        setConnected(true);
      };

      ws.onmessage = (evt) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(typeof evt.data === 'string' ? evt.data : '');
        } catch {
          return;
        }
        if (!isIncomingFrame(parsed)) return;
        dispatch(parsed);
      };

      ws.onerror = () => {
        /* let onclose handle reconnect */
      };

      ws.onclose = () => {
        setConnected(false);
        if (stopped) return;
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      const delay = RECONNECT_DELAYS[Math.min(attempts, RECONNECT_DELAYS.length - 1)];
      attempts++;
      setTimeout(connect, delay);
    };

    connect();

    return () => {
      stopped = true;
      const cur = wsRef.current;
      wsRef.current = null;
      if (cur && cur.readyState <= 1) {
        try { cur.close(); } catch { /* ignore */ }
      }
    };

    function dispatch(m: IncomingFrame): void {
      switch (m.type) {
        case 'messageStarted':
          // We don't allocate a separate assistant message yet — tokens
          // mutate the streaming text. Optimistic user bubble already in
          // place from send().
          setStreaming('');
          break;
        case 'token':
          setStreaming((cur) => (cur ?? '') + (m.delta ?? ''));
          break;
        case 'messageDone':
          setStreaming((cur) => {
            const text = cur ?? '';
            setMessages((ms) => [
              ...ms,
              { ts: Date.now(), role: 'assistant', content: text, msgId: m.msgId },
            ]);
            return null;
          });
          break;
        case 'messageError': {
          const errText = m.error ?? 'unknown error';
          setStreaming((cur) => {
            setMessages((ms) => [
              ...ms,
              {
                ts: Date.now(),
                role: 'assistant',
                content: cur
                  ? `[error after streaming] ${errText}\n\n${cur}`
                  : `[error] ${errText}`,
                msgId: m.msgId,
              },
            ]);
            return null;
          });
          break;
        }
        case 'toolUse':
          // Surface tool invocations as a stub pill on the assistant
          // bubble (Pitfall A6 — phone is glance-only).
          setMessages((ms) => {
            const idx = findAssistantIndex(ms, m.msgId);
            const block: MessageBlock = {
              kind: 'tool_use',
              id: m.toolUseId ?? '',
              name: m.name ?? 'tool',
              input: m.input,
            };
            if (idx === -1) {
              return [
                ...ms,
                {
                  ts: Date.now(),
                  role: 'assistant',
                  content: '',
                  msgId: m.msgId,
                  blocks: [block],
                },
              ];
            }
            const next = ms.slice();
            const existing = next[idx];
            next[idx] = {
              ...existing,
              blocks: [...(existing.blocks ?? []), block],
            };
            return next;
          });
          break;
        case 'toolResult':
          setMessages((ms) => {
            const idx = findAssistantIndex(ms, m.msgId);
            const block: MessageBlock = {
              kind: 'tool_result',
              toolUseId: m.toolUseId ?? '',
              content: m.content ?? '',
              isError: m.isError === true,
            };
            if (idx === -1) return ms;
            const next = ms.slice();
            const existing = next[idx];
            next[idx] = {
              ...existing,
              blocks: [...(existing.blocks ?? []), block],
            };
            return next;
          });
          break;
        default:
          /* unknown frame — drop silently per Pitfall 1 */
          break;
      }
    }
  }, []);

  const send = useCallback((content: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    const msgId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setMessages((ms) => [
      ...ms,
      { ts: Date.now(), role: 'user', content, msgId },
    ]);
    setStreaming('');
    try {
      ws.send(JSON.stringify({ type: 'sendMessage', msgId, content }));
    } catch {
      /* swallow — onclose will reconnect */
    }
  }, []);

  return (
    <div className="phone-shell">
      <header className="phone-header" data-testid="phone-header">
        <span className="phone-title">Localbot</span>
        <span className={`phone-status ${connected ? 'connected' : 'disconnected'}`}>
          {connected ? 'online' : 'offline'}
        </span>
      </header>
      <MessageBubble messages={messages} streaming={streaming} />
      <Composer disabled={streaming !== null} onSend={send} />
    </div>
  );
}

function findAssistantIndex(ms: ChatMessage[], msgId?: string): number {
  if (!msgId) return -1;
  for (let i = ms.length - 1; i >= 0; i--) {
    if (ms[i].role === 'assistant' && ms[i].msgId === msgId) return i;
  }
  return -1;
}