// Composer: auto-grow textarea pinned to bottom.

import { useEffect, useRef, useState } from 'react';
import { useMessages } from '../state/messages';

export function Composer() {
  const { streaming, activeMsgId, appendUserMsg, setStreaming, setActiveMsgId } = useMessages();
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [text]);

  // Escape key cancels streaming.
  useEffect(() => {
    if (!streaming) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onStop();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, activeMsgId]);

  const onSend = async () => {
    const content = text.trim();
    if (!content || streaming) return;
    const msgId = crypto.randomUUID();
    appendUserMsg(content, msgId);
    setText('');
    setStreaming(true);
    setActiveMsgId(msgId, 'user');
    try {
      await window.localbot.sendMessage(content, msgId);
    } catch {
      setStreaming(false);
      setActiveMsgId(null);
    }
  };

  const onStop = async () => {
    if (!activeMsgId) return;
    try {
      await window.localbot.cancel(activeMsgId);
    } catch {
      // best-effort
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={taRef}
        className="composer-input"
        placeholder={streaming ? 'Streaming… press Esc to stop' : 'Send a message…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        data-testid="composer-input"
      />
      {streaming ? (
        <button
          type="button"
          className="composer-button stop"
          data-testid="stop-button"
          onClick={onStop}
        >
          Stop
        </button>
      ) : (
        <button
          type="button"
          className="composer-button send"
          data-testid="send-button"
          onClick={onSend}
          disabled={text.trim().length === 0}
        >
          Send
        </button>
      )}
    </div>
  );
}
