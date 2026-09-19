// Unit tests for daemon/browser/audit.cjs — browserAuditParams audit
// minimization helper.
//
// Phase 8 Plan 1: covers the 5-key audit shape (hostname, path, status,
// duration_ms, screenshotBytes?, expressionBytes?, fieldCount?) + the
// Pitfall 5 invariants (NEVER the full URL or query string, NEVER rendered
// HTML, NEVER typed text, NEVER screenshot bytes).
//
// Run with: npm test

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const browserAudit = require_('../../daemon/browser/audit.cjs') as {
  browserAuditParams: (
    name: string,
    args: Record<string, unknown>,
    successResult: Record<string, unknown>,
  ) => {
    hostname: string;
    path: string;
    status?: number;
    duration_ms: number;
    screenshotBytes?: number;
    expressionBytes?: number;
    fieldCount?: number;
  };
};

const { browserAuditParams } = browserAudit;

describe('browser.audit — browser.navigate shape', () => {
  it('returns {hostname, path, status, duration_ms} — never full URL', () => {
    const r = browserAuditParams(
      'browser.navigate',
      { url: 'https://example.com/projects/foo?token=secret' },
      { url: 'example.com/projects/foo', status: 200, durationMs: 123 },
    );
    expect(r).toEqual({
      hostname: 'example.com',
      path: '/projects/foo',
      status: 200,
      duration_ms: 123,
      screenshotBytes: undefined,
      expressionBytes: undefined,
      fieldCount: undefined,
    });
    // Pitfall 5: never include 'token=secret' or the full URL.
    const serialized = JSON.stringify(r);
    expect(serialized).not.toMatch(/token=secret/);
    expect(serialized).not.toMatch(/example\.com\/projects\/foo\?/);
  });

  it('strips the query string from path (Pitfall 5)', () => {
    const r = browserAuditParams(
      'browser.navigate',
      { url: 'https://api.example.com/oauth?code=ABC123' },
      { url: 'api.example.com/oauth', status: 200, durationMs: 50 },
    );
    expect(r.path).toBe('/oauth');
    expect(r.path).not.toMatch(/\?/);
    expect(JSON.stringify(r)).not.toMatch(/ABC123/);
  });
});

describe('browser.audit — browser.screenshot shape (Plan 2 preview)', () => {
  it('returns screenshotBytes count — never PNG bytes themselves', () => {
    // Note: browser.screenshot operates on the current page (the URL was
    // already navigated by a prior browser.navigate call). The audit
    // helper reads the page URL from args.url when present; for tests
    // we pass the page URL in args so the hostname/path are populated.
    const r = browserAuditParams(
      'browser.screenshot',
      { url: 'http://example.com/', n: 'abc', fullPage: false },
      { hostname: 'example.com', path: '/', bytes: 123456, durationMs: 200 },
    );
    expect(r).toEqual({
      hostname: 'example.com',
      path: '/',
      status: undefined,
      duration_ms: 200,
      screenshotBytes: 123456,
      expressionBytes: undefined,
      fieldCount: undefined,
    });
  });
});

describe('browser.audit — browser.evaluate shape (Plan 2 preview)', () => {
  it('returns expressionBytes count — never the expression source', () => {
    const r = browserAuditParams(
      'browser.evaluate',
      { url: 'http://example.com/', expression: 'document.cookie' },
      { hostname: 'example.com', path: '/', resultBytes: 50, durationMs: 10 },
    );
    expect(r).toEqual({
      hostname: 'example.com',
      path: '/',
      status: undefined,
      duration_ms: 10,
      screenshotBytes: undefined,
      expressionBytes: 15, // 'document.cookie'.length
      fieldCount: undefined,
    });
    expect(JSON.stringify(r)).not.toMatch(/document\.cookie/);
  });
});

describe('browser.audit — browser.fill_form shape (Plan 2 preview)', () => {
  it('returns fieldCount — never field values', () => {
    const r = browserAuditParams(
      'browser.fill_form',
      {
        url: 'http://example.com/login',
        fields: [{ selector: '#a', value: 'secret1' }, { selector: '#b', value: 'secret2' }],
      },
      { hostname: 'example.com', path: '/login', fieldCount: 2, durationMs: 80 },
    );
    expect(r).toEqual({
      hostname: 'example.com',
      path: '/login',
      status: undefined,
      duration_ms: 80,
      screenshotBytes: undefined,
      expressionBytes: undefined,
      fieldCount: 2,
    });
    expect(JSON.stringify(r)).not.toMatch(/secret1/);
    expect(JSON.stringify(r)).not.toMatch(/secret2/);
  });
});

describe('browser.audit — defensive shapes', () => {
  it('malformed URL returns empty hostname + path (never the raw URL)', () => {
    const r = browserAuditParams(
      'browser.navigate',
      { url: 'not a url' },
      {},
    );
    expect(r.hostname).toBe('');
    expect(r.path).toBe('');
    expect(r.duration_ms).toBe(0);
    expect(JSON.stringify(r)).not.toMatch(/not a url/);
  });

  it('empty successResult returns safe defaults', () => {
    const r = browserAuditParams(
      'browser.navigate',
      { url: 'https://example.com/' },
      {},
    );
    expect(r.hostname).toBe('example.com');
    expect(r.path).toBe('/');
    expect(r.status).toBeUndefined();
    expect(r.duration_ms).toBe(0);
  });

  it('unknown browser.* tool name falls back to safe defaults', () => {
    const r = browserAuditParams(
      'browser.unknown',
      {},
      {},
    );
    expect(r.hostname).toBe('');
    expect(r.path).toBe('');
    expect(r.status).toBeUndefined();
    expect(r.duration_ms).toBe(0);
    expect(r.screenshotBytes).toBeUndefined();
    expect(r.expressionBytes).toBeUndefined();
    expect(r.fieldCount).toBeUndefined();
  });

  it('null/undefined args and successResult do not throw', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = browserAuditParams('browser.navigate', undefined as any, undefined as any);
    expect(r.hostname).toBe('');
    expect(r.path).toBe('');
    expect(r.duration_ms).toBe(0);
  });
});