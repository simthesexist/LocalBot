// Phase 8 Plan 3: render a browser.navigate MessageBlock inline.
//
// Header: `browser.navigate` + normalized url (hostname + pathname ONLY —
// Pitfall 5: never the raw args.url which may carry a query string with
// tokens) + status badge (green for 2xx, amber for 3xx, red for 4xx/5xx)
// + bytes footer + duration. Body: text content with byte-counted collapse
// past 500 UTF-8 bytes (mirrors VaultReadBlock).
//
// Audit minimization: this block reads ONLY block.url (the normalized
// hostname + pathname that the daemon already stripped). The raw args.url
// is never exposed to the renderer through the MessageBlock.

import * as React from 'react';
import { useState } from 'react';
import type { MessageBlock } from '../../shared/types';

export interface BrowserNavigateBlockProps {
  block: Extract<MessageBlock, { kind: 'browser_navigate' }>;
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

function statusBucket(status: number | null): '2xx' | '3xx' | '4xx' | '5xx' | 'unknown' {
  if (typeof status !== 'number' || status < 100 || status >= 600) return 'unknown';
  const hundreds = Math.floor(status / 100);
  if (hundreds === 2) return '2xx';
  if (hundreds === 3) return '3xx';
  if (hundreds === 4) return '4xx';
  if (hundreds === 5) return '5xx';
  return 'unknown';
}

export function BrowserNavigateBlock({ block }: BrowserNavigateBlockProps): React.JSX.Element {
  const { url, status, title, text, bytes, durationMs } = block;
  const [expanded, setExpanded] = useState(false);

  const safeText = typeof text === 'string' ? text : '';
  const safeUrl = typeof url === 'string' ? url : '';
  const safeTitle = typeof title === 'string' ? title : '';
  const safeBytes = typeof bytes === 'number' ? bytes : utf8ByteLength(safeText);
  const safeDuration = typeof durationMs === 'number' ? durationMs : 0;

  const shouldCollapse = utf8ByteLength(safeText) > COLLAPSE_THRESHOLD_BYTES;
  const visible = shouldCollapse && !expanded
    ? sliceAtUtf8Bytes(safeText, COLLAPSE_THRESHOLD_BYTES)
    : safeText;

  const bucket = statusBucket(status);

  return (
    <div
      className="block-browser-navigate"
      data-block-kind="browser_navigate"
      data-browser-url={safeUrl}
    >
      <div className="block-header">
        <span className="block-tool-name">browser.navigate</span>
        <span className="block-browser-url">{safeUrl}</span>
        {status !== null && status !== undefined ? (
          <span className={`block-browser-status block-status-${bucket}`}>{status}</span>
        ) : null}
        {safeBytes > 0 ? (
          <span className="block-browser-bytes">({safeBytes} bytes)</span>
        ) : null}
        <span className="block-browser-duration">{safeDuration}ms</span>
      </div>
      {safeTitle ? <div className="block-browser-title">{safeTitle}</div> : null}
      <pre className="block-browser-content">{visible}</pre>
      {shouldCollapse && (
        <button
          type="button"
          className="collapse-toggle"
          onClick={() => setExpanded((v) => !v)}
          data-testid="collapse-browser-navigate"
        >
          {expanded ? 'Show less' : `Show all ${safeBytes} bytes`}
        </button>
      )}
    </div>
  );
}
