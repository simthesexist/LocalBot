// Stack of pending shell approval modals. Only the head of the queue is
// rendered as a modal — once the user decides on the top one, the next one
// surfaces. Closing/dismissing without a decision removes the top entry
// without sending a respond() to the daemon (the daemon's approval_timeout
// fires after 5min in that case).

import * as React from 'react';
import { ApprovalModal } from './ApprovalModal';
import { useShellApprovals } from '../state/shells';

export function ApprovalModalStack(): React.JSX.Element | null {
  const { pending, respond } = useShellApprovals();
  if (pending.length === 0) return null;
  const head = pending[0];
  return (
    <ApprovalModal
      shellId={head.shellId}
      command={head.command}
      bot={head.bot}
      onDecide={(d) => {
        void respond(head.shellId, d);
      }}
    />
  );
}
