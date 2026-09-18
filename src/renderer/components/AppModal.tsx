// Generic modal primitive. Phase 4 Wave 1.
//
// Shared by NewBotModal + DeleteConfirmModal (and reserved for
// SettingsEditModal in Wave 2). Renders a backdrop + card with Escape
// close, click-outside close, and a simple focus trap (cycle Tab inside
// the dialog). Per T-P4-11, the focus trap is additive — it does not
// block Escape.

import { useEffect, useRef, type ReactNode } from 'react';

export interface AppModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** z-index offset; defaults to 1000 (NewBotModal). DeleteConfirmModal
   *  uses 1100 so it stacks on top. */
  zIndex?: number;
  /** Optional className appended to the modal card (e.g. 'new-bot-modal',
   *  'delete-confirm-modal'). */
  cardClassName?: string;
  /** Optional aria-label override; defaults to the title. */
  ariaLabel?: string;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function AppModal({
  title,
  onClose,
  children,
  zIndex = 1000,
  cardClassName,
  ariaLabel,
}: AppModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useRef(`appmodal-title-${Math.random().toString(36).slice(2, 9)}`).current;

  // Escape to close + focus trap (Tab cycle).
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = Array.from(
        card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute('aria-hidden'));
      if (focusables.length === 0) {
        e.preventDefault();
        card.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    // Focus the first focusable element inside the card (per UI-SPEC §13).
    const firstFocusable = card.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    if (firstFocusable) {
      firstFocusable.focus();
    } else {
      card.focus();
    }

    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      style={{ zIndex }}
      data-testid="app-modal-backdrop"
    >
      <div
        ref={cardRef}
        className={`modal-card ${cardClassName ?? ''}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={ariaLabel}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        data-testid="app-modal-card"
      >
        <div className="modal-header">
          <h3 id={titleId} className="modal-title">{title}</h3>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
            data-testid="app-modal-close"
          >
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
