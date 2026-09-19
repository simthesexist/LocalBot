// Top-level App.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppInitPayload, BotConfig } from '../shared/types';
import { Chat } from './components/Chat';
import { KeyModal } from './components/KeyModal';
import { BotSettingsPage } from './components/BotSettingsPage';
import { ApprovalModalStack } from './components/ApprovalModalStack';
import { VaultGlobalSettingsModal } from './components/VaultGlobalSettingsModal';
import { attachShellEventListeners } from './state/shells';
import { useBots } from './state/bots';

export function App() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [initialMessages, setInitialMessages] = useState<any[] | null>(null);
  const [initialBots, setInitialBots] = useState<BotConfig[]>([]);
  // Phase 4 Wave 3: view toggle 'chat' | 'settings' + settingsBotId.
  // Driven by URL hash so refresh preserves the open settings page.
  const [view, setView] = useState<'chat' | 'settings'>('chat');
  const [settingsBotId, setSettingsBotId] = useState<string | null>(null);
  // Phase 7 Plan 3: top-bar Vault button → opens the global vault settings
  // modal. Visible regardless of which bot is active (T-P7-19 mitigation).
  const [showVaultModal, setShowVaultModal] = useState(false);

  // Bot store hook — needed to look up the BotConfig object by id when
  // the settings page mounts.
  const { bots } = useBots();

  // URL hash sync: restore view + botId from hash on first mount; keep
  // hash in sync on every transition. Hashes:
  //   '' or '#/' → chat
  //   '#/bot/<id>/settings[/<tab>]' → settings for that bot.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => {
      const hash = window.location.hash;
      const m = hash.match(/^#\/bot\/([^/]+)\/settings(?:\/([^/]+))?$/);
      if (m) {
        setSettingsBotId(m[1]);
        setView('settings');
      } else {
        setView('chat');
      }
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  useEffect(() => {
    if (!window.localbot) return;
    const off = window.localbot.on('app:init', (p) => {
      const payload = p as AppInitPayload & { messages?: any[] };
      setHasKey(payload.hasKey);
      setInitialMessages(payload.messages ?? []);
      setInitialBots(Array.isArray(payload.bots) ? payload.bots : []);
    });
    // Close the race window: main's `did-finish-load` handler sends
    // EVENT_APP_INIT on a tick that can fire BEFORE this useEffect registers
    // the listener, dropping the event. After the listener is wired, ask
    // main to re-send the payload. setState is idempotent so a duplicate
    // delivery from the original send (if it landed) is harmless.
    window.localbot.requestAppInit();
    return off;
  }, []);

  // Phase 5 Wave 2: attach the daemon's 3 shell event channels at the root.
  // ApprovalModalStack reads from the resulting queue; ShellStreamBlock reads
  // from the live stream map.
  useEffect(() => {
    if (!window.localbot) return;
    return attachShellEventListeners();
  }, []);

  const openSettings = useCallback((botId: string) => {
    setSettingsBotId(botId);
    setView('settings');
  }, []);

  const closeSettings = useCallback(() => {
    setView('chat');
    setSettingsBotId(null);
    if (typeof window !== 'undefined' && window.location.hash.startsWith('#/bot/')) {
      window.history.replaceState(null, '', '#/');
    }
  }, []);

  const openVaultModal = useCallback(() => setShowVaultModal(true), []);
  const closeVaultModal = useCallback(() => setShowVaultModal(false), []);

  const settingsBot = useMemo(
    () => bots.find((b) => b.id === settingsBotId) ?? initialBots.find((b) => b.id === settingsBotId) ?? null,
    [bots, initialBots, settingsBotId],
  );

  if (hasKey === null) {
    return <div className="boot">Loading…</div>;
  }

  if (!hasKey) {
    return <KeyModal onSaved={() => setHasKey(true)} />;
  }

  if (view === 'settings' && settingsBot) {
    return (
      <BotSettingsPage
        bot={settingsBot}
        onClose={closeSettings}
        onUpdated={() => { /* BotSettingsPage reads fresh bot via bots.find */ }}
      />
    );
  }
  return (
    <>
      <Chat
        initialMessages={initialMessages ?? []}
        initialBots={initialBots}
        onOpenSettings={openSettings}
        onOpenVault={openVaultModal}
      />
      <ApprovalModalStack />
      {showVaultModal && (
        <VaultGlobalSettingsModal open={showVaultModal} onClose={closeVaultModal} />
      )}
    </>
  );
}
