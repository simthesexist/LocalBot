// Summary block. Phase 3 Wave 2.
//
// Renders the head-of-file summary bubble per UI-SPEC §1.4. Lives at the
// top of the message list when the loaded session has a headSummary.

import type { SummaryRecord } from '../../shared/types';

export interface SummaryBlockProps {
  summary: SummaryRecord;
}

function formatRunAt(iso: string): string {
  // Format YYYY-MM-DD HH:mm:ss in local time (UI-SPEC §7.1).
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return iso;
  }
}

export function SummaryBlock({ summary }: SummaryBlockProps) {
  return (
    <div className="bubble bubble-summary" data-testid="summary-block">
      <div className="summary-badge">Conversation summarized</div>
      <div className="summary-body">{summary.summary}</div>
      <div className="summary-meta">
        {summary.turnsFolded} turns folded, summarizer ran at {formatRunAt(summary.ranAt)}
      </div>
    </div>
  );
}
