// Memory pill state hook. Phase 3 tracer slice.
//
// Exposes a coarse "how much memory does this bot have?" view — the pill in
// the header. The full editor is a follow-up; this slice only needs to
// surface byte/fact counts so the user can see when memory is being used.

import { useEffect, useState, useCallback } from 'react';
import type { MemoryReadResult } from '../../shared/types';

export interface MemoryState {
  bot: string;
  bytes: number;
  factCount: number;
  updatedAt: string;
  loading: boolean;
  error: string | null;
}

const INITIAL: MemoryState = {
  bot: 'default',
  bytes: 0,
  factCount: 0,
  updatedAt: '',
  loading: false,
  error: null,
};

export function useMemory(bot: string = 'default'): MemoryState & { refresh: () => Promise<void> } {
  const [state, setState] = useState<MemoryState>({ ...INITIAL, bot });

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = (await window.localbot.memory.read(bot)) as MemoryReadResult;
      setState({
        bot,
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
  }, [refresh]);

  return { ...state, refresh };
}
