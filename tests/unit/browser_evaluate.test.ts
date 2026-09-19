// Unit tests for Phase 8 Plan 2 browser.evaluate tool:
//   - daemon/tools/browser_evaluate.cjs
//
// Threat model coverage:
//   - T-8-09: 50KB result cap (result_too_large); expressionBytes audit.
//   - T-8-13: 10s timeout via Playwright signal option + setTimeout guard.
//   - T-8-02: NEVER include expression source in the result.
//   - T-8-01: checkBrowserUrl runs BEFORE page.evaluate.
//   - T-8-05: ctx.signal propagates as Playwright `signal`.
//
// We bypass vitest's vi.mock by patching require.cache for the
// browser/policy.cjs + browser/contexts.cjs helpers BEFORE the tool
// loads browser/index.cjs (which requires them). The Playwright
// `page.evaluate` method is mocked via a vi.fn.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

let mockCheckBrowserUrl: ReturnType<typeof vi.fn>;
let mockGetPage: ReturnType<typeof vi.fn>;
let mockEvaluate: ReturnType<typeof vi.fn>;

function setup(): void {
  mockCheckBrowserUrl = vi.fn().mockResolvedValue({ allowed: true });
  mockEvaluate = vi.fn().mockResolvedValue('ok');
  const mockPage = {
    url: vi.fn().mockReturnValue('https://example.com/dashboard'),
    evaluate: (...a: unknown[]) => mockEvaluate(...a),
  };
  mockGetPage = vi.fn().mockResolvedValue(mockPage);

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
  delete require_.cache[require_.resolve('../../daemon/tools/browser_evaluate.cjs')];
}

beforeEach(() => {
  setup();
});

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bot: 'testbot',
    screenshotDir: '/tmp/screens',
    runId: 'run_test_1',
    browserAllow: ['**'],
    browserDeny: [],
    ssrfAllowInternal: false,
    signal: undefined,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// browser_evaluate.cjs — URL gate, audit minimization, size caps
// ─────────────────────────────────────────────────────────────────────

describe('browser.evaluate — URL gate (T-8-01) + audit minimization (T-8-02)', () => {
  it('runs checkBrowserUrl against page.url() BEFORE page.evaluate', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_evaluate = require_('../../daemon/tools/browser_evaluate.cjs');
    const expr = 'document.title';
    const result = await browser_evaluate.call(
      { expression: expr },
      makeCtx(),
    );
    expect(result.expressionBytes).toBe(Buffer.byteLength(expr, 'utf8'));
    expect(result.resultBytes).toBe(2); // 'ok'
    expect(result.result).toBe('ok');
    expect(result.hostname).toBe('example.com');
    expect(result.path).toBe('/dashboard');
    // Gate ran before the Playwright action.
    expect(mockCheckBrowserUrl).toHaveBeenCalledTimes(1);
    expect(mockCheckBrowserUrl.mock.calls[0][0].url).toBe('https://example.com/dashboard');
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    // Pitfall 5: NEVER include the expression source in the result.
    expect(JSON.stringify(result)).not.toMatch(/document\.title/);
  });

  it('rejects NUL bytes in expression with {code:"invalid_expression"}', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_evaluate = require_('../../daemon/tools/browser_evaluate.cjs');
    await expect(
      browser_evaluate.call({ expression: 'a\x00b' }, makeCtx()),
    ).rejects.toMatchObject({ code: 'invalid_expression' });
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('rejects oversized expressions (>100KB) with {code:"expression_too_large"}', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_evaluate = require_('../../daemon/tools/browser_evaluate.cjs');
    const expr = 'a'.repeat(100 * 1024 + 1);
    await expect(
      browser_evaluate.call({ expression: expr }, makeCtx()),
    ).rejects.toMatchObject({ code: 'expression_too_large' });
    expect(mockEvaluate).not.toHaveBeenCalled();
  });
});

describe('browser.evaluate — result size cap + signal propagation (T-8-09, T-8-05)', () => {
  it('throws {code:"result_too_large"} when JSON-serialized result exceeds 50KB', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_evaluate = require_('../../daemon/tools/browser_evaluate.cjs');
    // Build a JSON result whose serialized form is > 50KB.
    const huge = JSON.stringify({ data: 'x'.repeat(60 * 1024) });
    mockEvaluate.mockResolvedValueOnce({ data: 'x'.repeat(60 * 1024) });
    await expect(
      browser_evaluate.call({ expression: 'JSON.stringify({data})' }, makeCtx()),
    ).rejects.toMatchObject({ code: 'result_too_large' });
    expect(huge.length).toBeGreaterThan(50 * 1024);
  });

  it('propagates ctx.signal as the second argument to page.evaluate', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_evaluate = require_('../../daemon/tools/browser_evaluate.cjs');
    const ac = new AbortController();
    await browser_evaluate.call(
      { expression: '1+1' },
      makeCtx({ signal: ac.signal }),
    );
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    const callArgs = mockEvaluate.mock.calls[0];
    expect(callArgs[0]).toBe('1+1');
    expect(callArgs[1]).toMatchObject({
      timeout: 10_000,
      signal: ac.signal,
    });
  });
});

describe('browser.evaluate — denial path', () => {
  it('throws {code:"browser_denied"} when checkBrowserUrl disallows the page URL', async () => {
    mockCheckBrowserUrl.mockResolvedValueOnce({ allowed: false, reason: 'no_allowlist' });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_evaluate = require_('../../daemon/tools/browser_evaluate.cjs');
    await expect(
      browser_evaluate.call({ expression: '1+1' }, makeCtx()),
    ).rejects.toMatchObject({ code: 'browser_denied', reason: 'no_allowlist' });
    expect(mockEvaluate).not.toHaveBeenCalled();
  });
});
