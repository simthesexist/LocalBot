// Phase 5 Wave 2: single shell approval modal. Stacks at the App root via
// ApprovalModalStack so multiple pending requests render as a queue (one
// modal at a time, top-of-stack visible).
//
// Three actions:
//   - Deny          → shell.respond(shellId, 'deny')
//   - Allow once    → shell.respond(shellId, 'allow-once')
//   - Allow always  → shell.respond(shellId, 'allow-always')
//
// Pressing Esc dismisses (treats as deny).

import * as React from 'react';
import { useEffect } from 'react';
import { AppModal } from './AppModal';

export interface ApprovalModalProps {
  shellId: string;
  command: string;
  bot: string;
  onDecide: (decision: 'allow-once' | 'allow-always' | 'deny') => void;
}

export function ApprovalModal({ shellId, command, bot, onDecide }: ApprovalModalProps): React.JSX.Element {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDecide('deny');
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onDecide]);

  return (
    <AppModal title="Approve shell command" data-testid="approval-modal">
      <div className="approval-body">
        <div className="approval-row">
          <span className="approval-label">Bot</span>
          <span className="approval-value" data-testid="approval-bot">{bot}</span>
        </div>
        <div className="approval-row">
          <span className="approval-label">Command</span>
          <pre className="approval-command" data-testid="approval-command">{command}</pre>
        </div>
        <div className="approval-warning" data-testid="approval-warning">
          This will run a shell command on your machine. Check the bot and command carefully.
        </div>
      </div>
      <div className="approval-actions">
        <button
          type="button"
          className="approval-button deny"
          data-testid="approval-deny"
          onClick={() => onDecide('deny')}
        >
          Deny
        </button>
        <button
          type="button"
          className="approval-button allow-once"
          data-testid="approval-allow-once"
          onClick={() => onDecide('allow-once')}
        >
          Allow once
        </button>
        <button
          type="button"
          className="approval-button allow-always"
          data-testid="approval-allow-always"
          onClick={() => onDecide('allow-always')}
        >
          Allow always
        </button>
      </div>
      <div className="approval-meta" data-testid="approval-shell-id">shell: {shellId}</div>
    </AppModal>
  );
}
