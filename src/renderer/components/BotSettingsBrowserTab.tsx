// Phase 8 Plan 3: Browser settings sub-tab inside BotSettingsPage.
//
// Renders four sections that mirror the daemon's browser config shape:
//   - browserAllow:     newline-delimited picomatch globs (empty blocks
//                       all navigation — default-deny)
//   - browserDeny:      newline-delimited picomatch globs (deny-wins)
//   - ssrfAllowInternal: opt-out checkbox for RFC1918 / 127.0.0.0/8 /
//                        169.254.0.0/16 / IPv6 link-local / ULA / loopback
//                        navigation (T-8-21 + hermetic tests escape hatch)
//   - browser tools:    6 checkboxes (browser.navigate / browser.click /
//                       browser.type / browser.fill_form /
//                       browser.screenshot / browser.evaluate) — bots
//                       must explicitly opt in to each (Pitfall 7).
//
// Debounce 250ms before calling onPatch — same pattern as the Obsidian
// tab (T-P4-25). Saving is the parent's job; this component only computes
// the patch + reports the debounced trigger.

import { useEffect, useRef, useState } from 'react';
import type { BotConfig } from '../../shared/types';

export interface BotSettingsBrowserTabProps {
  bot: BotConfig;
  /** Debounced (250ms) patch sink — parent handles bot.update IPC. */
  onPatch: (patch: Partial<BotConfig>) => void;
  /** True while the parent's IPC is in flight. */
  saving: boolean;
  /** Last save error from the parent (or null). */
  error: string | null;
}

const BROWSER_TOOLS = [
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.fill_form',
  'browser.screenshot',
  'browser.evaluate',
] as const;

function parseGlobList(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function joinGlobList(globs: string[] | undefined): string {
  return Array.isArray(globs) ? globs.join('\n') : '';
}

export function BotSettingsBrowserTab({
  bot,
  onPatch,
  saving,
  error,
}: BotSettingsBrowserTabProps) {
  const [browserAllowText, setBrowserAllowText] = useState<string>(joinGlobList(bot.browserAllow));
  const [browserDenyText, setBrowserDenyText] = useState<string>(joinGlobList(bot.browserDeny));
  const [ssrfAllowInternal, setSsrfAllowInternal] = useState<boolean>(bot.ssrfAllowInternal === true);

  // Mirror the existing Permissions tab: the tool allowlist lives in the
  // parent's `bot.allowlist`. We display browser.* checkboxes on this tab
  // for discoverability but the actual save shape is the combined allowlist
  // (preserving any non-browser tools the user has already granted).
  const initialAllowlist = Array.isArray(bot.allowlist) ? bot.allowlist : [];
  const [browserToolsChecked, setBrowserToolsChecked] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const t of BROWSER_TOOLS) init[t] = initialAllowlist.includes(t);
    return init;
  });

  // Debounced save — 250ms (T-P4-25 pattern, mirrors scheduleGeneralSave).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPatchRef = useRef<string>('');
  const scheduleSave = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const parsedAllow = parseGlobList(browserAllowText);
      const parsedDeny = parseGlobList(browserDenyText);
      // Combine the existing non-browser allowlist with the freshly-toggled
      // browser.* entries so we never silently drop a tool the user added
      // on the Permissions tab.
      const nonBrowser = initialAllowlist.filter((t) => !t.startsWith('browser.'));
      const nextBrowser = BROWSER_TOOLS.filter((t) => browserToolsChecked[t]);
      const combinedAllowlist = [...nonBrowser, ...nextBrowser];
      const patch: Partial<BotConfig> = {
        browserAllow: parsedAllow,
        browserDeny: parsedDeny,
        ssrfAllowInternal,
        allowlist: combinedAllowlist,
      };
      // Avoid no-op writes (Pitfall 4 — config edits should never hammer
      // the IPC bridge with identical payloads).
      const sig = JSON.stringify(patch);
      if (sig === lastPatchRef.current) return;
      lastPatchRef.current = sig;
      onPatch(patch);
    }, 250);
  };

  // Re-arm the debounced save on every meaningful change.
  useEffect(() => {
    scheduleSave();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserAllowText, browserDenyText, ssrfAllowInternal, browserToolsChecked]);

  const toggleBrowserTool = (tool: string) => {
    setBrowserToolsChecked((prev) => ({ ...prev, [tool]: !prev[tool] }));
  };

  return (
    <section
      role="tabpanel"
      data-testid="bot-settings-panel-browser"
      className="bot-settings-panel settings-tab-browser"
    >
      <section className="form-section">
        <label className="form-label" htmlFor="browser-url-allow">
          URL allow globs (one per line)
        </label>
        <textarea
          id="browser-url-allow"
          className="modal-input browser-glob-textarea"
          value={browserAllowText}
          onChange={(e) => setBrowserAllowText(e.target.value)}
          rows={4}
          placeholder={'https://example.com/**\nhttps://docs.example.com/**'}
          data-testid="browser-url-allow"
          aria-label="URL allow globs"
        />
        <small className="form-hint">
          picomatch globs evaluated against the URL pathname (NOT the query
          string). When empty, navigation is blocked entirely (the
          default-deny safety net).
        </small>
      </section>

      <section className="form-section">
        <label className="form-label" htmlFor="browser-url-deny">
          URL deny globs (one per line)
        </label>
        <textarea
          id="browser-url-deny"
          className="modal-input browser-glob-textarea"
          value={browserDenyText}
          onChange={(e) => setBrowserDenyText(e.target.value)}
          rows={4}
          placeholder={'https://example.com/admin/**'}
          data-testid="browser-url-deny"
          aria-label="URL deny globs"
        />
        <small className="form-hint">
          Evaluated BEFORE the allow list (deny-wins pipeline). A matching
          pathname is refused even if the allow list permits it.
        </small>
      </section>

      <section className="form-section">
        <fieldset className="form-fieldset">
          <legend>SSRF opt-out</legend>
          <label className="form-checkbox" htmlFor="browser-ssrf-allow-internal">
            <input
              id="browser-ssrf-allow-internal"
              type="checkbox"
              checked={ssrfAllowInternal}
              onChange={(e) => setSsrfAllowInternal(e.target.checked)}
              data-testid="browser-ssrf-allow-internal"
            />
            <span>
              Allow internal IPs (localhost, RFC1918, 169.254.0.0/16, IPv6 link-local).
            </span>
          </label>
          <small className="form-hint">
            WARNING: enables the bot to read local services (private dashboards,
            metadata endpoints). Required for hermetic tests against
            <code> 127.0.0.1</code>.
          </small>
        </fieldset>
      </section>

      <section className="form-section">
        <fieldset className="form-fieldset">
          <legend>Browser tools</legend>
          {BROWSER_TOOLS.map((tool) => (
            <label key={tool} className="form-checkbox">
              <input
                type="checkbox"
                checked={Boolean(browserToolsChecked[tool])}
                onChange={() => toggleBrowserTool(tool)}
                data-testid={`browser-tool-${tool}`}
              />
              <span>{tool}</span>
            </label>
          ))}
        </fieldset>
        <small className="form-hint">
          Browser.* tools are NOT in the default allowlist. Each bot must
          opt in. URL allow/deny globs above apply to all 6 tools
          simultaneously.
        </small>
      </section>

      <div className="bot-settings-status" data-status={saving ? 'saving' : error ? 'error' : 'saved'}>
        {saving ? 'Saving…' : error ? `Error: ${error}` : 'Saved'}
      </div>
    </section>
  );
}
