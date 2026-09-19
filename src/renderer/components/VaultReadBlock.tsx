// Phase 7 Plan 2: render a vault.read MessageBlock inline.
//
// Mirrors ToolResultBlock (byte-counted collapse past 500 UTF-8 bytes +
// single-line bypass) but adds a path header + bytes footer so the user
// can see which vault file was read and how big it was. Errors tint
// the block red (the renderer surfaces isError via the parent tool_result
// block; this component assumes the block came back successfully — for
// error variants the parent MessageBlock dispatch falls back to the
// ToolResultBlock path).

import * as React from 'react';
import { useState } from 'react';
import type { MessageBlock } from '../../shared/types';

export interface VaultReadBlockProps {
  block: Extract<MessageBlock, { kind: 'vault_read' }>;
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

export function VaultReadBlock({ block }: VaultReadBlockProps): React.JSX.Element {
  const { path, content, bytes, startLine, endLine, truncated } = block;
  const [expanded, setExpanded] = useState(false);

  const isSingleLine = !content.includes('\n');
  const shouldCollapse = !isSingleLine && utf8ByteLength(content) > COLLAPSE_THRESHOLD_BYTES;

  let visible = content;
  if (shouldCollapse && !expanded) {
    visible = sliceAtUtf8Bytes(content, COLLAPSE_THRESHOLD_BYTES);
  }

  return (
    <div
      className="block-vault-read"
      data-block-kind="vault_read"
      data-vault-path={path}
    >
      <div className="block-header">
        <span className="block-tool-name">vault.read</span>
        <span className="block-vault-path">{path}</span>
        {bytes ? <span className="block-vault-bytes">({bytes} bytes)</span> : null}
        {(startLine !== undefined || endLine !== undefined) && (
          <span className="block-vault-range">
            lines {startLine ?? 1}-{endLine ?? '?'}
          </span>
        )}
        {truncated && <span className="block-vault-truncated">(truncated)</span>}
      </div>
      <pre className="block-vault-content">{visible}</pre>
      {shouldCollapse && (
        <button
          type="button"
          className="collapse-toggle"
          onClick={() => setExpanded((v) => !v)}
          data-testid="collapse-vault-read"
        >
          {expanded
            ? 'Show less'
            : `Show all ${bytes} bytes`}
        </button>
      )}
    </div>
  );
}