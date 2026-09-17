// Chat pane.

import { useEffect, useRef } from 'react';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { MessageBlock } from './MessageBlock';
import { ErrorBanner } from './ErrorBanner';
import { useMessages } from '../state/messages';
import type { ChatMessage, MessageBlock as MessageBlockT } from '../../shared/types';

export interface ChatProps {
  initialMessages: ChatMessage[];
}

function blocksForMessage(m: ChatMessage): MessageBlockT[] {
  if (m.blocks && m.blocks.length > 0) return m.blocks;
  // Back-compat: legacy rows / streaming text → wrap content as a single text block.
  return [{ kind: 'text', text: m.content ?? '' }];
}

export function Chat({ initialMessages }: ChatProps) {
  const {
    messages,
    streaming,
    activeMsgId,
    pendingAssistantContent,
    pendingBlocks,
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
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    clearError();
    const newMsgId = crypto.randomUUID();
    await window.localbot.sendMessage(lastUser.content, newMsgId);
  };

  const onInlineRetry = async (content: string) => {
    clearError();
    const newMsgId = crypto.randomUUID();
    await window.localbot.sendMessage(content, newMsgId);
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
          {messages.map((m) => {
            const blocks = blocksForMessage(m);
            const showStopped = m.stopped && m.role === 'assistant';
            return (
              <div
                key={m.msgId ?? `${m.ts}-${m.role}`}
                className={`bubble ${m.role === 'user' ? 'bubble-user' : 'bubble-assistant'}`}
                data-role={m.role}
              >
                <div className="bubble-content">
                  {blocks.map((b, i) => (
                    <MessageBlock key={i} block={b} />
                  ))}
                  {showStopped && <span className="bubble-stopped"> (stopped)</span>}
                </div>
                {m.interrupted && m.role === 'assistant' && (
                  <div className="bubble-footer">
                    <span>Stream interrupted — </span>
                    <button
                      type="button"
                      className="inline-retry"
                      onClick={() => {
                        const lastUser = [...messages]
                          .slice(0, messages.indexOf(m))
                          .reverse()
                          .find((x) => x.role === 'user');
                        if (lastUser) void onInlineRetry(lastUser.content);
                      }}
                    >
                      Retry
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {/* Streaming assistant — combine live text content with any tool
              blocks that have arrived mid-stream. On message:done this is
              replaced by a persisted ChatMessage in `messages`. */}
          {Object.entries(pendingAssistantContent).map(([msgId, content]) => {
            const liveBlocks = pendingBlocks[msgId] ?? [];
            return (
              <div
                key={`streaming-${msgId}`}
                className="bubble bubble-assistant"
                data-role="assistant"
              >
                <div className="bubble-content">
                  {liveBlocks.map((b, i) => (
                    <MessageBlock key={`b-${i}`} block={b} />
                  ))}
                  {content.length > 0 && <div className="block-text">{content}</div>}
                </div>
              </div>
            );
          })}

          {streaming && activeMsgId && !pendingAssistantContent[activeMsgId] && (
            <div
              key={`pending-${activeMsgId}`}
              className="bubble bubble-assistant"
              data-role="assistant"
            >
              <div className="bubble-content">
                <span className="bubble-loading">…</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <Composer />
    </div>
  );
}

// Re-export MessageBubble for back-compat (Phase 1 still references it).
export { MessageBubble };
