// Render a single tool_use block: header with tool name + collapsed JSON input.

import * as React from 'react';
import { useState } from 'react';

export interface ToolUseBlockProps {
  name: string;
  input: unknown;
}

const COLLAPSE_THRESHOLD = 500;

export function ToolUseBlock({ name, input }: ToolUseBlockProps): React.JSX.Element {
  const json = JSON.stringify(input, null, 2) ?? '{}';
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = json.length > COLLAPSE_THRESHOLD;
  const visible = shouldCollapse && !expanded ? json.slice(0, COLLAPSE_THRESHOLD) + '…' : json;

  return (
    <div className="block-tool-use" data-tool={name}>
      <div className="block-tool-use-header">
        <span className="block-tool-name">{name}</span>
      </div>
      <pre className="block-tool-input">{visible}</pre>
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
