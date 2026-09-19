// Phase 8 Plan 3: render a browser.evaluate MessageBlock inline.
//
// Header: `browser.evaluate` + `{expressionBytes} byte expression` +
// `{resultBytes} byte result` + duration. Body: the result preview in a
// `<pre>` with byte-counted collapse past 500 UTF-8 bytes.
//
// Pitfall 5 / T-8-09: NEVER includes the expression source. The
// MessageBlock only carries the byte count + the result preview
// (already truncated to 50KB by the daemon).

import * as React from 'react';
import { useState } from 'react';
import type { MessageBlock } from '../../shared/types';

export interface BrowserEvaluateBlockProps {
  block: Extract<MessageBlock, { kind: 'browser_evaluate' }>;
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

export function BrowserEvaluateBlock({ block }: BrowserEvaluateBlockProps): React.JSX.Element {
  const { expressionBytes, resultBytes, resultPreview, hostname, path, durationMs } = block;
  const [expanded, setExpanded] = useState(false);

  const safeExprBytes = typeof expressionBytes === 'number' ? expressionBytes : 0;
  const safeResultBytes = typeof resultBytes === 'number' ? resultBytes : 0;
  const safeResult = typeof resultPreview === 'string' ? resultPreview : '';
  const safeHostname = typeof hostname === 'string' ? hostname : '';
  const safePath = typeof path === 'string' ? path : '';
  const safeDuration = typeof durationMs === 'number' ? durationMs : 0;

  const shouldCollapse = utf8ByteLength(safeResult) > COLLAPSE_THRESHOLD_BYTES;
  const visible = shouldCollapse && !expanded
    ? sliceAtUtf8Bytes(safeResult, COLLAPSE_THRESHOLD_BYTES)
    : safeResult;

  return (
    <div
      className="block-browser-evaluate"
      data-block-kind="browser_evaluate"
      data-expression-bytes={safeExprBytes}
      data-result-bytes={safeResultBytes}
      data-hostname={safeHostname}
      data-path={safePath}
    >
      <div className="block-header">
        <span className="block-tool-name">browser.evaluate</span>
        <span className="block-browser-expression-bytes" data-testid="browser-evaluate-expr-bytes">
          {safeExprBytes} byte expression
        </span>
        <span className="block-browser-result-bytes" data-testid="browser-evaluate-result-bytes">
          {safeResultBytes} byte result
        </span>
        {safeHostname ? (
          <span className="block-browser-hostpath">{safeHostname}{safePath}</span>
        ) : null}
        <span className="block-browser-duration">{safeDuration}ms</span>
      </div>
      <pre className="block-browser-eval-result">{visible}</pre>
      {shouldCollapse && (
        <button
          type="button"
          className="collapse-toggle"
          onClick={() => setExpanded((v) => !v)}
          data-testid="collapse-browser-evaluate"
        >
          {expanded ? 'Show less' : `Show all ${safeResultBytes} bytes`}
        </button>
      )}
    </div>
  );
}
