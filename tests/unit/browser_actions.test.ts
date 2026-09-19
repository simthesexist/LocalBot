// Unit tests for Phase 8 Plan 2 browser action tools:
//   - daemon/tools/browser_click.cjs
//   - daemon/tools/browser_type.cjs
//   - daemon/tools/browser_fill_form.cjs
//
// Threat model coverage:
//   - T-8-01: every tool calls checkBrowserUrl against page.url() BEFORE
//     any Playwright action.
//   - T-8-05: every tool propagates ctx.signal as Playwright `signal`.
//   - T-8-02: never log typed text (browser.type) or field values
//     (browser.fill_form) in audit rows.
//
// We bypass vitest's vi.mock (which doesn't intercept CJS requires of
// node_modules) by patching require.cache so the daemon-side helper
// modules (browser/policy.cjs + browser/contexts.cjs) are replaced with
// mocks BEFORE browser/index.cjs re-requires them on test setup.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// Mock state — re-initialised in beforeEach so each test gets clean spys.
let mockCheckBrowserUrl: ReturnType<typeof vi.fn>;
let mockGetPage: ReturnType<typeof vi.fn>;
let mockClick: ReturnType<typeof vi.fn>;
let mockLocatorFill: ReturnType<typeof vi.fn>;
let mockPress: ReturnType<typeof vi.fn>;
let mockEvaluate: ReturnType<typeof vi.fn>;

// Build a fresh page mock + module-cache patches on each setup.
function setup(): void {
  mockCheckBrowserUrl = vi.fn().mockResolvedValue({ allowed: true });
  mockClick = vi.fn().mockResolvedValue(undefined);
  mockLocatorFill = vi.fn().mockResolvedValue(undefined);
  mockPress = vi.fn().mockResolvedValue(undefined);
  mockEvaluate = vi.fn().mockResolvedValue('Sign In');
  const mockLocator = {
    fill: (...a: unknown[]) => mockLocatorFill(...a),
    count: (...a: unknown[]) => vi.fn().mockResolvedValue(1)(...a),
    press: (...a: unknown[]) => mockPress(...a),
    innerText: vi.fn().mockResolvedValue('Sign In'),
  };
  const mockPage = {
    url: vi.fn().mockReturnValue('https://example.com/login'),
    click: (...a: unknown[]) => mockClick(...a),
    locator: vi.fn().mockImplementation(() => mockLocator),
    fill: (...a: unknown[]) => mockLocatorFill(...a),
    press: (...a: unknown[]) => mockPress(...a),
    evaluate: (...a: unknown[]) => mockEvaluate(...a),
    innerText: vi.fn().mockResolvedValue('Sign In'),
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
  // Drop cached browser/index.cjs so it re-binds to our patched deps.
  delete require_.cache[require_.resolve('../../daemon/browser/index.cjs')];
  // Drop cached tool modules so each test re-requires them with fresh deps.
  delete require_.cache[require_.resolve('../../daemon/tools/browser_click.cjs')];
  delete require_.cache[require_.resolve('../../daemon/tools/browser_type.cjs')];
  delete require_.cache[require_.resolve('../../daemon/tools/browser_fill_form.cjs')];
}

beforeEach(() => {
  setup();
});

// Helper: build a minimal ctx object shaped like what tools/call passes.
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
// browser_click.cjs
// ─────────────────────────────────────────────────────────────────────

describe('browser.click — URL gate (T-8-01)', () => {
  it('runs checkBrowserUrl against page.url() before any Playwright action', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_click = require_('../../daemon/tools/browser_click.cjs');
    const result = await browser_click.call(
      { selector: '#submit' },
      makeCtx(),
    );
    expect(result).toMatchObject({
      selector: '#submit',
      hostname: 'example.com',
      path: '/login',
      text: 'Sign In',
    });
    // checkBrowserUrl was called with the page URL, not args.url.
    expect(mockCheckBrowserUrl).toHaveBeenCalledTimes(1);
    const [arg] = mockCheckBrowserUrl.mock.calls[0];
    expect(arg.url).toBe('https://example.com/login');
    expect(arg.browserAllow).toEqual(['**']);
    expect(arg.ssrfAllowInternal).toBe(false);
    // Playwright action was performed AFTER the gate.
    expect(mockClick).toHaveBeenCalledTimes(1);
  });

  it('throws {code:"browser_denied"} when checkBrowserUrl disallows the page URL', async () => {
    mockCheckBrowserUrl.mockResolvedValueOnce({ allowed: false, reason: 'no_allowlist' });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_click = require_('../../daemon/tools/browser_click.cjs');
    await expect(
      browser_click.call({ selector: '#submit' }, makeCtx()),
    ).rejects.toMatchObject({ code: 'browser_denied', reason: 'no_allowlist' });
    expect(mockClick).not.toHaveBeenCalled();
  });

  it('maps Playwright TimeoutError to {code:"selector_not_found", selector}', async () => {
    const err = new Error('Timeout 10000ms exceeded');
    err.name = 'TimeoutError';
    mockClick.mockRejectedValueOnce(err);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_click = require_('../../daemon/tools/browser_click.cjs');
    await expect(
      browser_click.call({ selector: '#missing' }, makeCtx()),
    ).rejects.toMatchObject({ code: 'selector_not_found', selector: '#missing' });
  });
});

// ─────────────────────────────────────────────────────────────────────
// browser_type.cjs
// ─────────────────────────────────────────────────────────────────────

describe('browser.type — text byte count only (T-8-02)', () => {
  it('returns {textBytes, hostname, path} — never the typed text', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_type = require_('../../daemon/tools/browser_type.cjs');
    const secret = 'hunter2-correct-horse-battery-staple';
    const result = await browser_type.call(
      { selector: '#password', text: secret },
      makeCtx(),
    );
    expect(result.selector).toBe('#password');
    expect(result.textBytes).toBe(Buffer.byteLength(secret, 'utf8'));
    expect(result.hostname).toBe('example.com');
    expect(result.path).toBe('/login');
    expect(result.submitted).toBe(false);
    // Pitfall 5: the actual typed text must NEVER appear in the result.
    expect(JSON.stringify(result)).not.toMatch(/hunter2/);
    expect(JSON.stringify(result)).not.toMatch(/battery-staple/);
  });

  it('propagates ctx.signal to page.locator().fill()', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_type = require_('../../daemon/tools/browser_type.cjs');
    const ac = new AbortController();
    await browser_type.call(
      { selector: '#q', text: 'hello' },
      makeCtx({ signal: ac.signal }),
    );
    expect(mockLocatorFill).toHaveBeenCalledTimes(1);
    const fillArgs = mockLocatorFill.mock.calls[0];
    expect(fillArgs[0]).toBe('hello');
    // Second arg is the options object with signal.
    expect(fillArgs[1]).toMatchObject({ signal: ac.signal });
  });

  it('presses Enter when submit:true (T-8-05)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_type = require_('../../daemon/tools/browser_type.cjs');
    const result = await browser_type.call(
      { selector: '#q', text: 'search', submit: true },
      makeCtx(),
    );
    expect(result.submitted).toBe(true);
    expect(mockPress).toHaveBeenCalledWith('Enter', expect.any(Object));
  });
});

// ─────────────────────────────────────────────────────────────────────
// browser_fill_form.cjs
// ─────────────────────────────────────────────────────────────────────

describe('browser.fill_form — field values NEVER logged (T-8-02)', () => {
  it('returns {fieldCount, hostname, path, submitted} — never field values', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_fill_form = require_('../../daemon/tools/browser_fill_form.cjs');
    const fields = [
      { selector: '#user', value: 'alice@example.com' },
      { selector: '#pass', value: 'super-secret-123' },
    ];
    const result = await browser_fill_form.call(
      { fields },
      makeCtx(),
    );
    expect(result.fieldCount).toBe(2);
    expect(result.hostname).toBe('example.com');
    expect(result.path).toBe('/login');
    expect(result.submitted).toBe(false);
    // Pitfall 5: secret field values must NEVER appear in the result.
    expect(JSON.stringify(result)).not.toMatch(/alice@example\.com/);
    expect(JSON.stringify(result)).not.toMatch(/super-secret/);
  });

  it('rejects more than 20 fields with {code:"too_many_fields"}', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_fill_form = require_('../../daemon/tools/browser_fill_form.cjs');
    const fields = Array.from({ length: 21 }, (_, i) => ({ selector: `#f${i}`, value: 'x' }));
    await expect(
      browser_fill_form.call({ fields }, makeCtx()),
    ).rejects.toMatchObject({ code: 'too_many_fields' });
    expect(mockLocatorFill).not.toHaveBeenCalled();
  });

  it('validates field shape (selector + value must be strings)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser_fill_form = require_('../../daemon/tools/browser_fill_form.cjs');
    await expect(
      browser_fill_form.call(
        { fields: [{ selector: 42, value: 'x' }] },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_fields' });
  });
});
