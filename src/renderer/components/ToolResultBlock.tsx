// Render a single tool_result block. Output goes into a <pre>. Long output
// collapses past 500 UTF-8 bytes with a "Show more" toggle. Errors tint the
// block. Empty content renders an "(no output)" placeholder; a single-line
// result (no newline) is shown in full without a toggle.

import * as React from 'react';
import { useState } from 'react';

export interface ToolResultBlockProps {
  content: string;
  isError: boolean;
}

const COLLAPSE_THRESHOLD_BYTES = 500;

function utf8ByteLength(s: string): number {
  // Browser-safe: TextEncoder is available in all modern renderers.
  return new TextEncoder().encode(s).length;
}

function sliceAtUtf8Bytes(s: string, maxBytes: number): string {
  // Find the largest char index whose UTF-8 prefix length is <= maxBytes.
  // Walk per-char (UTF-16 code unit) and accumulate encoded bytes; this
  // approximation is within ±3 bytes of the target due to multi-byte chars,
  // which is acceptable for a collapse threshold.
  let i = 0;
  let bytes = 0;
  const enc = new TextEncoder();
  while (i < s.length && bytes <= maxBytes) {
    const charBytes = enc.encode(s[i]).length;
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    i++;
  }
  return s.slice(0, i);
}

export function ToolResultBlock({ content, isError }: ToolResultBlockProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const safe = content ?? '';

  // Empty content renders a placeholder — no collapse, no "(stopped)" marker.
  if (safe.length === 0) {
    return (
      <div
        className={`block-tool-result ${isError ? 'block-result-error' : ''}`}
        data-block-kind="tool_result"
        data-error={isError ? 'true' : 'false'}
      >
        <span className="block-result-empty">(no output)</span>
      </div>
    );
  }

  // Byte-counted length (UTF-8). Single-line content never collapses —
  // matches the plan's "single-line tool_result does NOT trigger collapse"
  // behavior (UI-03 empty/encoding probe).
  const byteLen = utf8ByteLength(safe);
  const isSingleLine = !safe.includes('\n');
  const shouldCollapse = !isSingleLine && byteLen > COLLAPSE_THRESHOLD_BYTES;

  let visible = safe;
  if (shouldCollapse && !expanded) {
    visible = sliceAtUtf8Bytes(safe, COLLAPSE_THRESHOLD_BYTES);
  }

  const cls = `block-tool-result ${isError ? 'block-result-error' : ''}`;
  return (
    <div
      className={cls}
      data-block-kind="tool_result"
      data-error={isError ? 'true' : 'false'}
    >
      <pre className="block-tool-output">{visible}</pre>
      {shouldCollapse && (
        <button
          type="button"
          className="collapse-toggle"
          onClick={() => setExpanded((v) => !v)}
          data-testid={isError ? 'collapse-error' : 'collapse-result'}
        >
          {expanded
            ? 'Show less'
            : `Show more (+${byteLen - COLLAPSE_THRESHOLD_BYTES} bytes)`}
        </button>
      )}
    </div>
  );
}
