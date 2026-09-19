// Phase 8 Plan 3: render a browser.type MessageBlock inline.
//
// One-line summary: `browser.type` + selector + textBytes count +
// (submitted) badge + duration. NO `<pre>` body; NEVER includes the
// typed text (Pitfall 5 / T-8-08). The MessageBlock only carries the
// byte count so even a compromised renderer cannot leak the secret.

import * as React from 'react';
import type { MessageBlock } from '../../shared/types';

export interface BrowserTypeBlockProps {
  block: Extract<MessageBlock, { kind: 'browser_type' }>;
}

export function BrowserTypeBlock({ block }: BrowserTypeBlockProps): React.JSX.Element {
  const { selector, textBytes, hostname, path, submitted, durationMs } = block;

  const safeSelector = typeof selector === 'string' ? selector : '';
  const safeBytes = typeof textBytes === 'number' ? textBytes : 0;
  const safeHostname = typeof hostname === 'string' ? hostname : '';
  const safePath = typeof path === 'string' ? path : '';
  const safeDuration = typeof durationMs === 'number' ? durationMs : 0;

  return (
    <div
      className="block-browser-type"
      data-block-kind="browser_type"
      data-selector={safeSelector}
      data-text-bytes={safeBytes}
      data-hostname={safeHostname}
      data-path={safePath}
    >
      <div className="block-header">
        <span className="block-tool-name">browser.type</span>
        <span className="block-browser-selector">{safeSelector}</span>
        <span className="block-browser-text-bytes">({safeBytes} bytes)</span>
        {submitted ? (
          <span className="block-browser-submitted" data-testid="browser-type-submitted">(submitted)</span>
        ) : null}
        {safeHostname ? (
          <span className="block-browser-hostpath">{safeHostname}{safePath}</span>
        ) : null}
        <span className="block-browser-duration">{safeDuration}ms</span>
      </div>
    </div>
  );
}
