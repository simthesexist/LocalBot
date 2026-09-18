// Workspace tree panel. Phase 3 tracer slice.
//
// The full interactive tree uses react-arborist (Phase 3 Wave 2 / 4 plan).
// For the tracer, this is a flat top-level directory list with a
// truncated indicator. The data still flows through the daemon's tree.list
// JSON-RPC, so the wiring proves end-to-end.

import { useWorkspaceTree } from '../state/tree';

export interface WorkspaceTreeProps {
  workspaceRoot: string;
  maxDepth?: number;
}

export function WorkspaceTree({ workspaceRoot, maxDepth = 1 }: WorkspaceTreeProps) {
  const tree = useWorkspaceTree({ path: workspaceRoot, maxDepth });

  return (
    <aside className="workspace-tree" data-testid="workspace-tree" aria-label="Workspace files">
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
      <ul className="workspace-tree-list">
        {tree.entries.map((e) => (
          <li
            key={e.path}
            data-testid={`workspace-entry-${e.name}`}
            className={`workspace-tree-item workspace-tree-${e.type}`}
          >
            <span className="workspace-tree-icon">{e.type === 'dir' ? '▸' : '·'}</span>
            <span className="workspace-tree-name">{e.name}</span>
          </li>
        ))}
      </ul>
      <p className="workspace-tree-hint">
        Full tree browser coming soon.
      </p>
    </aside>
  );
}
