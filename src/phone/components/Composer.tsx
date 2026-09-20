// Phase 9 Plan 2: phone chat composer.
//
// Plain React textarea + send button. Enter submits, Shift+Enter inserts
// a newline. Messages are capped at 4096 chars (mirrors the WS handler
// cap in src/main/network/handlers.ts). Empty messages are dropped.

import { useState, type KeyboardEvent } from 'react';

export interface ComposerProps {
  disabled: boolean;
  onSend: (content: string) => void;
}

const MAX_BYTES = 4096;

export function Composer({ disabled, onSend }: ComposerProps) {
  const [text, setText] = useState('');

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed.length > MAX_BYTES) return;
    onSend(trimmed);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
        disabled={disabled}
        placeholder={disabled ? 'Waiting…' : 'Message'}
        aria-label="Message composer"
        data-testid="phone-composer"
      />
      <button
        type="button"
        onClick={submit}
        disabled={disabled || text.trim().length === 0}
        aria-label="Send"
        data-testid="phone-send"
      >
        Send
      </button>
    </div>
  );
}