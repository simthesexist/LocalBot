// Phase 4 Wave 3: RunHistoryTable — renders the bot's run history in a
// scrollable table inside the BotSettingsPage's Run History tab. Uses
// `useRunHistory` for the stale-while-revalidate cache + push refresh;
// the container is plain overflow:auto with no virtualized library
// (per the plan's RESEARCH.md "no new packages" rule).

import { useEffect, useRef, useState } from 'react';
import type { BotConfig, RunRecord } from '../../shared/types';
import { useRunHistory } from '../state/runs';

export interface RunHistoryTableProps {
  bot: BotConfig;
  opts?: { initialLimit?: number; pageSize?: number; polling?: boolean };
}

const TRIGGER_PX = 100; // distance from bottom that triggers loadMore
const ERROR_TRUNCATE = 60;

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function ErrorCell({ message }: { message?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!message) return <span className="run-history-error-empty">—</span>;
  const full = message;
  const truncated = message.length > ERROR_TRUNCATE ? `${message.slice(0, ERROR_TRUNCATE)}…` : message;
  return (
    <button
      type="button"
      className="run-history-error"
      title={full}
      onClick={(e) => {
        e.stopPropagation();
        setExpanded((v) => !v);
      }}
    >
      {expanded ? full : truncated}
    </button>
  );
}

function Row({ record }: { record: RunRecord }) {
  // Phase 6 Wave 3: cron-triggered runs get a distinct badge label so
  // the user can scan the table and see which rows came from the
  // scheduler vs a manual Send.
  const triggerLabel = record.trigger === 'cron' ? 'Cron' : 'Manual';
  return (
    <tr className="run-history-row" data-exitreason={record.exitReason} data-runid={record.runId} data-trigger={record.trigger}>
      <td className="run-history-cell-ts">{formatRelative(record.ts)}</td>
      <td className="run-history-cell-trigger">
        <span className="run-history-trigger-badge" data-trigger={record.trigger}>{triggerLabel}</span>
      </td>
      <td className="run-history-cell-duration">{formatDuration(record.durationMs)}</td>
      <td className="run-history-cell-exitreason">
        <span className="run-history-exitreason-badge" data-exitreason={record.exitReason}>
          {record.exitReason}
        </span>
      </td>
      <td className="run-history-cell-error">
        <ErrorCell message={record.error?.message} />
      </td>
    </tr>
  );
}

export function RunHistoryTable({ bot, opts }: RunHistoryTableProps) {
  const { runs, loading, hasMore, error, loadMore, refresh } = useRunHistory(bot.id, opts);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  // Scroll-to-bottom pagination: when the user has scrolled near the
  // bottom, request the next page.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => {
      if (!hasMore) return;
      if (loadingRef.current) return;
      const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
      if (distance <= TRIGGER_PX) {
        void loadMore();
      }
    };
    el.addEventListener('scroll', handler);
    return () => el.removeEventListener('scroll', handler);
  }, [hasMore, loadMore]);

  if (error) {
    return (
      <div className="run-history-error-state" data-testid="run-history-error">
        <p>Failed to load run history.</p>
        <button
          type="button"
          className="modal-button primary"
          onClick={() => void refresh()}
          data-testid="run-history-retry"
        >
          Retry
        </button>
      </div>
    );
  }

  if (runs.length === 0 && !loading) {
    return (
      <div className="run-history-empty" data-testid="run-history-empty">
        No runs yet. Trigger the bot to create the first row.
      </div>
    );
  }

  return (
    <div className="run-history-table" ref={scrollRef} data-testid="run-history-table">
      <table>
        <thead>
          <tr>
            <th className="run-history-cell-ts">When</th>
            <th className="run-history-cell-trigger">Trigger</th>
            <th className="run-history-cell-duration">Duration</th>
            <th className="run-history-cell-exitreason">Outcome</th>
            <th className="run-history-cell-error">Error</th>
          </tr>
        </thead>
        <tbody>
          {runs.length === 0 && loading
            ? Array.from({ length: 4 }).map((_, i) => (
                <tr key={`placeholder-${i}`} className="run-history-row run-history-row-placeholder">
                  <td colSpan={5}>…</td>
                </tr>
              ))
            : runs.map((r) => <Row key={r.runId} record={r} />)}
          {hasMore && (
            <tr className="run-history-row-loadmore">
              <td colSpan={5}>
                <button
                  type="button"
                  className="run-history-loadmore"
                  onClick={() => void loadMore()}
                  disabled={loading}
                >
                  {loading ? 'Loading…' : 'Load more'}
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
