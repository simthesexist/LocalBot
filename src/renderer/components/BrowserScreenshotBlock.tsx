// Phase 8 Plan 3: render a browser.screenshot MessageBlock inline.
//
// Header: `browser.screenshot` + `{filename}` (e.g. `<n>.png`) + bytes
// count + duration. Body: an `<img>` element with `src={fileUri}` (an
// app:// URI resolved by the protocol handler in src/main/ipc/browser.ts).
// Cap-height CSS (max-height: 400px; max-width: 100%) so the chat does
// not explode when a tall screenshot is captured.
//
// Pitfall 5 / T-8-11: the PNG bytes are NEVER carried in the MessageBlock
// (only the byte count + URI). The renderer fetches the actual image via
// the app:// custom protocol handler.

import * as React from 'react';
import type { MessageBlock } from '../../shared/types';

export interface BrowserScreenshotBlockProps {
  block: Extract<MessageBlock, { kind: 'browser_screenshot' }>;
}

export function BrowserScreenshotBlock({ block }: BrowserScreenshotBlockProps): React.JSX.Element {
  const { filename, fileUri, bytes, hostname, path, fullPage, durationMs } = block;

  const safeFilename = typeof filename === 'string' ? filename : '';
  const safeFileUri = typeof fileUri === 'string' ? fileUri : '';
  const safeBytes = typeof bytes === 'number' ? bytes : 0;
  const safeHostname = typeof hostname === 'string' ? hostname : '';
  const safePath = typeof path === 'string' ? path : '';
  const safeFullPage = fullPage === true;
  const safeDuration = typeof durationMs === 'number' ? durationMs : 0;

  return (
    <div
      className="block-browser-screenshot"
      data-block-kind="browser_screenshot"
      data-filename={safeFilename}
      data-hostname={safeHostname}
      data-path={safePath}
    >
      <div className="block-header">
        <span className="block-tool-name">browser.screenshot</span>
        <span className="block-browser-screenshot-ref">{safeFilename}</span>
        <span className="block-browser-bytes" data-testid="browser-screenshot-bytes">({safeBytes} bytes)</span>
        {safeFullPage ? <span className="block-browser-fullpage">(full page)</span> : null}
        {safeHostname ? (
          <span className="block-browser-hostpath">{safeHostname}{safePath}</span>
        ) : null}
        <span className="block-browser-duration">{safeDuration}ms</span>
      </div>
      {safeFileUri ? (
        <img
          src={safeFileUri}
          alt={`screenshot ${safeFilename}`}
          className="block-browser-screenshot-img"
          data-testid="browser-screenshot-img"
          loading="lazy"
        />
      ) : (
        <div className="block-browser-screenshot-missing">No screenshot URI</div>
      )}
    </div>
  );
}
