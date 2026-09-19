// Unit tests for Phase 8 Plan 2 screenshot pipeline:
//   - daemon/browser/screenshots.cjs (captureScreenshot + quota constants)
//   - daemon/tools/browser_screenshot.cjs (per-runId cap + URL gate)
//
// Threat model coverage:
//   - T-8-11: 50/runId + 500MB total disk quota (Pitfall 6).
//   - Pitfall 6: atomic write (tmp + rename). Never a partial PNG at
//     the canonical path.
//   - T-8-01: checkBrowserUrl runs BEFORE captureScreenshot.
//
// The unit tests use Node's real fs (via tmpdir) for the atomic-write
// integration assertion; Playwright's page.screenshot is mocked.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const require_ = createRequire(import.meta.url);

let mockCheckBrowserUrl: ReturnType<typeof vi.fn>;
let mockGetPage: ReturnType<typeof vi.fn>;
let mockScreenshot: ReturnType<typeof vi.fn>;

function setup(): void {
  mockCheckBrowserUrl = vi.fn().mockResolvedValue({ allowed: true });
  mockScreenshot = vi.fn().mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const mockPage = {
    url: vi.fn().mockReturnValue('https://example.com/page'),
    screenshot: (...a: unknown[]) => mockScreenshot(...a),
  };
  mockGetPage = vi.fn().mockResolvedValue(mockPage);

  // Patch the policy + contexts modules in require.cache.
  const policyPath = require_.resolve('../../daemon/browser/policy.cjs');
  require_.cache[policyPath] = {
    id: policyPath,
    filename: policyPath,
    loaded: true,
    exports: {
      checkBrowserUrl: (...a: unknown[]) => mockCheckBrowserUrl(...a),
      isPrivateIp: vi.fn().mockReturnValue(false),
      __test__: { isPrivateIp: vi.fn().mockReturnValue(false) },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    children: [] as any[],
    paths: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parent: null as any,
    require: require_,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    path: '' as any,
  };
  const contextsPath = require_.resolve('../../daemon/browser/contexts.cjs');
  require_.cache[contextsPath] = {
    id: contextsPath,
    filename: contextsPath,
    loaded: true,
    exports: {
      getPage: (...a: unknown[]) => mockGetPage(...a),
      deleteContext: vi.fn().mockResolvedValue(undefined),
      __test__: { reset: vi.fn(), peek: vi.fn().mockReturnValue(true), size: vi.fn().mockReturnValue(1) },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    children: [] as any[],
    paths: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parent: null as any,
    require: require_,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    path: '' as any,
  };
  delete require_.cache[require_.resolve('../../daemon/browser/index.cjs')];
  delete require_.cache[require_.resolve('../../daemon/tools/browser_screenshot.cjs')];
}

let tmpDir = '';
beforeEach(async () => {
  setup();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lb-shot-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bot: 'testbot',
    screenshotDir: tmpDir,
    runId: 'run_test_1',
    browserAllow: ['**'],
    browserDeny: [],
    ssrfAllowInternal: false,
    signal: undefined,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Quota constants — exported from screenshots.cjs
// ─────────────────────────────────────────────────────────────────────

describe('screenshots.cjs — quota constants', () => {
  it('exports MAX_SCREENSHOTS_PER_RUN=50', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const screenshots = require_('../../daemon/browser/screenshots.cjs');
    expect(screenshots.MAX_SCREENSHOTS_PER_RUN).toBe(50);
  });

  it('exports MAX_TOTAL_BYTES=500MB', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const screenshots = require_('../../daemon/browser/screenshots.cjs');
    expect(screenshots.MAX_TOTAL_BYTES).toBe(500 * 1024 * 1024);
  });
});

// ─────────────────────────────────────────────────────────────────────
// captureScreenshot — atomic write integration
// ─────────────────────────────────────────────────────────────────────

describe('captureScreenshot — atomic tmp + rename (Pitfall 6)', () => {
  it('writes the PNG to <dir>/<runId>/<n>.png and leaves no .tmp behind', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const screenshots = require_('../../daemon/browser/screenshots.cjs');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = { screenshot: mockScreenshot } as any;
    const result = await screenshots.captureScreenshot({
      page,
      screenshotDir: tmpDir,
      runId: 'r1',
      n: 'shot1',
      fullPage: false,
    });
    // Returned shape: filename + absolutePath + bytes + fullPage.
    expect(result.path).toBe('shot1.png');
    expect(result.absolutePath).toBe(path.join(tmpDir, 'r1', 'shot1.png'));
    expect(result.bytes).toBe(8);
    expect(result.fullPage).toBe(false);
    // Canonical file exists with the expected content.
    const data = await fs.readFile(result.absolutePath);
    expect(data.length).toBe(8);
    expect(data[0]).toBe(0x89);
    expect(data[1]).toBe(0x50);
    // No leftover .tmp file at the canonical path.
    await expect(fs.stat(`${result.absolutePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('throws {code:"aborted"} when signal is already aborted', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const screenshots = require_('../../daemon/browser/screenshots.cjs');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = { screenshot: mockScreenshot } as any;
    const ac = new AbortController();
    ac.abort();
    await expect(
      screenshots.captureScreenshot({
        page,
        screenshotDir: tmpDir,
        runId: 'r1',
        n: 'shot1',
        fullPage: false,
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});

// ─────────────────────────────────────────────────────────────────────
// browser_screenshot.cjs — per-runId cap + URL gate
// ─────────────────────────────────────────────────────────────────────

describe('browser.screenshot — URL gate + per-runId cap (T-8-11)', () => {
  it('runs checkBrowserUrl against page.url() BEFORE captureScreenshot', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_screenshot = require_('../../daemon/tools/browser_screenshot.cjs');
    const result = await browser_screenshot.call(
      { n: 'shot1', fullPage: false },
      makeCtx(),
    );
    expect(result.filename).toBe('shot1.png');
    expect(result.bytes).toBe(8);
    expect(result.hostname).toBe('example.com');
    expect(result.path).toBe('/page');
    // checkBrowserUrl was called before screenshot() was.
    expect(mockCheckBrowserUrl).toHaveBeenCalledTimes(1);
    expect(mockCheckBrowserUrl.mock.calls[0][0].url).toBe('https://example.com/page');
    expect(mockScreenshot).toHaveBeenCalledTimes(1);
  });

  it('rejects with {code:"screenshot_quota_exceeded"} when 50 PNGs already exist in runId', async () => {
    // Pre-fill the runId dir with 50 .png files.
    const runDir = path.join(tmpDir, 'run_test_1');
    await fs.mkdir(runDir, { recursive: true });
    for (let i = 0; i < 50; i++) {
      await fs.writeFile(path.join(runDir, `seed${i}.png`), Buffer.from([0]));
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_screenshot = require_('../../daemon/tools/browser_screenshot.cjs');
    await expect(
      browser_screenshot.call({ n: 'shot51' }, makeCtx()),
    ).rejects.toMatchObject({ code: 'screenshot_quota_exceeded' });
    // Gate still ran first, then the cap check blocked the capture.
    expect(mockScreenshot).not.toHaveBeenCalled();
  });

  it('rejects n containing path traversal with {code:"invalid_n"}', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_screenshot = require_('../../daemon/tools/browser_screenshot.cjs');
    await expect(
      browser_screenshot.call({ n: '../../etc/passwd' }, makeCtx()),
    ).rejects.toMatchObject({ code: 'invalid_n' });
    expect(mockScreenshot).not.toHaveBeenCalled();
  });

  it('throws {code:"browser_denied"} when checkBrowserUrl disallows the page URL', async () => {
    mockCheckBrowserUrl.mockResolvedValueOnce({ allowed: false, reason: 'no_allowlist' });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_screenshot = require_('../../daemon/tools/browser_screenshot.cjs');
    await expect(
      browser_screenshot.call({ n: 'shot1' }, makeCtx()),
    ).rejects.toMatchObject({ code: 'browser_denied', reason: 'no_allowlist' });
    expect(mockScreenshot).not.toHaveBeenCalled();
  });

  it('throws {code:"browser_not_configured"} when ctx.screenshotDir is missing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_screenshot = require_('../../daemon/tools/browser_screenshot.cjs');
    const ctx = makeCtx();
    delete ctx.screenshotDir;
    await expect(
      browser_screenshot.call({ n: 'shot1' }, ctx),
    ).rejects.toMatchObject({ code: 'browser_not_configured' });
    expect(mockScreenshot).not.toHaveBeenCalled();
  });
});
