// IPC bridge for Phase 5 Wave 2 shell approval + streaming.
//
// Wires three renderer-facing event channels and one invoke channel:
//   EVENT_SHELL_REQUEST_APPROVAL  — daemon "shell:request-approval" → renderer
//   EVENT_SHELL_TOKEN             — daemon "shell:token"             → renderer
//   EVENT_SHELL_EXIT              — daemon "shell:exit"              → renderer
//   SHELLS_RESPOND (invoke)       — renderer "shells:respond"        → daemon shell/respond
//
// The 3 events are daemon JSON-RPC notifications — `daemon/spawn.ts` fans them
// out via `onNotification(...)` and we forward them to the renderer here.
// `SHELLS_RESPOND` is the only renderer→main→daemon direction for this phase.
//
// On "allow-always" we mirror the command into the bot's `alwaysAllow.json`
// so subsequent calls in the same session skip the prompt, even before the
// daemon has its own write settled. The daemon is the source of truth; this
// mirror is a perf optimization. T-P5-08 keeps the audit line minimal: this
// handler never logs the command or any stdout/stderr.

import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import { CHANNELS } from '../../shared/ipc-channels';
import type { ShellRequestApprovalEvent, ShellTokenEvent, ShellExitEvent } from '../../shared/types';
import { onNotification, respondToShellApproval } from '../daemon/spawn';
import { alwaysAllowPath, ensureBotDir } from '../paths';

type ShellDecision = 'allow-once' | 'allow-always' | 'deny';

const NOTIFICATION_METHODS = {
  requestApproval: 'shell:request-approval',
  token: 'shell:token',
  exit: 'shell:exit',
} as const;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

async function mirrorAlwaysAllow(bot: string, command: string): Promise<void> {
  // Append-only mirror — same shape as the daemon's alwaysAllow.cjs entries.
  // We don't try to deduplicate here; if the same command is approved twice
  // the daemon's own FIFO/50 logic is what enforces the cap.
  await ensureBotDir(bot);
  const file = alwaysAllowPath(bot);
  let existing: Array<Record<string, unknown>> = [];
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) existing = parsed as Array<Record<string, unknown>>;
  } catch {
    // First write or corrupt file → start empty.
  }
  existing.push({
    command,
    approvedAt: new Date().toISOString(),
    useCount: 0,
  });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(existing, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

export function registerShellHandlers(): void {
  onNotification(NOTIFICATION_METHODS.requestApproval, (params) => {
    try {
      broadcast(CHANNELS.EVENT_SHELL_REQUEST_APPROVAL, params as ShellRequestApprovalEvent);
    } catch { /* listener errors must not break the bridge */ }
  });
  onNotification(NOTIFICATION_METHODS.token, (params) => {
    try {
      broadcast(CHANNELS.EVENT_SHELL_TOKEN, params as ShellTokenEvent);
    } catch { /* listener errors must not break the bridge */ }
  });
  onNotification(NOTIFICATION_METHODS.exit, (params) => {
    try {
      broadcast(CHANNELS.EVENT_SHELL_EXIT, params as ShellExitEvent);
    } catch { /* listener errors must not break the bridge */ }
  });

  ipcMain.handle(CHANNELS.SHELLS_RESPOND, async (_evt, raw: unknown) => {
    const obj = (raw ?? {}) as { shellId?: unknown; decision?: unknown };
    const shellId = typeof obj.shellId === 'string' ? obj.shellId : '';
    const decision = obj.decision as ShellDecision;
    if (!shellId || !['allow-once', 'allow-always', 'deny'].includes(decision)) {
      return { ok: false, error: 'invalid_args' };
    }
    const resolved = await respondToShellApproval(shellId, decision);
    if (decision === 'allow-always' && resolved) {
      try {
        await mirrorAlwaysAllow(resolved.bot, resolved.command);
      } catch {
        // Best-effort mirror; the daemon's own alwaysAllow.cjs is authoritative.
      }
    }
    return { ok: true };
  });
}

export { alwaysAllowPath };
