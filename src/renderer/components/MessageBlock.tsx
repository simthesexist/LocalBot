// Discriminated renderer for a single MessageBlock. The Phase 1 bubble
// wrapped `content: string`; Phase 2 introduces blocks so a single assistant
// turn can render text + tool_use + tool_result inline.

import * as React from 'react';
import type { MessageBlock as Block } from '../../shared/types';
import { ToolUseBlock } from './ToolUseBlock';
import { ToolResultBlock } from './ToolResultBlock';

export interface MessageBlockProps {
  block: Block;
}

export function MessageBlock({ block }: MessageBlockProps): React.JSX.Element | null {
  switch (block.kind) {
    case 'text':
      return <div className="block-text">{block.text}</div>;
    case 'tool_use':
      return <ToolUseBlock name={block.name} input={block.input} />;
    case 'tool_result':
      return <ToolResultBlock content={block.content} isError={block.isError} />;
    default: {
      // Exhaustiveness check — TS will error here if a new kind is added
      // without a renderer branch.
      const _exhaustive: never = block;
      void _exhaustive;
      return null;
    }
  }
}
