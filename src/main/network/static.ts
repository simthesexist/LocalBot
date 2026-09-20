// Phase 9 Plan 1: phone-bundle static file server.
//
// Serves the built phone UI from `<userData>/phone-bundle` via the existing
// http.createServer that wraps the WS server. The phone UI lives at
// `index.html` and an `/assets/...` tree of compiled JS/CSS/SVG/PNG. The
// single security invariant is the path-traversal guard: every request
// path that contains `..` (or escapes `rootDir` after path.normalize) is
// rejected with 403 BEFORE fs.existsSync sees it. The plan also requires
// `/` (or `/index.html`) to serve the SPA shell; every other path 404s
// (the router lives client-side in Wave 2's Composer + MessageBubble).
//
// Wave 1 ships an empty bundle (<userData>/phone-bundle/index.html only).
// The static server is the spine that Wave 2's `npm run build:phone`
// output drops into that directory; today it just returns 404 for any path
// other than `/` and `/index.html`.

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

const INDEX_FILE = 'index.html';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function contentTypeFor(p: string): string {
  const ext = path.extname(p).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function safeJoin(rootDir: string, relPath: string): string | null {
  // path.join never escapes via '..' on its own; we MUST add a containment
  // check (resolved path must start with `rootDir + path.sep` OR equal
  // `rootDir` exactly). This guards against the URL being
  // `/assets/../config.cjs` which `path.join(rootDir, 'assets/../config.cjs')`
  // collapses to `<rootDir>/config.cjs` — outside the bundle.
  const normalizedRoot = path.normalize(rootDir);
  const full = path.normalize(path.join(normalizedRoot, relPath));
  if (full !== normalizedRoot && !full.startsWith(normalizedRoot + path.sep)) {
    return null;
  }
  return full;
}

export interface ServePhoneBundleOptions {
  /** Resolves the SPA shell at `/` and `/index.html`. */
  indexFile?: string;
  /**
   * Override the bundle root. Defaults to `phoneBundleDir` in startNetworkServer.
   * Tests pass a tmp dir so they don't depend on `<userData>`.
   */
  rootDir: string;
}

/**
 * Handle one HTTP request from the network server. Returns true when the
 * response was fully written (including 404 / 403 fallbacks) so the WS layer
 * knows to leave the request alone. Test seam: `__test__` in src/main/network/index.ts
 * re-exports this function so unit cases can drive it with synthetic req/res.
 */
export function servePhoneBundle(req: http.IncomingMessage, res: http.ServerResponse, rootDir: string): void {
  const indexFile = 'index.html';
  void (req as unknown as Record<string, unknown>); // currently unused beyond URL

  const urlPath = ((req.url ?? '/').split('?')[0] || '/');

  // SPA shell — `/` and `/index.html` always serve the phone entry point.
  if (urlPath === '/' || urlPath === '/index.html') {
    const full = safeJoin(rootDir, indexFile);
    if (!full) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(full)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': contentTypeFor(full) });
    const stream = fs.createReadStream(full);
    // Surface stream errors as 500 instead of leaving them uncaught.
    stream.on('error', () => {
      if (!res.writableEnded) {
        res.writeHead(500).end();
      }
    });
    stream.pipe(res);
    return;
  }

  // Assets tree — anything else that LOOKS like an asset (under `/assets/...`)
  // is served from disk; the path-traversal guard rejects anything that
  // escapes the bundle root.
  if (urlPath.startsWith('/assets/')) {
    const rel = urlPath.slice('/assets/'.length);
    if (rel.includes('..') || rel.includes('\0')) {
      // Belt + suspenders: the safeJoin check would also reject these,
      // but rejecting early avoids wasted fs ops for obvious traversal.
      res.writeHead(403).end();
      return;
    }
    const full = safeJoin(rootDir, path.join('assets', rel));
    if (!full) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': contentTypeFor(full) });
    const stream = fs.createReadStream(full);
    // Surface stream errors as 500 instead of leaving them uncaught
    // (closure during cleanup can race with in-flight reads).
    stream.on('error', () => {
      if (!res.writableEnded) {
        res.writeHead(500).end();
      }
    });
    stream.pipe(res);
    return;
  }

  // Everything else — 404. The phone app is purely client-side routed,
  // so any non-asset path returns the SPA shell in production (Wave 2);
  // for now 404 is the safe default so we don't accidentally reflect a
  // probe path back to the client.
  res.writeHead(404).end();
}

// `ServePhoneBundleOptions` is reserved for future tests (parameterized rootDir).
// Wave 1's test plan uses positional args; the interface is documented here
// so the type surface is forward-compatible with Wave 2.
export type { ServePhoneBundleOptions as _ServePhoneBundleOptions };
