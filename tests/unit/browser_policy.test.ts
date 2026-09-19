// Unit tests for daemon/browser/policy.cjs — URL allowlist + SSRF shield.
//
// Phase 8 Plan 1: covers the deny-wins pipeline + scheme allowlist +
// DNS SSRF shield + ssrfAllowInternal opt-out + isPrivateIp unit
// coverage (Pitfall 5 + T-8-01).
//
// Run with: npm test

import { describe, it, expect, vi, afterEach } from 'vitest';
import dns from 'node:dns';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const browserPolicy = require_('../../daemon/browser/policy.cjs') as {
  checkBrowserUrl: (req: {
    browserAllow?: string[];
    browserDeny?: string[];
    ssrfAllowInternal?: boolean;
    url: string;
  }) => Promise<{ allowed: boolean; reason?: string; pattern?: string }>;
  isPrivateIp: (ip: string) => boolean;
  __test__: { isPrivateIp: (ip: string) => boolean };
};

// Helper: mock DNS to return a fixed address.
function mockLookup(addresses: Array<{ address: string; family?: 4 | 6 }>) {
  return vi.spyOn(dns.promises, 'lookup').mockResolvedValue(addresses as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('browser.policy — scheme allowlist (Pitfall 5 / T-8-01)', () => {
  it('refuses file: scheme', async () => {
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: true,
      url: 'file:///C:/Windows/System32/config/SAM',
    });
    expect(r).toEqual({ allowed: false, reason: 'scheme_denied', pattern: 'file:' });
  });

  it('refuses javascript:, data:, ftp:, chrome: schemes', async () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/plain;base64,SGVsbG8=',
      'ftp://example.com/foo',
      'chrome://settings',
    ]) {
      const r = await browserPolicy.checkBrowserUrl({
        browserAllow: ['**/*'],
        browserDeny: [],
        ssrfAllowInternal: true,
        url,
      });
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('scheme_denied');
    }
  });
});

describe('browser.policy — SSRF IPv4 shield (RFC1918 + 127 + 169.254)', () => {
  it('blocks 127.0.0.1 (loopback)', async () => {
    mockLookup([{ address: '127.0.0.1', family: 4 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: false,
      url: 'http://localhost/',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('ssrf_denied');
    expect(r.pattern).toBe('127.0.0.1');
  });

  it('blocks 10.0.0.1 (RFC1918 10/8)', async () => {
    mockLookup([{ address: '10.0.0.1', family: 4 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: false,
      url: 'http://internal/',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('ssrf_denied');
    expect(r.pattern).toBe('10.0.0.1');
  });

  it('blocks 192.168.1.1 (RFC1918 192.168/16)', async () => {
    mockLookup([{ address: '192.168.1.1', family: 4 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: false,
      url: 'http://router/',
    });
    expect(r).toMatchObject({ allowed: false, reason: 'ssrf_denied', pattern: '192.168.1.1' });
  });

  it('blocks 172.16.0.1 (RFC1918 172.16/12 lower bound)', async () => {
    mockLookup([{ address: '172.16.0.1', family: 4 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: false,
      url: 'http://lan/',
    });
    expect(r).toMatchObject({ allowed: false, reason: 'ssrf_denied', pattern: '172.16.0.1' });
  });

  it('blocks 172.31.0.1 (RFC1918 172.16/12 upper bound)', async () => {
    mockLookup([{ address: '172.31.0.1', family: 4 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: false,
      url: 'http://lan/',
    });
    expect(r).toMatchObject({ allowed: false, reason: 'ssrf_denied', pattern: '172.31.0.1' });
  });

  it('blocks 169.254.169.254 (cloud metadata)', async () => {
    mockLookup([{ address: '169.254.169.254', family: 4 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: false,
      url: 'http://metadata/',
    });
    expect(r).toMatchObject({ allowed: false, reason: 'ssrf_denied', pattern: '169.254.169.254' });
  });

  it('blocks 0.0.0.0 (unspecified)', async () => {
    mockLookup([{ address: '0.0.0.0', family: 4 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: false,
      url: 'http://unspecified/',
    });
    expect(r).toMatchObject({ allowed: false, reason: 'ssrf_denied', pattern: '0.0.0.0' });
  });
});

describe('browser.policy — SSRF IPv6 shield (link-local / ULA / loopback)', () => {
  it('blocks ::1 (IPv6 loopback)', async () => {
    mockLookup([{ address: '::1', family: 6 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: false,
      url: 'http://[::1]/',
    });
    expect(r).toMatchObject({ allowed: false, reason: 'ssrf_denied', pattern: '::1' });
  });

  it('blocks fc00::1 (IPv6 ULA)', async () => {
    mockLookup([{ address: 'fc00::1', family: 6 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: false,
      url: 'http://[fc00::1]/',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('ssrf_denied');
    expect(r.pattern).toBe('fc00::1');
  });

  it('blocks fe80::1 (IPv6 link-local)', async () => {
    mockLookup([{ address: 'fe80::1', family: 6 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: false,
      url: 'http://[fe80::1]/',
    });
    expect(r).toMatchObject({ allowed: false, reason: 'ssrf_denied', pattern: 'fe80::1' });
  });
});

describe('browser.policy — ssrfAllowInternal opt-out', () => {
  it('allows private IP when ssrfAllowInternal is true', async () => {
    mockLookup([{ address: '127.0.0.1', family: 4 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: true,
      url: 'http://localhost/',
    });
    // SSRF check passes; result depends on glob pipeline (allow matches).
    expect(r.allowed).toBe(true);
  });
});

describe('browser.policy — default-deny + glob pipeline', () => {
  it('blocks with reason:no_allowlist when browserAllow is empty', async () => {
    mockLookup([{ address: '93.184.216.34', family: 4 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: [],
      browserDeny: [],
      ssrfAllowInternal: true,
      url: 'http://example.com/',
    });
    expect(r).toEqual({ allowed: false, reason: 'no_allowlist' });
  });

  it('blocks with reason:not_in_allowlist when path does not match browserAllow', async () => {
    mockLookup([{ address: '93.184.216.34', family: 4 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['https://example.com/projects/**'],
      browserDeny: [],
      ssrfAllowInternal: true,
      url: 'http://example.com/admin',
    });
    expect(r).toEqual({ allowed: false, reason: 'not_in_allowlist' });
  });

  it('allows when path matches browserAllow (**/*)', async () => {
    mockLookup([{ address: '93.184.216.34', family: 4 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: true,
      url: 'http://example.com/projects/foo',
    });
    expect(r).toEqual({ allowed: true });
  });

  it('blocks with reason:browser_deny when path matches browserDeny', async () => {
    mockLookup([{ address: '93.184.216.34', family: 4 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: ['**/admin/**'],
      ssrfAllowInternal: true,
      url: 'http://example.com/admin/secret',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('browser_deny');
    expect(r.pattern).toBe('**/admin/**');
  });

  it('browserDeny wins before browserAllow when both could match', async () => {
    mockLookup([{ address: '93.184.216.34', family: 4 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: ['**/admin/**'],
      ssrfAllowInternal: true,
      url: 'http://example.com/admin',
    });
    expect(r.reason).toBe('browser_deny');
  });
});

describe('browser.policy — dotfile + invalid URL', () => {
  it('allows dotfile path when browserAllow is **/* (picomatch dot:true)', async () => {
    mockLookup([{ address: '93.184.216.34', family: 4 }]);
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: true,
      url: 'http://example.com/.env',
    });
    expect(r.allowed).toBe(true);
  });

  it('returns invalid_url for non-URL input', async () => {
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: true,
      url: 'not a url',
    });
    expect(r).toEqual({ allowed: false, reason: 'invalid_url' });
  });

  it('returns invalid_url for empty URL', async () => {
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: true,
      url: '',
    });
    expect(r).toEqual({ allowed: false, reason: 'invalid_url' });
  });

  it('returns invalid_url for http:// (no hostname)', async () => {
    const r = await browserPolicy.checkBrowserUrl({
      browserAllow: ['**/*'],
      browserDeny: [],
      ssrfAllowInternal: true,
      url: 'http://',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('invalid_url');
  });
});

describe('browser.policy — isPrivateIp unit coverage', () => {
  const cases: Array<[string, boolean]> = [
    ['127.0.0.1', true],
    ['10.0.0.1', true],
    ['192.168.1.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.15.0.1', false], // boundary: 172.15 is public
    ['172.32.0.1', false], // boundary: 172.32 is public
    ['169.254.169.254', true], // cloud metadata
    ['0.0.0.0', true],
    ['8.8.8.8', false], // public
    ['93.184.216.34', false], // public (example.com)
    ['::1', true],
    ['fc00::1', true],
    ['fd12::1', true],
    ['fe80::1', true],
    ['feb0::1', true], // boundary
    ['fec0::1', false], // boundary: outside fe80::/10
    ['2001:db8::1', false], // public
  ];
  for (const [ip, expected] of cases) {
    it(`isPrivateIp(${ip}) → ${expected}`, () => {
      expect(browserPolicy.isPrivateIp(ip)).toBe(expected);
    });
  }

  it('isPrivateIp returns false for non-IP strings', () => {
    expect(browserPolicy.isPrivateIp('')).toBe(false);
    expect(browserPolicy.isPrivateIp('not an ip')).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(browserPolicy.isPrivateIp(undefined as any)).toBe(false);
  });
});