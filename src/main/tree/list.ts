// Tree list wrapper. Phase 3 Wave 2.
//
// Thin wrapper over `spawn.callTree('tree/list', ...)` so IPC handlers
// (history, chat, future plans) can call a typed helper instead of building
// the JSON-RPC envelope inline each time.

import { callTree } from '../daemon/spawn';
import { startTreeWatcher } from './watcher';
import type { TreeNode } from '../../shared/types';

export interface ListTreeOptions {
  maxDepth?: number;
  maxEntriesPerDir?: number;
  exclude?: string[];
  bot?: string;
}

export interface ListTreeResult {
  entries: TreeNode[];
  truncated: boolean;
}

/**
 * List a workspace subtree by calling the daemon's `tree/list` JSON-RPC.
 * Defaults mirror the daemon's `list_tree.cjs` module (maxDepth=5,
 * maxEntriesPerDir=500).
 */
export async function listTree(rootPath: string, opts: ListTreeOptions = {}): Promise<ListTreeResult> {
  const args: Record<string, unknown> = { path: rootPath };
  if (typeof opts.maxDepth === 'number') args.maxDepth = opts.maxDepth;
  if (typeof opts.maxEntriesPerDir === 'number') args.maxEntriesPerDir = opts.maxEntriesPerDir;
  if (Array.isArray(opts.exclude)) args.exclude = opts.exclude;
  if (typeof opts.bot === 'string') args.bot = opts.bot;
  const result = (await callTree('tree/list', args)) as { entries: TreeNode[]; truncated: boolean };
  return {
    entries: Array.isArray(result?.entries) ? result.entries : [],
    truncated: Boolean(result?.truncated),
  };
}

let watcherStarted = false;

/**
 * Ensure the daemon's tree:refresh subscription is wired so renderer-side
 * listeners can react to file changes. Idempotent.
 */
export function ensureTreeWatcherStarted(): void {
  if (watcherStarted) return;
  startTreeWatcher();
  watcherStarted = true;
}
