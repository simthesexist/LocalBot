// Phase 7 Plan 2: render a vault.search MessageBlock inline.
//
// Shows the search query + a match list (path:line + text). Collapses past
// 20 matches so a 100-line result doesn't blow up the chat scrollback.
// Empty matches render an explicit "No matches" line so the user can
// distinguish "search returned nothing" from "search failed silently".

import * as React from 'react';
import { useState } from 'react';
import type { MessageBlock } from '../../shared/types';

export interface VaultSearchBlockProps {
  block: Extract<MessageBlock, { kind: 'vault_search' }>;
}

const COLLAPSE_THRESHOLD_MATCHES = 20;

export function VaultSearchBlock({ block }: VaultSearchBlockProps): React.JSX.Element {
  const { query, matches, truncated } = block;
  const [expanded, setExpanded] = useState(false);

  const shouldCollapse = matches.length > COLLAPSE_THRESHOLD_MATCHES;
  const visible = shouldCollapse && !expanded ? matches.slice(0, COLLAPSE_THRESHOLD_MATCHES) : matches;

  return (
    <div
      className="block-vault-search"
      data-block-kind="vault_search"
      data-vault-query={query}
      data-match-count={matches.length}
    >
      <div className="block-header">
        <span className="block-tool-name">vault.search</span>
        <span className="block-vault-query">{query}</span>
        <span className="block-vault-match-count">
          {matches.length} match{matches.length === 1 ? '' : 'es'}
        </span>
        {truncated && <span className="block-vault-truncated">(truncated)</span>}
      </div>
      {matches.length === 0 ? (
        <div className="block-vault-search-empty" data-testid="vault-search-empty">
          No matches
        </div>
      ) : (
        <div className="block-vault-search-matches">
          {visible.map((m, idx) => (
            <div
              className="block-vault-search-match"
              key={`${m.path}:${m.line}:${idx}`}
              data-match-path={m.path}
              data-match-line={m.line}
            >
              <span className="block-vault-match-location">
                {m.path}:{m.line}
              </span>
              <pre className="block-vault-match-text">{m.text}</pre>
            </div>
          ))}
          {shouldCollapse && (
            <button
              type="button"
              className="collapse-toggle"
              onClick={() => setExpanded((v) => !v)}
              data-testid="collapse-vault-search"
            >
              {expanded
                ? 'Show less'
                : `Show all ${matches.length} matches`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}