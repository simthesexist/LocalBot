// Phase 9 Plan 2: Tailscale MagicDNS detection.
//
// Strategy (RESEARCH §Pattern 3, §Pitfall 5):
//   1. ALWAYS read %LOCALAPPDATA%\Tailscale\state.json FIRST. The presence
//      of `Self.DNSName` in that JSON is the authoritative signal that
//      Tailscale is installed and MagicDNS is enabled on this host.
//   2. NEVER trust `os.networkInterfaces()` for Tailscale presence — a
//      100.x.x.x CGNAT range or any other "looks like Tailscale" IP could
//      be a coincidence (Pitfall 5). Network interfaces are used ONLY for
//      LAN IP collection so the user has a fallback reach URL.
//   3. Cache the result for 5s TTL — a renderer flooding `getReachInfo`
//      (or main's 5s refresh interval) MUST NOT re-parse state.json every
//      tick. The cache lives in module-scope; the periodic refresh in
//      src/main/index.ts calls `clearCache()` BEFORE re-detecting.
//
// Audit minimization (T-9-W2-02): we extract ONLY `Self.DNSName`. We never
// log auth tokens, machine IDs, or peer metadata from state.json — those
// fields exist but the parser touches only `Self?.DNSName`.
//
// Test seams: `__test__` exposes `parseStateJson`, `getStatePath`, and
// `TTL_MS` so vitest cases can exercise the parse logic + cache TTL without
// needing a real Tailscale installation.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReachInfo } from '../../shared/types';

const TTL_MS = 5000;

let cached: { at: number; info: ReachInfo } | null = null;

/**
 * Resolve the Tailscale state.json path. Windows-first per the project's
 * Windows-only constraint (CLAUDE.md). On non-Windows hosts the function
 * still returns a path so dev tools that try `detectReach()` don't crash,
 * but the path will simply not exist.
 */
function resolveStatePath(): string {
  const localAppData = process.env.LOCALAPPDATA;
  const base = localAppData && localAppData.length > 0
    ? localAppData
    : path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Tailscale', 'state.json');
}

/**
 * Pure parse of the Tailscale state.json shape. Returns
 * `{tailscale:true, magicDnsName: <stripped>}` when the field is a non-empty
 * string, otherwise `{tailscale:false}`. Never throws.
 *
 * Exposed via `__test__` so test cases can drive the parse logic without
 * touching the filesystem.
 */
function parseStateJson(raw: string): { tailscale: boolean; magicDnsName?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { tailscale: false };
  }
  if (!parsed || typeof parsed !== 'object') return { tailscale: false };
  const self = (parsed as { Self?: unknown }).Self;
  if (!self || typeof self !== 'object') return { tailscale: false };
  const dnsName = (self as { DNSName?: unknown }).DNSName;
  if (typeof dnsName !== 'string' || dnsName.length === 0) {
    return { tailscale: false };
  }
  // MagicDNS names always end with a trailing dot (FQDN form). Strip it so
  // the renderer can present "myhost.tail<hash>.ts.net" without the dot.
  const stripped = dnsName.endsWith('.') ? dnsName.slice(0, -1) : dnsName;
  return { tailscale: true, magicDnsName: stripped };
}

/**
 * Collect non-internal IPv4 addresses from `os.networkInterfaces()` for
 * the LAN fallback reach URL. IPv6 / link-local / loopback entries are
 * excluded — only the addresses the user could paste into a phone
 * browser matter.
 */
function collectLanIps(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!Array.isArray(list)) continue;
    for (const i of list) {
      if (!i) continue;
      if (i.family !== 'IPv4') continue;
      if (i.internal === true) continue;
      out.push(i.address);
    }
  }
  return out;
}

/**
 * Resolve the user's reach surface: Tailscale MagicDNS (if installed),
 * plus LAN IPv4 addresses as a fallback. Cached for `TTL_MS` ms to
 * bound re-read cost.
 */
export async function detectReach(): Promise<ReachInfo> {
  if (cached && Date.now() - cached.at < TTL_MS) {
    return cached.info;
  }

  const info: ReachInfo = { tailscale: false, lanIps: [] };

  const statePath = resolveStatePath();
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = parseStateJson(raw);
    if (parsed.tailscale && parsed.magicDnsName) {
      info.tailscale = true;
      info.magicDnsName = parsed.magicDnsName;
    }
  } catch {
    // ENOENT (Tailscale not installed) or corrupt JSON → graceful
    // fallback to `{tailscale:false, lanIps:[...]}`. Never throw.
  }

  info.lanIps = collectLanIps();

  cached = { at: Date.now(), info };
  return info;
}

/** Clear the module-scope cache. Used by the periodic refresh in main. */
export function clearCache(): void {
  cached = null;
}

export const __test__ = {
  parseStateJson,
  getStatePath: resolveStatePath,
  TTL_MS,
  reset(): void {
    cached = null;
  },
};