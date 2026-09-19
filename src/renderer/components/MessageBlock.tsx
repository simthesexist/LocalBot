// Discriminated renderer for a single MessageBlock. The Phase 1 bubble
// wrapped `content: string`; Phase 2 introduces blocks so a single assistant
// turn can render text + tool_use + tool_result inline.
//
// Phase 3 Wave 2: tool_result blocks whose matching tool_use has
// `name === 'edit_file'` and whose parsed content carries `{file, before,
// after}` (or `{binary, file}`) render a `<DiffView>` instead of the plain
// `<ToolResultBlock>`. Binary payloads fall back to the placeholder.

import * as React from 'react';
import type { MessageBlock as Block } from '../../shared/types';
import { ToolUseBlock } from './ToolUseBlock';
import { ToolResultBlock } from './ToolResultBlock';
import { DiffView } from './DiffView';
import { ShellStreamBlock } from './ShellStreamBlock';

export interface MessageBlockProps {
  block: Block;
  /** Phase 3 Wave 2: live `tool_use_id → {name, input}` lookup for DiffView. */
  toolUseBlocks?: Record<string, { name: string; input: unknown }>;
}

interface EditFileResult {
  file: string;
  before: string;
  after: string;
  binary?: boolean;
}

function tryParseEditFilePayload(content: string): EditFileResult | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const obj = JSON.parse(trimmed) as Partial<EditFileResult>;
    if (typeof obj.file !== 'string') return null;
    if (typeof obj.before === 'string' && typeof obj.after === 'string') {
      return {
        file: obj.file,
        before: obj.before,
        after: obj.after,
        binary: obj.binary === true,
      };
    }
    if (obj.binary === true) {
      return { file: obj.file, before: '', after: '', binary: true };
    }
    return null;
  } catch {
    return null;
  }
}

export function MessageBlock({ block, toolUseBlocks }: MessageBlockProps): React.JSX.Element | null {
  switch (block.kind) {
    case 'text':
      return <div className="block-text">{block.text}</div>;
    case 'tool_use':
      return <ToolUseBlock name={block.name} input={block.input} />;
    case 'tool_result': {
      // Phase 3 Wave 2: edit_file diff rendering.
      const source = toolUseBlocks?.[block.toolUseId];
      if (source?.name === 'edit_file') {
        const parsed = tryParseEditFilePayload(block.content);
        if (parsed) {
          return (
            <DiffView
              file={parsed.file}
              before={parsed.before}
              after={parsed.after}
              binary={parsed.binary}
            />
          );
        }
      }
      return <ToolResultBlock content={block.content} isError={block.isError} />;
    }
    case 'summary':
      return (
        <div className="bubble bubble-summary" data-testid="summary-block-inline">
          <div className="summary-badge">Conversation summarized</div>
          <div className="summary-body">{block.summary.summary}</div>
          <div className="summary-meta">
            {block.summary.turnsFolded} turns folded, summarizer ran at {block.summary.ranAt}
          </div>
        </div>
      );
    case 'shell_stream':
      return <ShellStreamBlock block={block} />;
    default: {
      // Exhaustiveness check — TS will error here if a new kind is added
      // without a renderer branch.
      const _exhaustive: never = block;
      void _exhaustive;
      return null;
    }
  }
}
