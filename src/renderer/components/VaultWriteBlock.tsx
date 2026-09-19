// Phase 7 Plan 2: render a vault.write MessageBlock inline.
//
// Compact view: path header + bytesWritten footer. The full content is
// NOT echoed back (the renderer would have to ship the LLM-written
// content through a separate block; the user can re-read via vault.read
// if they want to verify the write).

import * as React from 'react';
import type { MessageBlock } from '../../shared/types';

export interface VaultWriteBlockProps {
  block: Extract<MessageBlock, { kind: 'vault_write' }>;
}

export function VaultWriteBlock({ block }: VaultWriteBlockProps): React.JSX.Element {
  const { path, bytesWritten } = block;
  return (
    <div
      className="block-vault-write"
      data-block-kind="vault_write"
      data-vault-path={path}
      data-bytes-written={bytesWritten}
    >
      <div className="block-header">
        <span className="block-tool-name">vault.write</span>
        <span className="block-vault-path">{path}</span>
      </div>
      <div className="block-footer block-vault-bytes-written">
        {bytesWritten} bytes written
      </div>
    </div>
  );
}