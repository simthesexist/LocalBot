// Phase 5 Wave 2: renderer-side store for shell approvals + live streams.
//
// `useShellApprovals` returns a queue of pending ApprovalRequest objects
// (FIFO) plus the respond() function the modal calls. The queue is keyed by
// shellId so duplicate events from a flaky IPC fan-out are no-ops.
//
// `useShellStream` returns the live state for a given shellId (stdout/stderr
// lines appended as they arrive, plus the final exit code). Components that
// render a `shell_stream` block subscribe via this hook.

import { useEffect, useState, useCallback } from 'react';
import type {
  ApprovalRequest,
  ShellExitEvent,
  ShellTokenEvent,
} from '../../shared/types';

interface PendingApproval extends ApprovalRequest {
  /** True while the IPC round-trip to the daemon is in flight. */
  responding?: boolean;
}

interface ShellStreamState {
  shellId: string;
  command: string;
  bot: string;
  approvedBy: 'user-once' | 'user-always' | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number | null;
  isError: boolean;
  startedAt: number;
  /** True until the matching shell:exit arrives. */
  streaming: boolean;
}

const pending: PendingApproval[] = [];
const subscribers = new Set<() => void>();
const streams = new Map<string, ShellStreamState>();
const streamSubs = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

function notifyStreams(): void {
  for (const cb of streamSubs) cb();
}

export function useShellApprovals(): {
  pending: PendingApproval[];
  respond: (shellId: string, decision: 'allow-once' | 'allow-always' | 'deny') => Promise<void>;
  dismiss: (shellId: string) => void;
} {
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force((n) => n + 1);
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }, []);

  const respond = useCallback(async (shellId: string, decision: 'allow-once' | 'allow-always' | 'deny') => {
    const item = pending.find((p) => p.shellId === shellId);
    if (item) item.responding = true;
    notify();
    try {
      await window.localbot.shell.respond(shellId, decision);
    } finally {
      // Drop the request from the local queue; the daemon's pendingApprovals
      // map will resolve/reject in parallel and the spawn either runs or is
      // aborted. Either way, the modal should close.
      const idx = pending.findIndex((p) => p.shellId === shellId);
      if (idx >= 0) pending.splice(idx, 1);
      notify();
    }
  }, []);

  const dismiss = useCallback((shellId: string) => {
    const idx = pending.findIndex((p) => p.shellId === shellId);
    if (idx >= 0) pending.splice(idx, 1);
    notify();
  }, []);

  return { pending: [...pending], respond, dismiss };
}

export function useShellStream(shellId: string | null): ShellStreamState | null {
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force((n) => n + 1);
    streamSubs.add(cb);
    return () => {
      streamSubs.delete(cb);
    };
  }, []);
  if (!shellId) return null;
  return streams.get(shellId) ?? null;
}

/**
 * Subscribe to the 3 daemon → renderer shell event channels. Mounted once at
 * the App root (in App.tsx) so the listener set is stable for the session.
 */
export function attachShellEventListeners(): () => void {
  const offApproval = window.localbot.on('shell:request-approval', (payload) => {
    const p = payload as ApprovalRequest;
    if (!p || typeof p.shellId !== 'string') return;
    if (pending.some((q) => q.shellId === p.shellId)) return; // dedupe
    pending.push({
      shellId: p.shellId,
      command: p.command,
      bot: p.bot,
      requestedAt: p.requestedAt ?? Date.now(),
    });
    notify();
    // Seed the stream entry so ShellStreamBlock has somewhere to render to
    // before any token arrives. `exitCode: null` + `streaming: true` while
    // the approval modal is open.
    streams.set(p.shellId, {
      shellId: p.shellId,
      command: p.command,
      bot: p.bot,
      approvedBy: null,
      stdout: '',
      stderr: '',
      exitCode: null,
      durationMs: null,
      isError: false,
      startedAt: Date.now(),
      streaming: true,
    });
    notifyStreams();
  });
  const offToken = window.localbot.on('shell:token', (payload) => {
    const p = payload as ShellTokenEvent;
    if (!p || typeof p.shellId !== 'string') return;
    const s = streams.get(p.shellId);
    if (!s) return;
    if (p.stream === 'stdout') {
      s.stdout += p.line.endsWith('\n') ? p.line : `${p.line}\n`;
    } else {
      s.stderr += p.line.endsWith('\n') ? p.line : `${p.line}\n`;
    }
    notifyStreams();
  });
  const offExit = window.localbot.on('shell:exit', (payload) => {
    const p = payload as ShellExitEvent;
    if (!p || typeof p.shellId !== 'string') return;
    const s = streams.get(p.shellId);
    if (!s) return;
    s.exitCode = p.exitCode;
    s.durationMs = p.durationMs;
    s.isError = p.isError;
    s.streaming = false;
    notifyStreams();
  });
  return () => {
    offApproval();
    offToken();
    offExit();
  };
}

export type { PendingApproval, ShellStreamState };
