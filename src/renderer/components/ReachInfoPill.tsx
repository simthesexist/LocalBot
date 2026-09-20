// Phase 9 Plan 2: ReachInfoPill.
//
// Top-bar pill that surfaces the user's current reach surface. Three
// display modes based on `useNetworkConfig().reachInfo`:
//   1. Tailscale detected → "Reachable at: <magicDns>:<port>"
//   2. LAN IPv4 available → "LAN: http://<lan-ip>:<port>"
//   3. Neither            → "Localhost only — Open settings" (muted)
//
// The pill NEVER mutates bindMode directly. Clicking always opens
// NetworkSettingsModal (NET-03 v1 invariant). data-testid attributes are
// wired for the Wave 3 Playwright E2E suite.

import { useNetworkConfig } from '../state/network';

export interface ReachInfoPillProps {
  onClick: () => void;
}

export function ReachInfoPill({ onClick }: ReachInfoPillProps) {
  const { config, reachInfo } = useNetworkConfig();
  const port = config?.port ?? 7878;

  if (reachInfo?.tailscale && reachInfo.magicDnsName) {
    return (
      <button
        type="button"
        className="reach-info-pill"
        onClick={onClick}
        data-testid="reach-info-pill-tailscale"
        aria-label="Reachable at Tailscale MagicDNS"
      >
        Reachable at: {reachInfo.magicDnsName}:{port}
      </button>
    );
  }

  if (reachInfo?.lanIps && reachInfo.lanIps.length > 0) {
    return (
      <button
        type="button"
        className="reach-info-pill"
        onClick={onClick}
        data-testid="reach-info-pill-lan"
        aria-label="Reachable at LAN IP"
      >
        LAN: http://{reachInfo.lanIps[0]}:{port}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="reach-info-pill muted"
      onClick={onClick}
      data-testid="reach-info-pill-localhost"
      aria-label="Localhost only — open settings"
    >
      Localhost only — Open settings
    </button>
  );
}