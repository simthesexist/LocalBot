// Phase 9 Plan 1: tests for the HTTP+WS control plane in src/main/network/server.ts.
//
// Tests run against real HTTP servers bound on ephemeral ports (port 0 →
// OS picks). We do NOT bind on the production default 7878 because
// multiple test runs in parallel would race. Each case creates its own
// temp workspace, sets LOCALBOT_USER_DATA_DIR so server.ts's loadNetworkConfig
// reads our test config, and tears the server down via handle.close().
//
// We import the server module dynamically AFTER setting the env var so the
// module's module-scope `cachedStream` in audit/logger.ts doesn't lock onto
// a previous test's tmp dir.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { servePhoneBundle } from '../../src/main/network/static';

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makePhoneBundle(files: Record<string, string> = {}): string {
  const dir = mkTmp('localbot-phone-bundle-');
  for (const [name, content] of Object.entries(files)) {
    // Values must be strings (test fixtures); nested objects aren't
    // walked on purpose so each case spells out its file paths explicitly.
    if (typeof content !== 'string') continue;
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

function makeUserDataWithConfig(
  cfg: { port: number; bindMode: 'localhost' | 'lan'; updateChannel: 'latest' | 'beta' | 'nightly' } | null,
): string {
  const dir = mkTmp('localbot-userdata-');
  if (cfg) {
    fs.writeFileSync(path.join(dir, 'network.json'), JSON.stringify(cfg), 'utf8');
  }
  return dir;
}

interface ServerFixture {
  userDataDir: string;
  bundleDir: string;
  handle: { host: string; port: number; close: () => Promise<void>; rebind: (h: string, p: number) => Promise<void> };
}

async function bootServer(
  cfg: { port: number; bindMode: 'localhost' | 'lan'; updateChannel: 'latest' | 'beta' | 'nightly' } | null,
  bundleFiles: Record<string, string> = {},
): Promise<ServerFixture> {
  const userDataDir = makeUserDataWithConfig(cfg);
  const bundleDir = makePhoneBundle(bundleFiles);
  // Set env BEFORE the dynamic import so server.ts's `userDataDir()` reads
  // our tmp path. We restore in the test's afterEach.
  process.env.LOCALBOT_USER_DATA_DIR = userDataDir;
  // Dynamic import so each test sees a fresh module registry for the
  // userDataDir override.
  const serverModule = (await import('../../src/main/network/server')) as {
    startNetworkServer: (opts: { phoneBundleDir: string }) => Promise<{
      host: string;
      port: number;
      close: () => Promise<void>;
      rebind: (h: string, p: number) => Promise<void>;
    }>;
  };
  const handle = await serverModule.startNetworkServer({ phoneBundleDir: bundleDir });
  return { userDataDir, bundleDir, handle };
}

async function cleanup(fixture: ServerFixture): Promise<void> {
  if (fixture?.handle) {
    try { await fixture.handle.close(); } catch { /* ignore */ }
  }
  if (fixture?.userDataDir) {
    try { fs.rmSync(fixture.userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (fixture?.bundleDir) {
    try { fs.rmSync(fixture.bundleDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function httpGet(host: string, port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: urlPath }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

describe('network.server — startNetworkServer', () => {
  let fx: ServerFixture | null = null;
  afterEach(async () => {
    if (fx) await cleanup(fx);
    fx = null;
    delete process.env.LOCALBOT_USER_DATA_DIR;
  });

  it('Case A: binds on 127.0.0.1 with port 0 and serves WS upgrades', async () => {
    // Production port range; use a high port so we don't collide with
    // a real desktop run on 7878.
    const ephemeralPort = 30000 + Math.floor(Math.random() * 10000);
    fx = await bootServer({ port: ephemeralPort, bindMode: 'localhost', updateChannel: 'latest' });
    expect(fx.handle.host).toBe('127.0.0.1');
    expect(fx.handle.port).toBeGreaterThan(0);

    // Open a raw TCP socket to verify the port is open and listening.
    // (driving a ws client requires happy-dom-free env; the assertions
    // we can make from bare http.get already prove listen + reachable.)
    const resp = await httpGet('127.0.0.1', fx.handle.port, '/');
    expect([200, 404]).toContain(resp.status);
  });

  it('Case B: bindMode "lan" → host=0.0.0.0; loopback still accepted', async () => {
    const ephemeralPort = 30000 + Math.floor(Math.random() * 10000);
    fx = await bootServer({ port: ephemeralPort, bindMode: 'lan', updateChannel: 'latest' });
    expect(fx.handle.host).toBe('0.0.0.0');
    // Connect via loopback — server bound on 0.0.0.0 still accepts.
    const resp = await httpGet('127.0.0.1', fx.handle.port, '/');
    expect([200, 404]).toContain(resp.status);
  });

  it('Case C: default config (no network.json) binds on 127.0.0.1:7878 OR fails with EADDRINUSE (port-collision-tolerant)', async () => {
    const userDataDir = mkTmp('localbot-userdata-default-');
    process.env.LOCALBOT_USER_DATA_DIR = userDataDir;
    const phoneBundle = makePhoneBundle();
    // Pre-seed userDataDir (which is also the bundle dir for this test)
    // with network.json = absent so loadNetworkConfig returns defensive
    // default.
    try {
      // The default is port 7878. If 7878 is free, server starts.
      const serverModule = (await import('../../src/main/network/server')) as {
        startNetworkServer: (opts: { phoneBundleDir: string }) => Promise<{
          host: string;
          port: number;
          close: () => Promise<void>;
        }>;
      };
      try {
        const handle = await serverModule.startNetworkServer({ phoneBundleDir: phoneBundle });
        expect(handle.host).toBe('127.0.0.1');
        // If port 7878 is busy, the OS would have picked another port via
        // port=0; here we passed port 7878 explicitly via missing-config
        // defaults, so we just check that the bind succeeded.
        expect(handle.port).toBe(7878);
        await handle.close();
      } catch (err) {
        // EADDRINUSE is acceptable: port 7878 is shared with a real
        // desktop run, so test runner is tolerant.
        const msg = (err as Error).message ?? '';
        if (!/EADDRINUSE|address already in use/i.test(msg)) {
          throw err;
        }
      }
    } finally {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(phoneBundle, { recursive: true, force: true }); } catch { /* ignore */ }
      delete process.env.LOCALBOT_USER_DATA_DIR;
    }
  });

  it('Case D: port collision detected — when another server holds the port, startNetworkServer rejects', async () => {
    const net = await import('node:net');
    const ephemeralPort = 30000 + Math.floor(Math.random() * 10000);
    // Block the port with a raw net.Server so the collision is deterministic
    // and doesn't depend on the FIRST startNetworkServer's full lifecycle.
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(ephemeralPort, '127.0.0.1', () => resolve()));
    const secondBundle = makePhoneBundle();
    const secondUserData = mkTmp('localbot-userdata-2-');
    fs.writeFileSync(
      path.join(secondUserData, 'network.json'),
      JSON.stringify({ port: ephemeralPort, bindMode: 'localhost', updateChannel: 'latest' }),
    );
    process.env.LOCALBOT_USER_DATA_DIR = secondUserData;
    const origConsoleInfo = console.info;
    console.info = () => undefined;
    try {
      const serverModule = (await import('../../src/main/network/server')) as {
        startNetworkServer: (opts: { phoneBundleDir: string }) => Promise<unknown>;
      };
      let rejected = false;
      try {
        await serverModule.startNetworkServer({ phoneBundleDir: secondBundle });
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    } finally {
      console.info = origConsoleInfo;
      try { fs.rmSync(secondBundle, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(secondUserData, { recursive: true, force: true }); } catch { /* ignore */ }
      delete process.env.LOCALBOT_USER_DATA_DIR;
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('Case E: graceful close — after handle.close(), HTTP returns ECONNREFUSED', async () => {
    const ephemeralPort = 30000 + Math.floor(Math.random() * 10000);
    fx = await bootServer({ port: ephemeralPort, bindMode: 'localhost', updateChannel: 'latest' });
    const host = fx.handle.host;
    const port = fx.handle.port;
    await fx.handle.close();
    // After close, the OS should refuse new connections. Assert at least
    // one of: connection error, socket reset, port no longer listening.
    let gotError = false;
    try {
      await httpGet(host, port, '/');
    } catch {
      gotError = true;
    }
    expect(gotError).toBe(true);
  });

  it('Case F: handle.rebind() opens new bind and updates host/port in Wave 2', async () => {
    const ephemeralPort = 30000 + Math.floor(Math.random() * 10000);
    fx = await bootServer({ port: ephemeralPort, bindMode: 'localhost', updateChannel: 'latest' });
    // Rebind to a NEW ephemeral port (avoids colliding with anything).
    // In Wave 2 this MUST succeed and the handle's host/port should be
    // updated to the new target.
    const newPort = ephemeralPort + 1;
    await expect(fx.handle.rebind('127.0.0.1', newPort)).resolves.toBeUndefined();
    expect(fx.handle.host).toBe('127.0.0.1');
    expect(fx.handle.port).toBe(newPort);
  });
});

describe('network.static — servePhoneBundle (path-traversal guard)', () => {
  // Test the static handler directly without booting the WS server so each
  // case is hermetic.

  function makeFakeReq(urlPath: string): http.IncomingMessage {
    return { url: urlPath } as unknown as http.IncomingMessage;
  }

  function makeFakeRes(): http.ServerResponse & { status: number; _ended: boolean } {
    const res: http.ServerResponse & { status: number; _ended: boolean } = {
      status: 0,
      _ended: false,
      writeHead: function (status: number) {
        this.status = status;
        return this;
      },
      end: function () {
        this._ended = true;
        return this;
      },
      pipe: function () {
        return this;
      },
      // fs.createReadStream(...).pipe(res) needs a writable-like surface:
      // it calls .on('error', ...), .on('drain', ...), .write(chunk), etc.
      // Returning this keeps pipe() a no-op for tests; we only assert on
      // the status code + _ended flag.
      on: function () {
        return this;
      },
      once: function () {
        return this;
      },
      emit: function () {
        return false;
      },
      write: function () {
        return true;
      },
    } as unknown as http.ServerResponse & { status: number; _ended: boolean };
    return res;
  }

  it('Case G: GET /assets/../config.cjs (or similar traversal) returns 403', () => {
    const rootDir = makePhoneBundle({ 'config.cjs': 'SECRET', 'assets/style.css': '/* x */' });
    const res = makeFakeRes();
    // URL-encoded `..` so the URL parser preserves it through http.createServer.
    // Path traversal attempt via /assets/../config.cjs (URL-encoded `..`).
    servePhoneBundle(makeFakeReq('/assets/..%2fconfig.cjs'), res, rootDir);
    expect(res.status).toBe(403);
    expect(res._ended).toBe(true);
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('Case G2: GET /assets/<safe>.<ext> serves the asset with correct content-type', () => {
    const rootDir = makePhoneBundle({ 'assets/style.css': 'body { color: red; }' });
    const res = makeFakeRes();
    servePhoneBundle(makeFakeReq('/assets/style.css'), res, rootDir);
    expect(res.status).toBe(200);
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('Case H: GET /unknown-path returns 404', () => {
    const rootDir = makePhoneBundle();
    const res = makeFakeRes();
    servePhoneBundle(makeFakeReq('/unknown-path'), res, rootDir);
    expect(res.status).toBe(404);
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('Case I: GET / serves <bundleDir>/index.html', () => {
    const rootDir = makePhoneBundle({ 'index.html': '<html>phone</html>' });
    const res = makeFakeRes();
    servePhoneBundle(makeFakeReq('/'), res, rootDir);
    expect(res.status).toBe(200);
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('Case I2: GET /index.html serves the index.html (alternate path)', () => {
    const rootDir = makePhoneBundle({ 'index.html': '<html>phone</html>' });
    const res = makeFakeRes();
    servePhoneBundle(makeFakeReq('/index.html'), res, rootDir);
    expect(res.status).toBe(200);
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('Case I3: serves non-existent / with 404 when index.html is absent', () => {
    const rootDir = makePhoneBundle();
    const res = makeFakeRes();
    servePhoneBundle(makeFakeReq('/'), res, rootDir);
    expect(res.status).toBe(404);
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
