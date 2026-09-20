// Phase 9 Plan 2: phone chat message bubble.
//
// Mobile-first rendering of one assistant or user message. Heavy blocks
// (vault_read / browser_screenshot / browser_evaluate) are stubbed to
// `[Block: <kind> — N bytes]` per Pitfall A6 — the phone is for glance,
// not for inspecting the agent's full tool output.

import { useEffect, useRef } from 'react';
import type { MessageBlock } from '../../shared/types';

export interface ChatMessage {
  ts: number;
  role: 'user' | 'assistant';
  content: string;
  msgId?: string;
  blocks?: MessageBlock[];
}

export interface MessageBubbleProps {
  messages: ChatMessage[];
  streaming: string | null;
}

function describeBlock(block: MessageBlock): string | null {
  switch (block.kind) {
    case 'text':
      return null; // text is rendered as the bubble body directly
    case 'tool_use':
      return `[tool_use: ${block.name}]`;
    case 'tool_result':
      return block.isError ? '[tool_result: error]' : '[tool_result]';
    case 'vault_read':
      return `[Block: vault_read — ${block.bytes} bytes]`;
    case 'vault_write':
      return `[Block: vault_write — ${block.bytesWritten} bytes]`;
    case 'browser_screenshot':
      return `[Block: browser_screenshot — ${block.bytes} bytes]`;
    case 'browser_evaluate':
      return `[Block: browser_evaluate — ${block.resultBytes} bytes]`;
    default:
      return null;
  }
}

function MessageItem({ msg }: { msg: ChatMessage }) {
  const className = msg.role === 'user' ? 'bubble user' : 'bubble assistant';
  return (
    <div className={className} data-testid={`phone-bubble-${msg.role}`}>
      <div className="bubble-content">{msg.content}</div>
      {msg.blocks && msg.blocks.length > 0 && (
        <div className="bubble-blocks">
          {msg.blocks.map((b, i) => {
            const stub = describeBlock(b);
            return stub ? (
              <span key={i} className="bubble-stub">
                {stub}
              </span>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}

export function MessageBubble({ messages, streaming }: MessageBubbleProps) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, streaming]);

  return (
    <div className="messages" data-testid="phone-messages">
      {messages.map((m, i) => (
        <MessageItem key={`${m.msgId ?? 'm'}-${i}`} msg={m} />
      ))}
      {streaming !== null && (
        <div className="bubble assistant streaming" data-testid="phone-streaming">
          <span className="bubble-content">{streaming || '…'}</span>
          <span className="bubble-streaming-dots"> ●●●</span>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}