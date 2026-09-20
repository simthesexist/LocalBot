// Phase 9 Plan 2: phone UI entry point.
//
// Plain React 19 createRoot mount. No `window.localbot` access — the
// phone bundle is a pure browser SPA that talks to main exclusively via
// the WebSocket API. Exponential-backoff reconnect lives in Chat.tsx.

import { createRoot } from 'react-dom/client';
import { Chat } from './components/Chat';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('phone: missing #root container in index.html');
}
const root = createRoot(container);
root.render(<Chat />);