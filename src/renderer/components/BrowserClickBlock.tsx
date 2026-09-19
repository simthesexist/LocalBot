// Phase 8 Plan 3: render a browser.click MessageBlock inline.
//
// Header: `browser.click` + selector + hostname + path + duration. Body:
// resulting innerText snippet with byte-counted collapse past 200 UTF-8
// bytes (smaller cap than VaultReadBlock — click result text is usually
// short).
//
// Audit minimization: never displays args.url or the raw input. The
// selector + hostname + path come from the daemon-side audit row shape.

import * as React from 'react';
import { useState } from 'react';
import type { MessageBlock } from '../../shared/types';

export interface BrowserClickBlockProps {
  block: Extract<MessageBlock, { kind: 'browser_click' }>;
}

const COLLAPSE_THRESHOLD_BYTES = 200;

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

export function BrowserClickBlock({ block }: BrowserClickBlockProps): React.JSX.Element {
  const { selector, hostname, path, text, durationMs } = block;
  const [expanded, setExpanded] = useState(false);

  const safeSelector = typeof selector === 'string' ? selector : '';
  const safeHostname = typeof hostname === 'string' ? hostname : '';
  const safePath = typeof path === 'string' ? path : '';
  const safeText = typeof text === 'string' ? text : '';
  const safeDuration = typeof durationMs === 'number' ? durationMs : 0;

  const shouldCollapse = utf8ByteLength(safeText) > COLLAPSE_THRESHOLD_BYTES;
  const visible = shouldCollapse && !expanded
    ? sliceAtUtf8Bytes(safeText, COLLAPSE_THRESHOLD_BYTES)
    : safeText;

  return (
    <div
      className="block-browser-click"
      data-block-kind="browser_click"
      data-selector={safeSelector}
      data-hostname={safeHostname}
      data-path={safePath}
    >
      <div className="block-header">
        <span className="block-tool-name">browser.click</span>
        <span className="block-browser-selector">{safeSelector}</span>
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
          data-testid="collapse-browser-click"
        >
          {expanded ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}
