// SidebarComposer — Phase 4 Wave 2.
//
// Textarea + send button mounted at the bottom of BotSidebar. Pressing
// Enter (without Shift) submits; the button is disabled while the
// active bot's status === 'running'. Calls back to `state/bots.ts`'s
// `triggerBot` so the runId abort map is wired through main.

import { useEffect, useRef, useState } from 'react';

export interface SidebarComposerProps {
  activeBotId: string;
  disabled: boolean;
  onSend: (content: string) => Promise<void>;
}

export function SidebarComposer({ activeBotId, disabled, onSend }: SidebarComposerProps) {
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Refocus the textarea when the previous run completes (disabled → false).
  useEffect(() => {
    if (!disabled) taRef.current?.focus();
  }, [disabled]);

  const submit = async () => {
    const trimmed = content.trim();
    if (!trimmed || disabled || submitting) return;
    setSubmitting(true);
    try {
      await onSend(trimmed);
      setContent('');
    } catch {
      // state/bots.ts surfaces the error via EVENT_BOT_STATUS; nothing to do here.
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const placeholder = disabled
    ? `Running bot "${activeBotId}"…`
    : `Message bot "${activeBotId}" — Enter to send`;

  return (
    <div className="sidebar-composer" data-testid="sidebar-composer">
      <textarea
        ref={taRef}
        className="sidebar-composer-textarea"
        value={content}
        placeholder={placeholder}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
        disabled={disabled}
        data-testid="sidebar-composer-input"
      />
      <button
        type="button"
        className="sidebar-composer-send"
        onClick={() => void submit()}
        disabled={disabled || submitting || content.trim().length === 0}
        data-testid="sidebar-composer-send"
      >
        {disabled ? 'Running…' : submitting ? 'Sending…' : 'Send'}
      </button>
    </div>
  );
}
