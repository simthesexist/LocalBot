// A single chat message bubble.

import * as React from 'react';
import { useMemo } from 'react';
import type { ChatMessage } from '../../shared/types';

export interface MessageBubbleProps {
  message: ChatMessage;
}

function renderInline(text: string): React.JSX.Element {
  // Light inline markdown-ish rendering for code spans + bold only.
  // Avoids extra deps. Splits on backtick code spans.
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code key={i} className="inline-code">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const showStopped = message.stopped && !isUser;

  const content = useMemo(() => message.content ?? '', [message.content]);

  return (
    <div className={`bubble ${isUser ? 'bubble-user' : 'bubble-assistant'}`} data-role={message.role}>
      <div className="bubble-content">
        {content.length === 0 ? (
          <span className="bubble-loading">…</span>
        ) : (
          renderInline(content)
        )}
        {showStopped && (
          <>
            {' '}
            <span className="bubble-stopped">(stopped)</span>
          </>
        )}
      </div>
    </div>
  );
}
