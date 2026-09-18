// Workspace tree panel. Phase 3 Wave 2.
//
// Uses the lazy-loadable `useWorkspaceTree()` hook so the chokidar-backed
// `tree:refresh` event triggers an automatic re-fetch. Renders ARIA roles
// for the tree + treeitem pattern (UI-SPEC §12). Per-directory children
// are fetched on demand via a dedicated `tree:list` invocation when a node
// is expanded.

import { useEffect, useState } from 'react';
import { useWorkspaceTree } from '../state/tree';
import type { TreeNode, TreeListResult } from '../../shared/types';

export interface WorkspaceTreeProps {
  workspaceRoot: string;
  maxDepth?: number;
}

export function WorkspaceTree({ workspaceRoot, maxDepth = 5 }: WorkspaceTreeProps) {
  const tree = useWorkspaceTree({ path: workspaceRoot, maxDepth });
  const [openDirs, setOpenDirs] = useState<Record<string, TreeNode[] | null | undefined>>({});
  const [loadingDirs, setLoadingDirs] = useState<Record<string, boolean>>({});

  const toggleDir = async (node: TreeNode) => {
    const wasOpen = node.path in openDirs;
    if (wasOpen) {
      setOpenDirs((prev) => {
        const next = { ...prev };
        delete next[node.path];
        return next;
      });
      return;
    }
    // Lazy-load children on expand.
    setLoadingDirs((prev) => ({ ...prev, [node.path]: true }));
    try {
      const res = (await window.localbot.tree.list({
        path: node.path,
        maxDepth: Math.max(1, maxDepth - 1),
      })) as TreeListResult;
      setOpenDirs((prev) => ({ ...prev, [node.path]: res.entries ?? [] }));
    } catch (e) {
      setOpenDirs((prev) => ({ ...prev, [node.path]: null }));
      // eslint-disable-next-line no-console
      console.warn('[workspace-tree] expand failed', e);
    } finally {
      setLoadingDirs((prev) => ({ ...prev, [node.path]: false }));
    }
  };

  // Reset lazy state when the bound rootPath changes (the hook already
  // re-fetches, but stale entries would otherwise linger).
  useEffect(() => {
    setOpenDirs({});
    setLoadingDirs({});
  }, [workspaceRoot]);

  return (
    <aside
      className="workspace-tree"
      data-testid="workspace-tree"
      aria-label="Workspace files"
      role="tree"
    >
      <div className="workspace-tree-header">
        <span>Workspace</span>
        {tree.truncated && <span className="workspace-tree-truncated">truncated</span>}
      </div>
      {tree.loading && tree.entries.length === 0 && (
        <div className="workspace-tree-empty">loading…</div>
      )}
      {tree.error && (
        <div className="workspace-tree-error">error: {tree.error}</div>
      )}
      {!tree.loading && tree.entries.length === 0 && !tree.error && (
        <div className="workspace-tree-empty">(empty)</div>
      )}
      <ul className="workspace-tree-list" role="presentation">
        {tree.entries.map((e) => (
          <li key={e.path} className="workspace-tree-item" role="presentation">
            {e.type === 'dir' ? (
              <DirRow
                node={e}
                isOpen={e.path in openDirs}
                isLoading={Boolean(loadingDirs[e.path])}
                children={openDirs[e.path]}
                onToggle={() => void toggleDir(e)}
              />
            ) : (
              <FileRow node={e} />
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}

function FileRow({ node }: { node: TreeNode }) {
  return (
    <span
      className="workspace-tree-name workspace-tree-file"
      role="treeitem"
      aria-selected="false"
    >
      <span className="workspace-tree-icon">·</span>
      <span>{node.name}</span>
    </span>
  );
}

function DirRow({
  node,
  isOpen,
  isLoading,
  children,
  onToggle,
}: {
  node: TreeNode;
  isOpen: boolean;
  isLoading: boolean;
  children: TreeNode[] | null | undefined;
  onToggle: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="workspace-tree-name workspace-tree-dir"
        role="treeitem"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <span className="workspace-tree-icon">{isOpen ? '▾' : '▸'}</span>
        <span>{node.name}</span>
        {isLoading && <span className="workspace-tree-loading-tag">loading…</span>}
      </button>
      {isOpen && children && children.length > 0 && (
        <ul className="workspace-tree-list workspace-tree-list-children" role="group">
          {children.map((child) => (
            <li key={child.path} className="workspace-tree-item" role="presentation">
              {child.type === 'dir' ? (
                <DirRowPlaceholder node={child} />
              ) : (
                <FileRow node={child} />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Recursive-on-expand dir row — when the user clicks, the parent fetches
 * the children. This row only knows whether it's open, not its children.
 */
function DirRowPlaceholder({ node }: { node: TreeNode }) {
  // For children-of-children we just show a stub; expanding deeper triggers
  // another fetch at the parent's level. The full interactive lazy tree
  // is a Phase 4 plan.
  return (
    <span className="workspace-tree-name workspace-tree-dir" role="treeitem" aria-expanded="false">
      <span className="workspace-tree-icon">▸</span>
      <span>{node.name}</span>
    </span>
  );
}
