// Phase 5 Wave 2: live stdout/stderr block for an in-flight (or just-finished)
// shell command. Reads from `useShellStream` keyed by shellId. Renders
// stdout and stderr with distinct prefixes and auto-scrolls to the bottom as
// new lines arrive. Falls back to the static block payload if the live store
// has no entry (e.g. after a reload mid-run).

import * as React from 'react';
import { useEffect, useRef } from 'react';
import { useShellStream } from '../state/shells';
import type { MessageBlock } from '../../shared/types';

export function ShellStreamBlock({ block }: { block: Extract<MessageBlock, { kind: 'shell_stream' }> }): React.JSX.Element {
  const live = useShellStream(block.shellId);
  const stdout = live?.stdout ?? block.stdout;
  const stderr = live?.stderr ?? block.stderr;
  const streaming = live?.streaming ?? block.exitCode === null;
  const exitCode = live?.exitCode ?? block.exitCode;
  const durationMs = live?.durationMs ?? block.durationMs;
  const isError = live?.isError ?? block.isError;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [stdout, stderr]);

  return (
    <div className="block-shell-stream" data-testid="shell-stream-block" data-shell-id={block.shellId}>
      <div className="shell-stream-header">
        <span className="shell-stream-label">$</span>
        <code className="shell-stream-cmd">{block.command}</code>
        <span className="shell-stream-bot">[{block.bot}]</span>
        {streaming && <span className="shell-stream-status running" data-testid="shell-stream-status">running…</span>}
        {!streaming && exitCode !== null && (
          <span className={`shell-stream-status ${isError ? 'error' : 'ok'}`} data-testid="shell-stream-status">
            exit {exitCode} · {durationMs ?? 0}ms
          </span>
        )}
      </div>
      <div className="shell-stream-output" ref={containerRef} data-testid="shell-stream-output">
        {stdout && <pre className="shell-stream-stdout" data-testid="shell-stream-stdout">{stdout}</pre>}
        {stderr && <pre className="shell-stream-stderr" data-testid="shell-stream-stderr">{stderr}</pre>}
        {streaming && !stdout && !stderr && <div className="shell-stream-empty">waiting for output…</div>}
      </div>
    </div>
  );
}
