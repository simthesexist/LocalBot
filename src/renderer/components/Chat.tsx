// Chat pane. Phase 4 Wave 1.
//
// Mounts the MemoryPill + SessionSwitcher in the header, renders the
// head-of-file SummaryBlock at the top of the message list. Phase 4
// swaps the left rail from Phase 3's WorkspaceTree to the new
// BotSidebar (260 px); WorkspaceTree is re-homed to the BotSettingsPage
// in Wave 3.

import { useEffect, useRef } from 'react';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { MessageBlock } from './MessageBlock';
import { ErrorBanner } from './ErrorBanner';
import { MemoryPill } from './MemoryPill';
import { BotSidebar } from './BotSidebar';
import { SessionSwitcher } from './SessionSwitcher';
import { SummaryBlock } from './SummaryBlock';
import { useMessages } from '../state/messages';
import { useCurrentSession } from '../state/sessions';
import type { ChatMessage, MessageBlock as MessageBlockT } from '../../shared/types';
import type { BotConfig } from '../../shared/types';

export interface ChatProps {
  initialMessages: ChatMessage[];
  initialBots?: BotConfig[];
  workspaceRoot?: string;
}

function blocksForMessage(m: ChatMessage): MessageBlockT[] {
  if (m.blocks && m.blocks.length > 0) return m.blocks;
  // Back-compat: legacy rows / streaming text → wrap content as a single text block.
  return [{ kind: 'text', text: m.content ?? '' }];
}

export function Chat({ initialMessages, initialBots, workspaceRoot = '.' }: ChatProps) {
  const {
    messages,
    streaming,
    activeMsgId,
    pendingAssistantContent,
    pendingBlocks,
    toolUseBlocks,
    error,
    daemonStatus,
    setMessages,
    clearError,
  } = useMessages();

  const {
    headSummary,
    currentSessionId,
    switchSession,
    loading: sessionLoading,
  } = useCurrentSession('default');

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
        <div className="chat-header-right">
          <SessionSwitcher
            bot="default"
            currentSessionId={currentSessionId}
            onSelect={(id) => void switchSession(id)}
          />
          <MemoryPill bot="default" />
        </div>
      </header>

      <div className="chat-body">
        <BotSidebar initialBots={initialBots} />
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
        {sessionLoading && (
          <div className="session-loading-banner">Loading session…</div>
        )}

        <div className="message-list" ref={listRef}>
          {headSummary && <SummaryBlock summary={headSummary} />}
          {messages.map((m) => {
            const blocks = blocksForMessage(m);
            const showStopped = m.stopped && m.role === 'assistant';
            // Skip summary rows — already rendered by SummaryBlock.
            if (m.role === 'summary') return null;
            return (
              <div
                key={m.msgId ?? `${m.ts}-${m.role}`}
                className={`bubble ${m.role === 'user' ? 'bubble-user' : 'bubble-assistant'}`}
                data-role={m.role}
              >
                <div className="bubble-content">
                  {blocks.map((b, i) => (
                    <MessageBlock key={i} block={b} toolUseBlocks={toolUseBlocks} />
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
                    <MessageBlock key={`b-${i}`} block={b} toolUseBlocks={toolUseBlocks} />
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
