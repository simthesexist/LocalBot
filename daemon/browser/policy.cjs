// Phase 8 Plan 1: URL policy for browser automation.
//
// Mirrors `daemon/vault/glob.cjs` (Phase 7 Plan 1) line-for-line in spirit:
// two-layer deny-wins pipeline (deny list first, allow list second), with
// `pattern` surfaced on every denied verdict so audit rows can attribute the
// rejection to a specific glob string.
//
// Pipeline (THIS EXACT ORDER — Pitfall 5 / OWASP SSRF cheat sheet):
//
//   1. URL parse — `new URL(url)`. Throws → { allowed:false, reason:'invalid_url' }.
//   2. Scheme allowlist — only `http:` + `https:` permitted. Anything else
//      (file:, javascript:, data:, ftp:, chrome:) → { allowed:false,
//      reason:'scheme_denied', pattern: parsed.protocol }.
//   3. DNS resolution — `dns.lookup(hostname, { all:true })`. For each
//      resolved IP, if `isPrivateIp(ip)` is true AND `ssrfAllowInternal` is
//      false → { allowed:false, reason:'ssrf_denied', pattern: address }.
//      This blocks RFC1918 / 127.0.0.0/8 / 169.254.0.0/16 / IPv6
//      link-local / ULA / ::1 by default. The `ssrfAllowInternal` opt-out
//      flag exists for hermetic E2E + dev use (LOCALBOT_ALLOW_INTERNAL_HOSTS).
//   4. Pathname denylist — `picomatch(browserDeny, {dot:true})` against
//      `parsed.pathname`. First match wins; pattern is returned. Query
//      string is stripped before the glob check (Pitfall 5).
//   5. Pathname allowlist — empty `browserAllow` → block by default
//      (Pitfall: never silently allow). Non-empty → `picomatch` match
//      against `parsed.pathname`. First miss → `not_in_allowlist`.
//   6. Return `{ allowed:true }`.
//
// Threat model coverage:
//   - T-8-01: URL allowlist default-deny + SSRF shield (RFC1918/127/169.254
//     + IPv6 link-local/ULA/loopback); scheme allowlist http/https only.

const picomatch = require('picomatch');
const dns = require('node:dns').promises;
const net = require('node:net');

/**
 * isPrivateIp(ip) → boolean.
 *
 * Coverage:
 *   IPv4: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 *         169.254.0.0/16 (link-local + cloud metadata), 0.0.0.0.
 *   IPv6: ::1 (loopback), fc00::/7 (ULA), fe80::/10 (link-local).
 *
 * Exported for unit-test reuse via `__test__`.
 */
function isPrivateIp(ip) {
  if (typeof ip !== 'string' || ip.length === 0) return false;
  if (net.isIPv4(ip)) {
    if (ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) return true;
    if (ip === '0.0.0.0') return true;
    if (ip.startsWith('172.')) {
      // 172.16.0.0/12 → second octet 16-31
      const parts = ip.split('.');
      if (parts.length === 4) {
        const octet2 = parseInt(parts[1], 10);
        if (Number.isFinite(octet2) && octet2 >= 16 && octet2 <= 31) return true;
      }
    }
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    // fc00::/7 → first byte 0xfc..0xfd; case-insensitive on the hex prefix.
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // fe80::/10 → starts with fe80: / fe8x: / fe9x: / feax: / febx:
    if (lower.startsWith('fe80:') || lower.startsWith('fe8') ||
        lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true;
    }
    return false;
  }
  return false;
}

function makeMatcher(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return () => false;
  const cleaned = patterns.filter((p) => typeof p === 'string' && p.length > 0);
  if (cleaned.length === 0) return () => false;
  return picomatch(cleaned, { dot: true, nocase: false });
}

function firstMatching(patterns, target) {
  if (!Array.isArray(patterns)) return undefined;
  for (const p of patterns) {
    if (typeof p !== 'string') continue;
    if (picomatch.isMatch(target, p, { dot: true })) return p;
  }
  return undefined;
}

/**
 * checkBrowserUrl({browserAllow, browserDeny, ssrfAllowInternal, url})
 *   → Promise<{allowed:true} | {allowed:false, reason, pattern?}>
 *
 * Pipeline described in the file header. `pattern` is set on every denied
 * verdict where there's a meaningful string to attribute the rejection to
 * (the matched glob, the resolved private IP, or the rejected scheme).
 */
async function checkBrowserUrl({ browserAllow, browserDeny, ssrfAllowInternal, url }) {
  if (typeof url !== 'string' || url.length === 0) {
    return { allowed: false, reason: 'invalid_url' };
  }

  // Step 1: parse.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'invalid_url' };
  }

  // Step 2: scheme allowlist.
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { allowed: false, reason: 'scheme_denied', pattern: parsed.protocol };
  }

  // Step 3: DNS resolution + SSRF shield.
  // `parsed.hostname` may be empty (e.g. `http:///foo`); guard explicitly.
  if (typeof parsed.hostname !== 'string' || parsed.hostname.length === 0) {
    return { allowed: false, reason: 'invalid_url' };
  }
  let resolved;
  try {
    resolved = await dns.lookup(parsed.hostname, { all: true });
  } catch {
    // DNS failure (NXDOMAIN, ENOTFOUND) — treat as `not_in_allowlist` so a
    // hostname that doesn't resolve still can't be smuggled through. The
    // `pattern` field carries the original hostname for audit.
    return { allowed: false, reason: 'ssrf_denied', pattern: parsed.hostname };
  }
  if (!Array.isArray(resolved)) resolved = [];
  if (!ssrfAllowInternal) {
    for (const r of resolved) {
      const address = r && typeof r.address === 'string' ? r.address : '';
      if (address && isPrivateIp(address)) {
        return { allowed: false, reason: 'ssrf_denied', pattern: address };
      }
    }
  }

  // Step 4: pathname denylist. Query string stripped BEFORE the glob check.
  if (Array.isArray(browserDeny) && browserDeny.length) {
    const m = makeMatcher(browserDeny);
    if (m(parsed.pathname)) {
      return { allowed: false, reason: 'browser_deny', pattern: firstMatching(browserDeny, parsed.pathname) };
    }
  }

  // Step 5: pathname allowlist (default-deny — Pitfall: never silently allow).
  if (!Array.isArray(browserAllow) || browserAllow.length === 0) {
    return { allowed: false, reason: 'no_allowlist' };
  }
  const allow = makeMatcher(browserAllow);
  if (!allow(parsed.pathname)) {
    return { allowed: false, reason: 'not_in_allowlist' };
  }

  // Step 6: green light.
  return { allowed: true };
}

module.exports = {
  checkBrowserUrl,
  isPrivateIp,
  // Test seam — unit tests import isPrivateIp through this seam so the
  // module surface stays minimal in production.
  __test__: { isPrivateIp },
};