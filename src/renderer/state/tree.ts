// Workspace tree state hook. Phase 3 Wave 2.
//
// Fetches TreeListResult via window.localbot.tree.list({path, maxDepth,
// exclude}) and exposes it for WorkspaceTree. Subscribes to `tree:refresh`
// events from the daemon's chokidar watcher and re-invokes tree:list when
// the bound path matches the event's rootPath prefix.

import { useEffect, useState, useCallback } from 'react';
import type { TreeListResult, TreeRefreshEvent } from '../../shared/types';

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

export interface UseWorkspaceTreeApi extends TreeState {
  refresh: () => Promise<void>;
}

export function useWorkspaceTree(opts: { path: string; maxDepth?: number; exclude?: string[] }): UseWorkspaceTreeApi {
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
    const off = window.localbot.on('tree:refresh', ((p: TreeRefreshEvent) => {
      // Only refresh when the event's rootPath is a prefix of our bound
      // path (or vice versa) — chokidar emits one event per root.
      const eventRoot = p?.rootPath ?? '';
      if (!eventRoot) return;
      // Normalize for prefix comparison on Windows.
      const normalize = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/g, '');
      const e = normalize(eventRoot);
      const bound = normalize(opts.path);
      if (e === bound || e.startsWith(bound + '/') || bound.startsWith(e + '/')) {
        void refresh();
      }
    }) as (p: unknown) => void);
    return () => off();
  }, [refresh, opts.path]);

  return { ...state, refresh };
}
