// Phase 8 Plan 2: browser automation IPC bridge.
//
// Wires BROWSER_GET_SCREENSHOT + BROWSER_DELETE_CONTEXT to the daemon
// equivalents, plus the `app://` custom protocol handler that resolves
// app://localhost/screenshots/<runId>/<n>.png to the absolute PNG path
// under <userData>/screenshots/. The handler is registered at app startup
// (src/main/index.ts) via `protocol.registerSchemesAsPrivileged([...])`
// BEFORE app.whenReady() (Electron requirement — the scheme must be
// declared before the first protocol.handle call).
//
// Mirrors `src/main/ipc/vault.ts` (Phase 7 Plan 1) for the IPC handler
// pattern: defense-in-depth shape validation in main + re-validation in
// the daemon (the daemon always re-validates because renderer-supplied
// payloads can be tampered with).
//
// Threat model coverage:
//   - T-8-12: runId + n validated against safe regex (no path traversal).
//     The custom protocol's filesystem access is bounded to
//     <userData>/screenshots/ via path containment.

import { ipcMain, protocol, BrowserWindow } from 'electron';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { CHANNELS } from '../../shared/ipc-channels';
import { callBot } from '../daemon/spawn';
import { screenshotDir } from '../paths';
import type {
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
  BrowserDeleteContextRequest,
} from '../../shared/types';

// Regex guards mirror the daemon-side quota check. The renderer must
// never be able to inject path-traversal sequences (../) into the
// app:// URI, so runId + n are constrained to a safe alphabet. The
// daemon-side browser_screenshot tool uses the same regex for `n`;
// runId is provided by main (toolCallId) so the regex is defense in depth.
const RUN_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const N_REGEX = /^[a-zA-Z0-9._-]{1,32}$/;

function isScreenshotRequest(value: unknown): value is BrowserScreenshotRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.runId === 'string' && typeof v.n === 'string';
}

function isDeleteContextRequest(value: unknown): value is BrowserDeleteContextRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.bot === 'string' && v.bot.length > 0;
}

/**
 * Build the app:// URI for a screenshot. The handler below parses the
 * URI and resolves it under <userData>/screenshots/.
 */
function buildScreenshotUri(runId: string, n: string): string {
  return `app://localhost/screenshots/${runId}/${n}.png`;
}

/**
 * Resolve a screenshot file path from an app:// request URL. The
 * pathname is parsed into `/screenshots/<runId>/<n>.png`; we extract +
 * re-validate runId + n against the safe regexes and compose the
 * absolute path under `<userData>/screenshots/`. Returns the absolute
 * path on success or null on validation failure.
 */
function resolveScreenshotPath(requestUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  // pathname looks like '/screenshots/<runId>/<n>.png'.
  const parts = parsed.pathname.split('/').filter((p) => p.length > 0);
  if (parts.length < 3 || parts[0] !== 'screenshots') return null;
  const runId = parts[1];
  const filename = parts.slice(2).join('/');
  // filename must be exactly `<n>.png` (no nested dirs allowed).
  if (!filename.endsWith('.png')) return null;
  const n = filename.slice(0, -'.png'.length);
  if (!RUN_ID_REGEX.test(runId) || !N_REGEX.test(n)) return null;
  // Containment: build the absolute path and verify it stays inside
  // <userData>/screenshots/. The regex + simple join should be enough
  // but defense in depth — `..` cannot appear in runId/n because the
  // regex forbids it.
  const baseDir = screenshotDir();
  const absPath = path.join(baseDir, runId, `${n}.png`);
  const normalized = path.normalize(absPath);
  if (!normalized.startsWith(path.normalize(baseDir) + path.sep) &&
      normalized !== path.normalize(baseDir)) {
    return null;
  }
  return normalized;
}

let protocolRegistered = false;

export function registerBrowserHandlers(): void {
  // 1) Register the custom protocol handler. Idempotent — calling
  // protocol.handle twice for the same scheme throws, but we only call
  // it once (guarded by protocolRegistered). The handler resolves
  // app://localhost/screenshots/<runId>/<n>.png to the absolute path
  // under <userData>/screenshots/. ENOENT → 404; other errors → 500.
  if (!protocolRegistered) {
    protocolRegistered = true;
    try {
      protocol.handle('app', async (request) => {
        try {
          const absPath = resolveScreenshotPath(request.url);
          if (!absPath) {
            return new Response('not found', { status: 404 });
          }
          // Read the file synchronously would be cheaper but fs.promises
          // is the canonical API; the renderer typically awaits 1-2
          // <img> loads at a time so the overhead is fine.
          const data = await readFile(absPath);
          return new Response(data, {
            headers: {
              'Content-Type': 'image/png',
              'Cache-Control': 'no-cache',
            },
          });
        } catch (e) {
          const err = e as NodeJS.ErrnoException;
          if (err && err.code === 'ENOENT') {
            return new Response('not found', { status: 404 });
          }
          return new Response(`error: ${(e as Error).message}`, { status: 500 });
        }
      });
    } catch (e) {
      // protocol.handle throws if called more than once or if the scheme
      // was not declared via registerSchemesAsPrivileged before
      // app.whenReady(). We log + swallow so a partial setup doesn't
      // brick the IPC handlers below.
      // eslint-disable-next-line no-console
      console.error('registerBrowserHandlers: protocol.handle failed', e);
    }
  }

  // 2) BROWSER_GET_SCREENSHOT — resolve the URI for a given runId + n.
  // Main NEVER reads PNG bytes; the renderer fetches them via the
  // app:// handler.
  ipcMain.handle(
    CHANNELS.BROWSER_GET_SCREENSHOT,
    async (_evt, req: unknown): Promise<BrowserScreenshotResult> => {
      if (!isScreenshotRequest(req)) {
        return { ok: false, error: 'invalid_request' };
      }
      if (!RUN_ID_REGEX.test(req.runId) || !N_REGEX.test(req.n)) {
        return { ok: false, error: 'invalid_path' };
      }
      try {
        // Forward to the daemon so the byte count is read from the
        // canonical file. The daemon is the single writer of
        // <userData>/screenshots/ (Pitfall: renderer never writes there).
        const result = (await callBot('browser/get_screenshot', {
          runId: req.runId,
          n: req.n,
        })) as { ok?: boolean; bytes?: number; error?: string };
        const fileUri = buildScreenshotUri(req.runId, req.n);
        return {
          ok: result?.ok === true,
          fileUri,
          bytes: typeof result?.bytes === 'number' ? result.bytes : undefined,
          error: result?.error,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  // 3) BROWSER_DELETE_CONTEXT — close + remove the per-bot
  // BrowserContext (Pitfall 7). Called from the renderer when a bot is
  // deleted OR when the user wants to immediately forget cookies.
  ipcMain.handle(
    CHANNELS.BROWSER_DELETE_CONTEXT,
    async (_evt, req: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (!isDeleteContextRequest(req)) {
        return { ok: false, error: 'invalid_request' };
      }
      try {
        const result = (await callBot('browser/delete_context', { bot: req.bot })) as {
          ok?: boolean;
          error?: string;
        };
        return { ok: result?.ok === true, error: result?.error };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );
}
