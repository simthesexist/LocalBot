// Phase 9 Plan 2: Tailscale MagicDNS detection tests.
//
// Covers:
//   A. detectReach with mocked fs returning valid state.json
//      → {tailscale:true, magicDnsName:'<stripped>', lanIps:[...]}
//   B. detectReach with mocked fs throwing ENOENT
//      → {tailscale:false, lanIps:[...]} (graceful fallback)
//   C. detectReach with mocked fs returning corrupt JSON
//      → {tailscale:false, lanIps:[...]} (graceful fallback)
//   D. detectReach with mocked fs returning state.json without
//      Self.DNSName → {tailscale:false, lanIps:[...]}
//   E. detectReach cache TTL — clearCache forces fresh on next call
//   F. detectReach with mocked os.networkInterfaces returning IPv4
//      non-internal + IPv6 + internal IPv4 → lanIps contains only
//      non-internal IPv4
//   G. __test__.parseStateJson — happy path + empty + corrupt + missing Self

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted() makes these values available inside vi.mock factories
// (vi.mock factories are hoisted above all imports).
const { mockReadFileSync, mockNetworkInterfaces } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn<(path: string, enc: string) => string | Buffer>(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  mockNetworkInterfaces: vi.fn<() => NodeJS.NetworkInterfaceInfo[]>(() => []),
}));

vi.mock('node:os', () => {
  return {
    default: {
      homedir: () => '/tmp/fake-home',
      networkInterfaces: () => ({
        eth0: [
          { family: 'IPv4', address: '192.168.1.42', internal: false },
          { family: 'IPv6', address: 'fe80::1', internal: false },
        ],
        lo: [
          { family: 'IPv4', address: '127.0.0.1', internal: true },
        ],
      }),
    },
    homedir: () => '/tmp/fake-home',
    networkInterfaces: () => ({
      eth0: [
        { family: 'IPv4', address: '192.168.1.42', internal: false },
        { family: 'IPv6', address: 'fe80::1', internal: false },
      ],
      lo: [
        { family: 'IPv4', address: '127.0.0.1', internal: true },
      ],
    }),
  };
});

vi.mock('node:fs', () => {
  return {
    default: {
      readFileSync: (path: string, enc: string) => mockReadFileSync(path, enc),
    },
    readFileSync: (path: string, enc: string) => mockReadFileSync(path, enc),
  };
});

import { detectReach, clearCache, __test__ } from '../../src/main/network/tailscale';

beforeEach(() => {
  __test__.reset();
  mockReadFileSync.mockReset();
  mockReadFileSync.mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  // Silence the unused-var warning from the hoisted factory.
  void mockNetworkInterfaces;
});

describe('tailscale.detectReach', () => {
  it('Case B: graceful fallback when state.json is missing (ENOENT)', async () => {
    const info = await detectReach();
    expect(info.tailscale).toBe(false);
    expect(info.magicDnsName).toBeUndefined();
    expect(info.lanIps).toContain('192.168.1.42');
    expect(info.lanIps).not.toContain('127.0.0.1');
    expect(info.lanIps).not.toContain('fe80::1');
  });

  it('Case C: graceful fallback when state.json is corrupt JSON', async () => {
    mockReadFileSync.mockImplementationOnce(() => '{not-json oops');
    const info = await detectReach();
    expect(info.tailscale).toBe(false);
    expect(info.lanIps).toContain('192.168.1.42');
  });

  it('Case A: detects Tailscale via state.json with valid Self.DNSName + strips trailing dot', async () => {
    mockReadFileSync.mockImplementationOnce(() =>
      JSON.stringify({ Self: { DNSName: 'myhost.tail<hash>.ts.net.' } }),
    );
    const info = await detectReach();
    expect(info.tailscale).toBe(true);
    expect(info.magicDnsName).toBe('myhost.tail<hash>.ts.net');
    expect(info.lanIps).toContain('192.168.1.42');
  });

  it('Case D: graceful fallback when Self.DNSName is missing', async () => {
    mockReadFileSync.mockImplementationOnce(() =>
      JSON.stringify({ Self: { ID: 'abc' } }),
    );
    const info = await detectReach();
    expect(info.tailscale).toBe(false);
    expect(info.lanIps).toContain('192.168.1.42');
  });

  it('Case E: cache TTL — second call within TTL returns cached; clearCache forces fresh', async () => {
    mockReadFileSync.mockImplementationOnce(() =>
      JSON.stringify({ Self: { DNSName: 'cached.tail<hash>.ts.net.' } }),
    );
    const first = await detectReach();
    expect(first.tailscale).toBe(true);
    expect(first.magicDnsName).toBe('cached.tail<hash>.ts.net');

    // The mock is reset to a fresh DNSName. Within the TTL, the second
    // call must NOT touch fs.readFileSync and must return the cached
    // value.
    mockReadFileSync.mockImplementationOnce(() =>
      JSON.stringify({ Self: { DNSName: 'fresh.tail<hash>.ts.net.' } }),
    );
    const beforeClearCallCount = mockReadFileSync.mock.calls.length;
    const cached = await detectReach();
    expect(cached.magicDnsName).toBe('cached.tail<hash>.ts.net');
    // No additional fs.readFileSync call within the TTL.
    expect(mockReadFileSync.mock.calls.length).toBe(beforeClearCallCount);

    // After clearCache(), the next call MUST hit the fs mock again and
    // return fresh.
    clearCache();
    const fresh = await detectReach();
    expect(fresh.magicDnsName).toBe('fresh.tail<hash>.ts.net');
  });

  it('Case F: lanIps filters to non-internal IPv4 only', async () => {
    const info = await detectReach();
    // Internal IPv4 (127.0.0.1) and IPv6 (fe80::1) MUST NOT appear.
    expect(info.lanIps).toEqual(['192.168.1.42']);
  });
});

describe('tailscale.__test__.parseStateJson', () => {
  it('Case G: valid input with trailing dot strips it', () => {
    const r = __test__.parseStateJson(
      JSON.stringify({ Self: { DNSName: 'a.tail.ts.net.' } }),
    );
    expect(r).toEqual({ tailscale: true, magicDnsName: 'a.tail.ts.net' });
  });

  it('Case G: empty DNSName → tailscale:false', () => {
    const r = __test__.parseStateJson(JSON.stringify({ Self: { DNSName: '' } }));
    expect(r).toEqual({ tailscale: false });
  });

  it('Case G: corrupt JSON → tailscale:false', () => {
    const r = __test__.parseStateJson('{nope');
    expect(r).toEqual({ tailscale: false });
  });

  it('Case G: missing Self → tailscale:false', () => {
    const r = __test__.parseStateJson(JSON.stringify({ other: 1 }));
    expect(r).toEqual({ tailscale: false });
  });
});