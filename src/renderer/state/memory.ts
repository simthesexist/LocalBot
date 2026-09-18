// Memory state hook. Phase 3 Wave 2.
//
// Subscribes to the main-side `memory:updated` event so other writers (the
// LLM via memory.update) refresh the panel automatically. Exposes the full
// memory payload (markdown + facts) plus the coarse byte/fact counts the
// MemoryPill renders in the header.

import { useCallback, useEffect, useState } from 'react';
import type { Facts, MemoryReadResult } from '../../shared/types';

export interface MemoryState {
  bot: string;
  markdown: string;
  facts: Facts;
  bytes: number;
  factCount: number;
  updatedAt: string;
  loading: boolean;
  error: string | null;
}

const INITIAL: MemoryState = {
  bot: 'default',
  markdown: '',
  facts: {},
  bytes: 0,
  factCount: 0,
  updatedAt: '',
  loading: false,
  error: null,
};

export interface UseMemoryApi extends MemoryState {
  refresh: () => Promise<void>;
}

export function useMemory(bot: string = 'default'): UseMemoryApi {
  const [state, setState] = useState<MemoryState>({ ...INITIAL, bot });

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = (await window.localbot.memory.read(bot)) as MemoryReadResult;
      setState({
        bot,
        markdown: result.markdown ?? '',
        facts: (result.facts ?? {}) as Facts,
        bytes: result.bytes ?? 0,
        factCount: result.factCount ?? 0,
        updatedAt: result.updatedAt ?? '',
        loading: false,
        error: result.parseError ?? null,
      });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: (err as Error).message }));
    }
  }, [bot]);

  useEffect(() => {
    void refresh();
    const off = window.localbot.on('memory:updated', ((_p: unknown) => {
      void refresh();
    }) as (p: unknown) => void);
    return () => off();
  }, [refresh]);

  return { ...state, refresh };
}
