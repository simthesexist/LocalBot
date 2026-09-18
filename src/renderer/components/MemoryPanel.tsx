// Memory panel modal. Phase 3 Wave 2.
//
// Click target: the header MemoryPill. Renders the bot's memory.md as a
// fenced `<pre>` (no markdown rendering — UI-SPEC §14.1 deferred decision)
// and facts as a `<ul>`. Closes on Escape + backdrop click. ARIA dialog
// + focus trap (UI-SPEC §12 + AGENT-05).

import { useEffect, useRef } from 'react';
import type { Facts } from '../../shared/types';

export interface MemoryPanelProps {
  markdown: string;
  facts: Facts;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
}

export function MemoryPanel({ markdown, facts, loading, error, onClose }: MemoryPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape key + focus management. Click-outside is handled by the
  // backdrop element below (Phase 3 keeps the click handler centralized).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        // Cycle focus within the panel — the panel only has the Close
        // button today, but this keeps the trap ready for future editors.
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const factEntries = Object.entries(facts);

  return (
    <div
      className="memory-panel-backdrop"
      data-testid="memory-panel-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        className="memory-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-panel-title"
        aria-describedby="memory-panel-body"
        data-testid="memory-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="memory-panel-row">
          <div id="memory-panel-title" className="memory-panel-title">Memory</div>
          <button
            ref={closeRef}
            type="button"
            className="memory-panel-close"
            aria-label="Close memory panel"
            onClick={onClose}
            data-testid="memory-panel-close"
          >
            Close
          </button>
        </div>

        <div
          id="memory-panel-body"
          className="memory-panel-body"
          aria-live="polite"
          aria-relevant="additions text"
        >
          {loading && (
            <div className="memory-panel-loading">Loading memory…</div>
          )}

          {!loading && error && (
            <div className="memory-panel-error">{error}</div>
          )}

          {!loading && !error && markdown.length === 0 && factEntries.length === 0 && (
            <div className="memory-panel-empty">Bot has not recorded any memory yet</div>
          )}

          {!loading && !error && markdown.length > 0 && (
            <pre className="memory-panel-markdown" data-testid="memory-panel-markdown">
              {markdown}
            </pre>
          )}

          {!loading && factEntries.length > 0 && (
            <ul className="memory-panel-facts" data-testid="memory-panel-facts">
              {factEntries.map(([name, f]) => (
                <li key={name}>
                  <strong>{name}</strong>: {JSON.stringify(f.value)}
                  <span className="memory-panel-fact-source"> ({f.source ?? 'unknown'})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
