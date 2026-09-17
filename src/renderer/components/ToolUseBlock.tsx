// Render a single tool_use block: header with tool name + collapsed JSON input.
// Mirrors the ToolResultBlock collapse pattern (byte-counted via TextEncoder,
// single-line bypass, empty input renders as `{}`).

import * as React from 'react';
import { useState } from 'react';

export interface ToolUseBlockProps {
  name: string;
  input: unknown;
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

export function ToolUseBlock({ name, input }: ToolUseBlockProps): React.JSX.Element {
  const json = JSON.stringify(input, null, 2) ?? '{}';
  const [expanded, setExpanded] = useState(false);

  const isSingleLine = !json.includes('\n');
  const byteLen = utf8ByteLength(json);
  const shouldCollapse = !isSingleLine && byteLen > COLLAPSE_THRESHOLD_BYTES;

  let visible = json;
  if (shouldCollapse && !expanded) {
    visible = sliceAtUtf8Bytes(json, COLLAPSE_THRESHOLD_BYTES);
  }

  return (
    <div
      className="block-tool-use"
      data-block-kind="tool_use"
      data-tool-name={name}
    >
      <div className="block-tool-use-header">
        <span className="block-tool-name">{name}</span>
      </div>
      <pre className="block-tool-input">{visible}</pre>
      {shouldCollapse && (
        <button
          type="button"
          className="collapse-toggle"
          onClick={() => setExpanded((v) => !v)}
          data-testid="collapse-use"
        >
          {expanded
            ? 'Show less'
            : `Show more (+${byteLen - COLLAPSE_THRESHOLD_BYTES} bytes)`}
        </button>
      )}
    </div>
  );
}
