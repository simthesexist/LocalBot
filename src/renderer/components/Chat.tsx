// Chat pane.

import { useEffect, useRef } from 'react';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { ErrorBanner } from './ErrorBanner';
import { useMessages } from '../state/messages';
import type { ChatMessage } from '../../shared/types';

export interface ChatProps {
  initialMessages: ChatMessage[];
}

export function Chat({ initialMessages }: ChatProps) {
  const {
    messages,
    streaming,
    activeMsgId,
    pendingAssistantContent,
    error,
    daemonStatus,
    setMessages,
    setError,
    clearError,
  } = useMessages();

  // Hydrate the loaded session on first render.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    if (initialMessages.length > 0) {
      setMessages(initialMessages);
    }
    hydratedRef.current = true;
  }, [initialMessages, setMessages]);

  // Auto-scroll to bottom when messages change.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, pendingAssistantContent]);

  const onRetry = async () => {
    // Re-send the last user message.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    clearError();
    const newMsgId = crypto.randomUUID();
    await window.localbot.sendMessage(lastUser.content, newMsgId);
  };

  const onUpdateKey = async () => {
    clearError();
    await window.localbot.key.clear();
  };

  return (
    <div className="chat-shell">
      <header className="chat-header" data-testid="chat-header">
        <span className="chat-title">Localbot</span>
      </header>

      <div className="chat-body">
        {daemonStatus.state !== 'ready' && (
          <ErrorBanner
            variant="daemon"
            message={daemonStatus.message ?? 'Tool daemon reconnecting…'}
            onDismiss={() => {}}
            onRetry={() => {}}
            onUpdateKey={() => {}}
          />
        )}
        {error && (
          <ErrorBanner
            variant="error"
            message={error.error}
            retryable={error.retryable}
            category={error.category}
            onDismiss={clearError}
            onRetry={onRetry}
            onUpdateKey={onUpdateKey}
          />
        )}

        <div className="message-list" ref={listRef}>
          {messages.map((m) => (
            <MessageBubble key={(m.msgId ?? `${m.ts}-${m.role}`)} message={m} />
          ))}

          {Object.entries(pendingAssistantContent).map(([msgId, content]) => (
            <MessageBubble
              key={`streaming-${msgId}`}
              message={{
                ts: Date.now(),
                role: 'assistant',
                content,
                msgId,
              }}
            />
          ))}

          {streaming && activeMsgId && !pendingAssistantContent[activeMsgId] && (
            <MessageBubble
              key={`pending-${activeMsgId}`}
              message={{ ts: Date.now(), role: 'assistant', content: '', msgId: activeMsgId }}
            />
          )}
        </div>
      </div>

      <Composer />
    </div>
  );
}
