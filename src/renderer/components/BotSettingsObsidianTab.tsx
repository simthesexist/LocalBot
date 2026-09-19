// Phase 7 Plan 3: Obsidian vault settings sub-tab inside BotSettingsPage.
//
// Renders four sections that mirror the daemon's vault config shape:
//   - vaultPath: per-bot vault root override (blank → falls back to global)
//   - vaultAllow: newline-delimited picomatch globs (empty blocks reads)
//   - vaultDeny:  newline-delimited picomatch globs (deny-wins)
//   - vault tool checkboxes: vault.read / vault.write / vault.search /
//     vault.list (all 4 vault.* tools are NOT in DEFAULT_POLICY, so the
//     user must opt in by checking them on the Permissions tab)
//
// Debounce 250ms before calling onPatch — same pattern as the existing
// Schedule / Permissions tabs (T-P4-25). Saving is the parent's job; this
// component only computes the patch + reports the debounced trigger.

import { useEffect, useRef, useState } from 'react';
import type { BotConfig } from '../../shared/types';

export interface BotSettingsObsidianTabProps {
  bot: BotConfig;
  /** Debounced (250ms) patch sink — parent handles bot.update IPC. */
  onPatch: (patch: Partial<BotConfig>) => void;
  /** True while the parent's IPC is in flight. */
  saving: boolean;
  /** Last save error from the parent (or null). */
  error: string | null;
}

const VAULT_TOOLS = ['vault.read', 'vault.write', 'vault.search', 'vault.list'] as const;

function parseGlobList(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function joinGlobList(globs: string[] | undefined): string {
  return Array.isArray(globs) ? globs.join('\n') : '';
}

export function BotSettingsObsidianTab({
  bot,
  onPatch,
  saving,
  error,
}: BotSettingsObsidianTabProps) {
  const [vaultPath, setVaultPath] = useState<string>(bot.vaultPath ?? '');
  const [vaultAllowText, setVaultAllowText] = useState<string>(joinGlobList(bot.vaultAllow));
  const [vaultDenyText, setVaultDenyText] = useState<string>(joinGlobList(bot.vaultDeny));

  // Mirror the existing Permissions tab: the tool allowlist lives in the
  // parent's `bot.allowlist`. We display vault.* checkboxes on this tab
  // for discoverability but the actual save shape is the combined allowlist
  // (preserving any non-vault tools the user has already granted).
  const initialAllowlist = Array.isArray(bot.allowlist) ? bot.allowlist : [];
  const [vaultToolsChecked, setVaultToolsChecked] = useState<Record<string, boolean>>({
    'vault.read': initialAllowlist.includes('vault.read'),
    'vault.write': initialAllowlist.includes('vault.write'),
    'vault.search': initialAllowlist.includes('vault.search'),
    'vault.list': initialAllowlist.includes('vault.list'),
  });

  // Debounced save — 250ms (T-P4-25 pattern, mirrors scheduleGeneralSave).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPatchRef = useRef<string>('');
  const scheduleSave = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const parsedAllow = parseGlobList(vaultAllowText);
      const parsedDeny = parseGlobList(vaultDenyText);
      // Combine the existing non-vault allowlist with the freshly-toggled
      // vault.* entries so we never silently drop a tool the user added
      // on the Permissions tab.
      const nonVault = initialAllowlist.filter((t) => !t.startsWith('vault.'));
      const nextVault = VAULT_TOOLS.filter((t) => vaultToolsChecked[t]);
      const combinedAllowlist = [...nonVault, ...nextVault];
      const patch: Partial<BotConfig> = {
        vaultPath: vaultPath.trim().length > 0 ? vaultPath.trim() : null,
        vaultAllow: parsedAllow,
        vaultDeny: parsedDeny,
        allowlist: combinedAllowlist,
      };
      // Avoid no-op writes (Pitfall 4 — vault config edits should never
      // hammer the IPC bridge with identical payloads).
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
  }, [vaultPath, vaultAllowText, vaultDenyText, vaultToolsChecked]);

  const toggleVaultTool = (tool: string) => {
    setVaultToolsChecked((prev) => ({ ...prev, [tool]: !prev[tool] }));
  };

  return (
    <section
      role="tabpanel"
      data-testid="bot-settings-panel-obsidian"
      className="bot-settings-panel settings-tab-obsidian"
    >
      <section className="form-section">
        <label className="form-label" htmlFor="obsidian-vault-path">
          Vault path
        </label>
        <input
          id="obsidian-vault-path"
          type="text"
          className="modal-input"
          value={vaultPath}
          onChange={(e) => setVaultPath(e.target.value)}
          placeholder="Leave blank to use the global vault root"
          data-testid="obsidian-vault-path"
        />
        <small className="form-hint">
          Absolute path to this bot&apos;s vault. When blank, the global
          rootPath from the top-bar Vault settings applies.
        </small>
      </section>

      <section className="form-section">
        <label className="form-label" htmlFor="obsidian-vault-allow">
          Per-bot allow globs (vault-relative, one per line)
        </label>
        <textarea
          id="obsidian-vault-allow"
          className="modal-input obsidian-glob-textarea"
          value={vaultAllowText}
          onChange={(e) => setVaultAllowText(e.target.value)}
          rows={4}
          placeholder={'Projects/**\nDaily/**\n**/*.md'}
          data-testid="obsidian-vault-allow"
        />
        <small className="form-hint">
          picomatch globs evaluated AFTER the global deny list. Empty
          blocks reads/writes entirely (the &quot;never silently allow&quot;
          safety net).
        </small>
      </section>

      <section className="form-section">
        <label className="form-label" htmlFor="obsidian-vault-deny">
          Per-bot deny globs (vault-relative, one per line)
        </label>
        <textarea
          id="obsidian-vault-deny"
          className="modal-input obsidian-glob-textarea"
          value={vaultDenyText}
          onChange={(e) => setVaultDenyText(e.target.value)}
          rows={4}
          placeholder="Personal/**"
          data-testid="obsidian-vault-deny"
        />
        <small className="form-hint">
          Evaluated AFTER globalDeny but BEFORE vaultAllow (deny-wins
          pipeline). A matching path is refused even if the allow list
          permits it.
        </small>
      </section>

      <section className="form-section">
        <fieldset className="form-fieldset">
          <legend>Vault tools</legend>
          {VAULT_TOOLS.map((tool) => (
            <label key={tool} className="form-checkbox">
              <input
                type="checkbox"
                checked={Boolean(vaultToolsChecked[tool])}
                onChange={() => toggleVaultTool(tool)}
                data-testid={`obsidian-tool-${tool}`}
              />
              <span>{tool}</span>
            </label>
          ))}
        </fieldset>
        <small className="form-hint">
          Vault.* tools are NOT in the default allowlist. Each bot must
          opt in. Writes are restricted to <code>Agents/&lt;bot&gt;/</code>
          regardless of the allow list.
        </small>
      </section>

      <div className="bot-settings-status" data-status={saving ? 'saving' : error ? 'error' : 'saved'}>
        {saving ? 'Saving…' : error ? `Error: ${error}` : 'Saved'}
      </div>
    </section>
  );
}