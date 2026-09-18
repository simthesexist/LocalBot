// Inline diff viewer. Phase 3 Wave 2.
//
// Wraps `react-diff-viewer-continued` with the Split/Unified toggle and
// binary-file placeholder per UI-SPEC §1.2 + RESEARCH.md §"Pitfall 6".
//
// Binary detection: either an explicit `binary` prop OR a NUL byte in the
// before/after bodies. The check happens BEFORE handing the strings to the
// diff viewer so it never crashes on a binary payload (Pitfall 6).

import { useState } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import type { ReactDiffViewerStylesOverride } from 'react-diff-viewer-continued';

export interface DiffViewProps {
  file: string;
  before: string;
  after: string;
  /** When true, skip the viewer entirely and render the binary placeholder. */
  binary?: boolean;
}

const DIFF_STYLES: ReactDiffViewerStylesOverride = {
  variables: {
    light: {
      diffViewerBackground: '#ffffff',
      diffViewerColor: '#111827',
      addedBackground: 'rgba(34, 197, 94, 0.16)',
      addedColor: '#065f46',
      removedBackground: 'rgba(239, 68, 68, 0.14)',
      removedColor: '#7f1d1d',
      wordAddedBackground: 'rgba(34, 197, 94, 0.35)',
      wordRemovedBackground: 'rgba(239, 68, 68, 0.35)',
      emptyLineBackground: '#f6f8fa',
      gutterBackground: '#f6f8fa',
      gutterBackgroundDark: '#eef0f2',
      diffViewerTitleBackground: '#fafafa',
      diffViewerTitleColor: '#111827',
      diffViewerTitleBorderColor: '#e5e7eb',
    },
  },
};

function isBinaryString(s: string): boolean {
  // NUL byte heuristic — first 8KB is enough.
  const slice = s.length > 8192 ? s.slice(0, 8192) : s;
  return slice.includes('\0');
}

export function DiffView({ file, before, after, binary }: DiffViewProps) {
  const [mode, setMode] = useState<'split' | 'unified'>(() =>
    typeof window !== 'undefined' && window.innerWidth >= 1024 ? 'split' : 'unified',
  );

  const isBinary = Boolean(binary) || isBinaryString(before) || isBinaryString(after);

  if (isBinary) {
    return (
      <div className="diff-view" role="region" aria-label={`Binary file ${file}`}>
        <DiffHeader file={file} mode={mode} onToggle={() => setMode((m) => (m === 'split' ? 'unified' : 'split'))} />
        <div className="binary-placeholder" data-testid="diff-binary">
          Binary file — diff unavailable
          <div className="binary-placeholder-path">Path: {file}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="diff-view" role="region" aria-label={`Diff for ${file}`} data-testid="diff-view">
      <DiffHeader file={file} mode={mode} onToggle={() => setMode((m) => (m === 'split' ? 'unified' : 'split'))} />
      <div className="diff-view-body">
        <ReactDiffViewer
          oldValue={before}
          newValue={after}
          splitView={mode === 'split'}
          compareMethod={DiffMethod.LINES}
          useDarkTheme={false}
          styles={DIFF_STYLES}
          hideLineNumbers={false}
        />
      </div>
    </div>
  );
}

interface DiffHeaderProps {
  file: string;
  mode: 'split' | 'unified';
  onToggle: () => void;
}

function DiffHeader({ file, mode, onToggle }: DiffHeaderProps) {
  return (
    <div className="diff-header">
      <span className="diff-header-file">Diff: {file}</span>
      <button
        type="button"
        className="diff-header-toggle"
        onClick={onToggle}
        aria-label={`Switch to ${mode === 'split' ? 'unified' : 'split'} view`}
      >
        {mode === 'split' ? 'Unified' : 'Split'}
      </button>
    </div>
  );
}
