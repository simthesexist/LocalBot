// Header pill — shows memory footprint for the active bot. Clicking the
// pill toggles a placeholder MemoryPanel drawer; the full editor is a
// follow-up plan.

import { useState } from 'react';
import { useMemory } from '../state/memory';

export interface MemoryPillProps {
  bot?: string;
}

export function MemoryPill({ bot = 'default' }: MemoryPillProps) {
  const mem = useMemory(bot);
  const [open, setOpen] = useState(false);

  const label = mem.loading
    ? 'memory…'
    : `${mem.factCount} fact${mem.factCount === 1 ? '' : 's'} · ${formatBytes(mem.bytes)}`;

  return (
    <div className="memory-pill-region" data-testid="memory-pill">
      <button
        type="button"
        className="memory-pill"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Memory: ${label}`}
        disabled={mem.loading}
      >
        {label}
      </button>
      {open && (
        <div className="memory-panel" role="dialog" aria-label="Memory">
          <div className="memory-panel-header">Memory</div>
          <div className="memory-panel-stats">
            <div><strong>{mem.factCount}</strong> facts</div>
            <div><strong>{formatBytes(mem.bytes)}</strong> markdown</div>
            <div className="memory-panel-updated">
              updated {mem.updatedAt ? new Date(mem.updatedAt).toLocaleString() : 'never'}
            </div>
          </div>
          <p className="memory-panel-hint">
            Memory is injected into the system prompt automatically. Full editor coming soon.
          </p>
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
