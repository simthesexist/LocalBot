// Top-level App.

import { useEffect, useState } from 'react';
import type { AppInitPayload } from '../shared/types';
import { Chat } from './components/Chat';
import { KeyModal } from './components/KeyModal';

export function App() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [initialMessages, setInitialMessages] = useState<any[] | null>(null);

  useEffect(() => {
    if (!window.localbot) return;
    const off = window.localbot.on('app:init', (p) => {
      const payload = p as AppInitPayload & { messages?: any[] };
      setHasKey(payload.hasKey);
      setInitialMessages(payload.messages ?? []);
    });
    // Close the race window: main's `did-finish-load` handler sends
    // EVENT_APP_INIT on a tick that can fire BEFORE this useEffect registers
    // the listener, dropping the event. After the listener is wired, ask
    // main to re-send the payload. setState is idempotent so a duplicate
    // delivery from the original send (if it landed) is harmless.
    window.localbot.requestAppInit();
    return off;
  }, []);

  if (hasKey === null) {
    return <div className="boot">Loading…</div>;
  }

  if (!hasKey) {
    return <KeyModal onSaved={() => setHasKey(true)} />;
  }

  return <Chat initialMessages={initialMessages ?? []} />;
}
