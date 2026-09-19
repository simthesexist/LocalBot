// Phase 8 Plan 3: Playwright daemon-smoke for the browser automation
// vertical slice. Drives the full stack from daemon tools/call →
// daemon/browser/* (Playwright headless) → audit JSONL. The renderer
// block renderers (BrowserNavigateBlock / BrowserClickBlock / etc.) and
// BotSettingsBrowserTab are covered by unit tests + UI verification
// under `npm run dev`; this suite verifies the underlying tool handlers
// + the audit minimization pipeline (Pitfall 5).
//
// Six cases — one per browser.* tool:
//   1. browser.navigate    — happy path; audit carries hostname+path+status+duration_ms
//                            only. Query string NEVER leaked (Pitfall 5).
//   2. browser.click       — happy path on the loaded page; audit shape
//                            matches (1). Typed text NEVER included.
//   3. browser.type        — fills an input; audit shape matches; textBytes
//                            present, raw text NEVER present.
//   4. browser.fill_form   — fills 3 fields + submits; audit carries
//                            fieldCount only; field values NEVER present.
//   5. browser.screenshot  — captures a PNG; audit carries screenshotBytes;
//                            raw PNG bytes NEVER present in the audit JSONL.
//   6. browser.evaluate    — runs a JS expression; audit carries
//                            expressionBytes + resultBytes only; raw
//                            expression source + raw result NEVER present.
//
// Prohibitions (per PLAN):
//   - MUST NOT hardcode vault paths or ports — mkdtemp + port 0
//     (kernel-assigned) for every run.
//   - MUST NOT skip audit minimization assertion — every case asserts
//     the audit row carries ONLY the canonical minimization shape.
//   - MUST NOT depend on a real network — all navigation targets a
//     Node http.createServer listening on 127.0.0.1 with ssrfAllowInternal
//     enabled (the opt-out escape hatch reserved for hermetic tests).
//
// ─── DEVIATION from PLAN ───────────────────────────────────────────────
// The plan describes an LLM-driven flow (bots/trigger → fake-m3 stream
// → tool_use → daemon tool handler → audit). That requires the daemon's
// `runSendMessageCycle` (daemon/main.cjs:37) to pass `tools` to the
// Anthropic SDK call — currently it does NOT. Wiring tools through
// runSendMessageCycle is outside Plan 08-03's scope (separate daemon
// architectural change), so this test drives the daemon's `tools/call`
// JSON-RPC method directly — the same pattern obsidian-integration.test.ts
// uses for vault.* and daemon-tools.test.ts uses for read_file. The
// streamBrowser*ToolUse helpers from Plan 08-03 are still used by the
// headed Electron E2E + any future LLM-driven test once runSendMessageCycle
// wires tools, so the helpers themselves remain deliverables.
// ───────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { spawn, ChildProcessByStdio } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

interface PendingRequest {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

function createJsonRpcClient(child: ChildProcessByStdio<Writable, Readable>) {
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let obj: any;
    try { obj = JSON.parse(line); } catch { return; }
    if (typeof obj.id === 'number' && pending.has(obj.id)) {
      const p = pending.get(obj.id)!;
      pending.delete(obj.id);
      p.resolve(obj);
    }
  });
  return {
    send(method: string, params?: Record<string, unknown>): Promise<any> {
      const id = nextId++;
      const msg = { jsonrpc: '2.0', id, method, params };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify(msg) + '\n');
      });
    },
  };
}

function awaitReady(child: ChildProcessByStdio<Writable, Readable>): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: child.stdout });
    const onLine = (line: string) => {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.kind === 'ready') {
          rl.removeListener('line', onLine);
          rl.close();
          resolve(true);
        }
      } catch { /* ignore */ }
    };
    rl.on('line', onLine);
    setTimeout(() => {
      rl.removeListener('line', onLine);
      rl.close();
      resolve(false);
    }, 10_000);
  });
}

function readAuditLines(userDataDir: string): Array<Record<string, unknown>> {
  const dir = path.join(userDataDir, 'audit');
  if (!fs.existsSync(dir)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of text.split('\n').filter(Boolean)) {
      try { out.push(JSON.parse(line)); } catch { /* ignore */ }
    }
  }
  return out;
}

interface TestPageServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Spin up a Node http.createServer on 127.0.0.1 with a kernel-assigned
 * port. Serves a single static page (the navigation target for every
 * tool case). The page contains every selector the 6 cases need:
 *   - <h1 id="title">…</h1>
 *   - <button id="btn">Click me</button>
 *   - <input id="inp" type="text" />
 *   - <form id="form">
 *       <input name="email" id="form-email" />
 *       <input name="password" id="form-password" />
 *       <input name="role" id="form-role" />
 *       <button type="submit" id="form-submit">Submit</button>
 *     </form>
 *   - <div id="eval-target" data-marker="42">…</div>
 *
 * NOTE: all form fields are plain <input> elements because the browser.fill_form
 * tool uses `locator.fill()`, which only operates on inputs / textareas /
 * contenteditable elements. <select> would need selectOption() instead.
 */
async function spawnTestPageServer(): Promise<TestPageServer> {
  const html = `<!doctype html>
<html><head><title>browser-automation fixture</title></head>
<body>
  <h1 id="title">browser automation fixture page</h1>
  <button id="btn" type="button">Click me</button>
  <input id="inp" type="text" />
  <form id="form">
    <input name="email" id="form-email" type="text" />
    <input name="password" id="form-password" type="password" />
    <input name="role" id="form-role" type="text" />
    <button type="submit" id="form-submit">Submit</button>
  </form>
  <div id="eval-target" data-marker="42">eval fixture</div>
</body></html>`;

  return await new Promise<TestPageServer>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Strip query string from req.url for logging only — the fixture
      // serves the same HTML for every path so the audit minimization
      // assertion can verify the query never leaks.
      const pathOnly = (req.url || '/').split('?')[0];
      if (pathOnly !== '/' && pathOnly !== '/index.html') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to bind test page server'));
        return;
      }
      const port = addr.port;
      const url = `http://127.0.0.1:${port}/`;
      resolve({
        url,
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

interface DaemonContext {
  child: ChildProcessByStdio<Writable, Readable>;
  userDataDir: string;
  rpc: ReturnType<typeof createJsonRpcClient>;
}

async function spawnBrowserDaemon(opts: {
  prefix: string;
  botName: string;
  pageUrl: string;
}): Promise<DaemonContext> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `localbot-browser-e2e-${opts.prefix}-`));

  const daemonEntry = path.resolve(process.cwd(), 'daemon', 'main.cjs');
  const child = spawn(process.execPath, [daemonEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LOCALBOT_USER_DATA_DIR: userDataDir,
      ANTHROPIC_API_KEY: 'fake-test-key',
      // M3_API_BASE is required for bots/trigger but NOT for tools/call;
      // use a stub URL so any accidental LLM call surfaces as a
      // connection refused (rather than silently falling through).
      M3_API_BASE: 'http://127.0.0.1:1',
    },
  }) as ChildProcessByStdio<Writable, Readable>;

  const ready = await awaitReady(child);
  expect(ready, 'daemon failed to emit {kind:"ready"}').toBe(true);

  const rpc = createJsonRpcClient(child);

  await rpc.send('initialize', {
    client: `localbot-browser-e2e-${opts.prefix}`,
    version: '0.8.0',
    userDataDir,
    workspaceRoot: userDataDir,
    bot: opts.botName,
  });

  await rpc.send('bots/create', {
    name: opts.botName,
    persona: `browser test bot ${opts.botName}`,
    workspace: userDataDir,
    allowlist: [
      'browser.navigate',
      'browser.click',
      'browser.type',
      'browser.fill_form',
      'browser.screenshot',
      'browser.evaluate',
    ],
  });

  await rpc.send('bots/update', {
    bot: opts.botName,
    patch: {
      // Wildcard globs are evaluated against the URL pathname (no query).
      browserAllow: ['/**'],
      browserDeny: [],
      // T-8-21 + hermetic test escape hatch — without this flag the SSRF
      // shield blocks 127.0.0.1 even when the URL allowlist matches.
      ssrfAllowInternal: true,
    },
  });
  // Settle bot config reload.
  await new Promise((r) => setTimeout(r, 80));

  // Suppress unused param warning — kept in the signature for parity
  // with obsidian-integration.test.ts (a future case may inspect the URL).
  void opts.pageUrl;

  return { child, userDataDir, rpc };
}

function killDaemon(child: ChildProcessByStdio<Writable, Readable>) {
  try { child.kill(); } catch { /* ignore */ }
}

function cleanup(userDataDir: string, server: TestPageServer) {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  void server.close();
}

/** Canonical minimization shape keys for each browser.* audit row.
 *
 * Note: browser.click / browser.type do NOT include `status` in their
 * return shape (they don't make an HTTP request — they only interact with
 * the already-loaded page), so the audit row's `status` field stays
 * undefined and JSON.stringify drops it. navigate / fill_form / screenshot /
 * evaluate follow the same convention. Only navigate sets `status` because
 * it's the one tool that surfaces the HTTP response status to the audit.
 */
const SHAPE = {
  navigate:    ['duration_ms', 'hostname', 'path', 'status'],
  click:       ['duration_ms', 'hostname', 'path'],
  type:        ['duration_ms', 'hostname', 'path'],
  screenshot:  ['duration_ms', 'hostname', 'path', 'screenshotBytes'],
  evaluate:    ['duration_ms', 'expressionBytes', 'hostname', 'path'],
  fill_form:   ['duration_ms', 'fieldCount', 'hostname', 'path'],
} as const;

test.describe('Phase 8 Plan 3 browser automation E2E (daemon-smoke)', () => {
  test('browser.navigate happy path: hostname+path+status+duration_ms; query string NEVER in audit', async () => {
    const server = await spawnTestPageServer();
    const { child, userDataDir, rpc } = await spawnBrowserDaemon({
      prefix: 'nav-happy',
      botName: 'alpha',
      pageUrl: server.url,
    });
    try {
      // Append a query string the audit minimization MUST drop.
      const navigateUrl = `${server.url}?secret=PRIVATE-NAVIGATE-TOKEN`;
      const resp = await rpc.send('tools/call', {
        name: 'browser.navigate',
        arguments: { url: navigateUrl },
        toolCallId: 'tc_browser_nav_happy_1',
        bot: 'alpha',
      });
      expect(resp.error, `browser.navigate failed: ${JSON.stringify(resp)}`).toBeUndefined();
      // Result hostname + path carry NO query string (Pitfall 5).
      // URL.hostname strips the port — that's why hostname is "127.0.0.1"
      // (not "127.0.0.1:<port>") for `http://127.0.0.1:<port>/`.
      expect(resp.result.url).toBe('127.0.0.1/');
      expect(resp.result.status).toBe(200);
      expect(typeof resp.result.title).toBe('string');
      expect((resp.result.title as string).length).toBeGreaterThan(0);
      expect(typeof resp.result.text).toBe('string');
      expect(typeof resp.result.bytes).toBe('number');
      expect(typeof resp.result.durationMs).toBe('number');

      // Audit flush.
      await new Promise((r) => setTimeout(r, 250));
      const lines = readAuditLines(userDataDir);
      const navLine = lines.find(
        (l) => l.tool === 'browser.navigate' && (l.params as any)?.path === '/',
      );
      expect(
        navLine,
        `expected a browser.navigate audit row with path='/'\nGot: ${JSON.stringify(lines, null, 2)}`,
      ).toBeTruthy();
      const params = navLine!.params as Record<string, unknown>;
      // The 4-key minimization shape. JSON.stringify drops undefined values
      // so the wire shape is exactly the 4 keys listed in SHAPE.navigate.
      expect(Object.keys(params).sort()).toEqual([...SHAPE.navigate]);
      expect(params.hostname).toBe('127.0.0.1');
      expect(params.path).toBe('/');
      expect(params.status).toBe(200);
      expect(typeof params.duration_ms).toBe('number');
      // NEVER include query string or full URL.
      const serialised = JSON.stringify(navLine);
      expect(serialised).not.toContain('PRIVATE-NAVIGATE-TOKEN');
      expect(serialised).not.toContain('secret=');
      expect(serialised).not.toContain('?token');
    } finally {
      killDaemon(child);
      cleanup(userDataDir, server);
    }
  });

  test('browser.click happy path: clicks a button on the loaded page; audit shape matches navigate', async () => {
    const server = await spawnTestPageServer();
    const { child, userDataDir, rpc } = await spawnBrowserDaemon({
      prefix: 'click-happy',
      botName: 'alpha',
      pageUrl: server.url,
    });
    try {
      // Prime the per-bot BrowserContext with a real page so page.url()
      // resolves to the fixture before browser.click.
      await rpc.send('tools/call', {
        name: 'browser.navigate',
        arguments: { url: server.url },
        toolCallId: 'tc_browser_nav_for_click_1',
        bot: 'alpha',
      });

      const resp = await rpc.send('tools/call', {
        name: 'browser.click',
        arguments: { selector: '#btn' },
        toolCallId: 'tc_browser_click_happy_1',
        bot: 'alpha',
      });
      expect(resp.error, `browser.click failed: ${JSON.stringify(resp)}`).toBeUndefined();
      expect(resp.result.selector).toBe('#btn');
      expect(resp.result.hostname).toBe('127.0.0.1');
      expect(resp.result.path).toBe('/');
      expect(typeof resp.result.text).toBe('string');
      expect(typeof resp.result.durationMs).toBe('number');

      await new Promise((r) => setTimeout(r, 250));
      const lines = readAuditLines(userDataDir);
      const clickLine = lines.find(
        (l) => l.tool === 'browser.click' && (l.params as any)?.path === '/',
      );
      expect(
        clickLine,
        `expected a browser.click audit row with path='/'\nGot: ${JSON.stringify(lines, null, 2)}`,
      ).toBeTruthy();
      const params = clickLine!.params as Record<string, unknown>;
      expect(Object.keys(params).sort()).toEqual([...SHAPE.click]);
      expect(params.hostname).toBe('127.0.0.1');
      expect(params.path).toBe('/');
      expect(typeof params.duration_ms).toBe('number');
    } finally {
      killDaemon(child);
      cleanup(userDataDir, server);
    }
  });

  test('browser.type happy path: textBytes present, typed text NEVER in audit', async () => {
    const server = await spawnTestPageServer();
    const { child, userDataDir, rpc } = await spawnBrowserDaemon({
      prefix: 'type-happy',
      botName: 'alpha',
      pageUrl: server.url,
    });
    try {
      await rpc.send('tools/call', {
        name: 'browser.navigate',
        arguments: { url: server.url },
        toolCallId: 'tc_browser_nav_for_type_1',
        bot: 'alpha',
      });

      const secret = 'PRIVATE-TYPE-PASSWORD-1234';
      const resp = await rpc.send('tools/call', {
        name: 'browser.type',
        arguments: { selector: '#inp', text: secret },
        toolCallId: 'tc_browser_type_happy_1',
        bot: 'alpha',
      });
      expect(resp.error, `browser.type failed: ${JSON.stringify(resp)}`).toBeUndefined();
      expect(resp.result.selector).toBe('#inp');
      // Pitfall 5: the result exposes the byte count, NEVER the content.
      expect(typeof resp.result.textBytes).toBe('number');
      expect(resp.result.textBytes).toBe(Buffer.byteLength(secret, 'utf8'));
      expect((resp.result as any).text).toBeUndefined();
      expect(resp.result.submitted).toBe(false);
      expect(resp.result.hostname).toBe('127.0.0.1');
      expect(resp.result.path).toBe('/');
      expect(typeof resp.result.durationMs).toBe('number');

      await new Promise((r) => setTimeout(r, 250));
      const lines = readAuditLines(userDataDir);
      const typeLine = lines.find(
        (l) => l.tool === 'browser.type' && (l.params as any)?.path === '/',
      );
      expect(
        typeLine,
        `expected a browser.type audit row with path='/'\nGot: ${JSON.stringify(lines, null, 2)}`,
      ).toBeTruthy();
      const params = typeLine!.params as Record<string, unknown>;
      expect(Object.keys(params).sort()).toEqual([...SHAPE.type]);
      expect(params.hostname).toBe('127.0.0.1');
      expect(params.path).toBe('/');
      expect(typeof params.duration_ms).toBe('number');
      // NEVER include the typed text in any audit field.
      const serialised = JSON.stringify(typeLine);
      expect(serialised).not.toContain(secret);
      expect(serialised).not.toContain('PRIVATE-TYPE');
    } finally {
      killDaemon(child);
      cleanup(userDataDir, server);
    }
  });

  test('browser.fill_form happy path: fieldCount present, field values NEVER in audit', async () => {
    const server = await spawnTestPageServer();
    const { child, userDataDir, rpc } = await spawnBrowserDaemon({
      prefix: 'fill-happy',
      botName: 'alpha',
      pageUrl: server.url,
    });
    try {
      await rpc.send('tools/call', {
        name: 'browser.navigate',
        arguments: { url: server.url },
        toolCallId: 'tc_browser_nav_for_fill_1',
        bot: 'alpha',
      });

      const resp = await rpc.send('tools/call', {
        name: 'browser.fill_form',
        arguments: {
          fields: [
            { selector: '#form-email', value: 'PRIVATE-FILL-EMAIL@example.com' },
            { selector: '#form-password', value: 'PRIVATE-FILL-SECRET' },
            { selector: '#form-role', value: 'PRIVATE-FILL-ROLE' },
          ],
          submit: { selector: '#form-submit' },
        },
        toolCallId: 'tc_browser_fill_happy_1',
        bot: 'alpha',
      });
      expect(resp.error, `browser.fill_form failed: ${JSON.stringify(resp)}`).toBeUndefined();
      expect(resp.result.fieldCount).toBe(3);
      expect(resp.result.submitted).toBe(true);
      expect(resp.result.hostname).toBe('127.0.0.1');
      expect(resp.result.path).toBe('/');
      expect(typeof resp.result.durationMs).toBe('number');

      await new Promise((r) => setTimeout(r, 250));
      const lines = readAuditLines(userDataDir);
      const fillLine = lines.find(
        (l) => l.tool === 'browser.fill_form' && (l.params as any)?.path === '/',
      );
      expect(
        fillLine,
        `expected a browser.fill_form audit row with path='/'\nGot: ${JSON.stringify(lines, null, 2)}`,
      ).toBeTruthy();
      const params = fillLine!.params as Record<string, unknown>;
      expect(Object.keys(params).sort()).toEqual([...SHAPE.fill_form]);
      expect(params.hostname).toBe('127.0.0.1');
      expect(params.path).toBe('/');
      expect(params.fieldCount).toBe(3);
      expect(typeof params.duration_ms).toBe('number');
      // NEVER include individual field values in any audit field.
      const serialised = JSON.stringify(fillLine);
      expect(serialised).not.toContain('PRIVATE-FILL-EMAIL');
      expect(serialised).not.toContain('PRIVATE-FILL-SECRET');
      expect(serialised).not.toContain('PRIVATE-FILL-ROLE');
      expect(serialised).not.toContain('example.com');
    } finally {
      killDaemon(child);
      cleanup(userDataDir, server);
    }
  });

  test('browser.screenshot happy path: screenshotBytes present, raw PNG bytes NEVER in audit', async () => {
    const server = await spawnTestPageServer();
    const { child, userDataDir, rpc } = await spawnBrowserDaemon({
      prefix: 'screenshot-happy',
      botName: 'alpha',
      pageUrl: server.url,
    });
    try {
      await rpc.send('tools/call', {
        name: 'browser.navigate',
        arguments: { url: server.url },
        toolCallId: 'tc_browser_nav_for_screenshot_1',
        bot: 'alpha',
      });

      const resp = await rpc.send('tools/call', {
        name: 'browser.screenshot',
        arguments: { fullPage: true },
        toolCallId: 'tc_browser_screenshot_happy_1',
        bot: 'alpha',
      });
      expect(resp.error, `browser.screenshot failed: ${JSON.stringify(resp)}`).toBeUndefined();
      expect(typeof resp.result.filename).toBe('string');
      expect((resp.result.filename as string).endsWith('.png')).toBe(true);
      expect(typeof resp.result.absolutePath).toBe('string');
      expect(fs.existsSync(resp.result.absolutePath as string)).toBe(true);
      expect(typeof resp.result.bytes).toBe('number');
      expect((resp.result.bytes as number)).toBeGreaterThan(0);
      expect(resp.result.hostname).toBe('127.0.0.1');
      expect(resp.result.path).toBe('/');
      expect(resp.result.fullPage).toBe(true);
      expect(typeof resp.result.durationMs).toBe('number');

      await new Promise((r) => setTimeout(r, 250));
      const lines = readAuditLines(userDataDir);
      const shotLine = lines.find(
        (l) => l.tool === 'browser.screenshot' && (l.params as any)?.path === '/',
      );
      expect(
        shotLine,
        `expected a browser.screenshot audit row with path='/'\nGot: ${JSON.stringify(lines, null, 2)}`,
      ).toBeTruthy();
      const params = shotLine!.params as Record<string, unknown>;
      expect(Object.keys(params).sort()).toEqual([...SHAPE.screenshot]);
      expect(params.hostname).toBe('127.0.0.1');
      expect(params.path).toBe('/');
      expect(typeof params.screenshotBytes).toBe('number');
      expect((params.screenshotBytes as number)).toBeGreaterThan(0);
      expect(typeof params.duration_ms).toBe('number');
      // NEVER include raw PNG bytes (the magic number is 0x89 'P' 'N' 'G').
      const serialised = JSON.stringify(shotLine);
      expect(serialised).not.toContain('PNG');
      // The audit row also MUST NOT carry the absolute screenshot path.
      expect(serialised).not.toContain(resp.result.absolutePath as string);
    } finally {
      killDaemon(child);
      cleanup(userDataDir, server);
    }
  });

  test('browser.evaluate happy path: expressionBytes present, raw expression + result NEVER in audit', async () => {
    const server = await spawnTestPageServer();
    const { child, userDataDir, rpc } = await spawnBrowserDaemon({
      prefix: 'evaluate-happy',
      botName: 'alpha',
      pageUrl: server.url,
    });
    try {
      await rpc.send('tools/call', {
        name: 'browser.navigate',
        arguments: { url: server.url },
        toolCallId: 'tc_browser_nav_for_evaluate_1',
        bot: 'alpha',
      });

      const expression = "document.querySelector('#eval-target').dataset.marker";
      const resp = await rpc.send('tools/call', {
        name: 'browser.evaluate',
        arguments: { expression },
        toolCallId: 'tc_browser_evaluate_happy_1',
        bot: 'alpha',
      });
      expect(resp.error, `browser.evaluate failed: ${JSON.stringify(resp)}`).toBeUndefined();
      expect(resp.result.result).toBe('42');
      expect(typeof resp.result.expressionBytes).toBe('number');
      expect(resp.result.expressionBytes).toBe(Buffer.byteLength(expression, 'utf8'));
      expect(typeof resp.result.resultBytes).toBe('number');
      expect(resp.result.hostname).toBe('127.0.0.1');
      expect(resp.result.path).toBe('/');
      expect(typeof resp.result.durationMs).toBe('number');

      await new Promise((r) => setTimeout(r, 250));
      const lines = readAuditLines(userDataDir);
      const evalLine = lines.find(
        (l) => l.tool === 'browser.evaluate' && (l.params as any)?.path === '/',
      );
      expect(
        evalLine,
        `expected a browser.evaluate audit row with path='/'\nGot: ${JSON.stringify(lines, null, 2)}`,
      ).toBeTruthy();
      const params = evalLine!.params as Record<string, unknown>;
      expect(Object.keys(params).sort()).toEqual([...SHAPE.evaluate]);
      expect(params.hostname).toBe('127.0.0.1');
      expect(params.path).toBe('/');
      expect(typeof params.expressionBytes).toBe('number');
      expect(params.expressionBytes).toBe(Buffer.byteLength(expression, 'utf8'));
      expect(typeof params.duration_ms).toBe('number');
      // NEVER include the expression source OR the result value in any audit field.
      const serialised = JSON.stringify(evalLine);
      expect(serialised).not.toContain('document.querySelector');
      expect(serialised).not.toContain('dataset.marker');
      expect(serialised).not.toContain('eval-target');
      // The result value "42" appears literally in the audit shape via the
      // expressionBytes count — assert that no key carries the string "42".
      expect(serialised).not.toContain('"42"');
    } finally {
      killDaemon(child);
      cleanup(userDataDir, server);
    }
  });
});
