// Phase 8 Plan 3: render a browser.fill_form MessageBlock inline.
//
// Header: `browser.fill_form` + `{fieldCount} fields` + (submitted) badge
// + duration. Body: summary text snippet (the innerText after fills
// complete) with byte-counted collapse past 500 UTF-8 bytes.
//
// Pitfall 5 / T-8-10: NEVER includes individual field values. The
// MessageBlock only carries the field count + the resulting summary.

import * as React from 'react';
import { useState } from 'react';
import type { MessageBlock } from '../../shared/types';

export interface BrowserFillFormBlockProps {
  block: Extract<MessageBlock, { kind: 'browser_fill_form' }>;
}

const COLLAPSE_THRESHOLD_BYTES = 500;

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function sliceAtUtf8Bytes(s: string, maxBytes: number): string {
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

export function BrowserFillFormBlock({ block }: BrowserFillFormBlockProps): React.JSX.Element {
  const { fieldCount, hostname, path, submitted, summary, durationMs } = block;
  const [expanded, setExpanded] = useState(false);

  const safeCount = typeof fieldCount === 'number' ? fieldCount : 0;
  const safeHostname = typeof hostname === 'string' ? hostname : '';
  const safePath = typeof path === 'string' ? path : '';
  const safeSummary = typeof summary === 'string' ? summary : '';
  const safeDuration = typeof durationMs === 'number' ? durationMs : 0;

  const shouldCollapse = utf8ByteLength(safeSummary) > COLLAPSE_THRESHOLD_BYTES;
  const visible = shouldCollapse && !expanded
    ? sliceAtUtf8Bytes(safeSummary, COLLAPSE_THRESHOLD_BYTES)
    : safeSummary;

  return (
    <div
      className="block-browser-fill-form"
      data-block-kind="browser_fill_form"
      data-field-count={safeCount}
      data-hostname={safeHostname}
      data-path={safePath}
    >
      <div className="block-header">
        <span className="block-tool-name">browser.fill_form</span>
        <span className="block-browser-field-count" data-testid="browser-fill-form-count">
          {safeCount} field{safeCount === 1 ? '' : 's'}
        </span>
        {submitted ? (
          <span className="block-browser-submitted" data-testid="browser-fill-form-submitted">(submitted)</span>
        ) : null}
        {safeHostname ? (
          <span className="block-browser-hostpath">{safeHostname}{safePath}</span>
        ) : null}
        <span className="block-browser-duration">{safeDuration}ms</span>
      </div>
      <pre className="block-browser-content">{visible}</pre>
      {shouldCollapse && (
        <button
          type="button"
          className="collapse-toggle"
          onClick={() => setExpanded((v) => !v)}
          data-testid="collapse-browser-fill-form"
        >
          {expanded ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}
