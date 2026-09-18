// Workspace tree state hook. Phase 3 tracer slice.
//
// Fetches TreeListResult via window.localbot.tree.list({path, maxDepth,
// exclude}) and exposes it for WorkspaceTree. The maxDepth defaults to 2
// for the placeholder pill — full tree browsing is a follow-up plan.

import { useEffect, useState, useCallback } from 'react';
import type { TreeListResult } from '../../shared/types';

export interface TreeState {
  path: string;
  entries: TreeListResult['entries'];
  truncated: boolean;
  loading: boolean;
  error: string | null;
}

const INITIAL: Omit<TreeState, 'path'> = {
  entries: [],
  truncated: false,
  loading: false,
  error: null,
};

export function useWorkspaceTree(opts: { path: string; maxDepth?: number; exclude?: string[] }): TreeState & { refresh: () => Promise<void> } {
  const [state, setState] = useState<TreeState>({
    ...INITIAL,
    path: opts.path,
  });

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = (await window.localbot.tree.list({
        path: opts.path,
        maxDepth: opts.maxDepth ?? 2,
        exclude: opts.exclude ?? [
          'node_modules',
          '.git',
          '.next',
          'dist',
          'target',
          '__pycache__',
          '.venv',
        ],
      })) as TreeListResult;
      setState({
        path: opts.path,
        entries: result.entries,
        truncated: result.truncated,
        loading: false,
        error: null,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: (err as Error).message,
      }));
    }
  }, [opts.path, opts.maxDepth, opts.exclude]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...state, refresh };
}
