// Header pill — shows memory footprint for the active bot. Phase 3 Wave 2.
//
// Click target for the MemoryPanel modal. Fully bound to `useMemory()` so
// `memory:updated` events from the main process refresh the panel live.

import { useState } from 'react';
import { useMemory } from '../state/memory';
import { MemoryPanel } from './MemoryPanel';

export interface MemoryPillProps {
  bot?: string;
}

function formatBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function MemoryPill({ bot = 'default' }: MemoryPillProps) {
  const mem = useMemory(bot);
  const [open, setOpen] = useState(false);

  const label = mem.loading
    ? 'memory…'
    : `Memory · ${mem.factCount} fact${mem.factCount === 1 ? '' : 's'} · ${formatBytes(mem.bytes)}`;

  return (
    <div className="memory-pill-region" data-testid="memory-pill">
      <button
        type="button"
        className="memory-pill"
        onClick={() => {
          if (!open) void mem.refresh();
          setOpen(true);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Memory: ${label}`}
        disabled={mem.loading}
      >
        {label}
      </button>
      {open && (
        <MemoryPanel
          markdown={mem.markdown}
          facts={mem.facts}
          loading={mem.loading}
          error={mem.error}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
