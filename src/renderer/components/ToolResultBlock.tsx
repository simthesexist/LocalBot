// Render a single tool_result block. Output goes into a <pre>. Long output
// collapses past 500 chars with a "Show more" toggle. Errors tint the block.

import * as React from 'react';
import { useState } from 'react';

export interface ToolResultBlockProps {
  content: string;
  isError: boolean;
}

const COLLAPSE_THRESHOLD = 500;

export function ToolResultBlock({ content, isError }: ToolResultBlockProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  // Empty content still renders — useful for the LLM's view that a tool
  // returned no payload.
  const safe = content ?? '';
  // Byte-counted length (UTF-8). For ASCII the visible chars match exactly.
  const byteLen = new TextEncoder().encode(safe).length;
  const shouldCollapse = byteLen > COLLAPSE_THRESHOLD;
  const visible = shouldCollapse && !expanded ? safe.slice(0, COLLAPSE_THRESHOLD) + '…' : safe;

  return (
    <div
      className={`block-tool-result ${isError ? 'block-result-error' : ''}`}
      data-error={isError ? 'true' : 'false'}
    >
      <pre className="block-tool-output">{visible}</pre>
      {shouldCollapse && (
        <button
          type="button"
          className="block-show-more"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
