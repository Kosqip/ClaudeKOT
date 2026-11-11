import { useCallback, useState } from 'react';

import { api } from '@/shared/api.js';
import type { LLMProvider } from '@/shared/types.js';

/** One target session's outcome from a mix dispatch, as the mix endpoint reports it. */
export type MixDispatchResult = {
  sessionId: string;
  provider: LLMProvider;
  started: boolean;
  error: string | null;
};

/**
 * Sends one message to several already-created provider sessions at once and
 * tracks the in-flight/result state for `MixSendPanel`.
 *
 * Each target keeps streaming its own reply through the chat view already
 * subscribed to its session id — this hook only reports which turns started.
 */
export function useMixDispatch() {
  const [isDispatching, setIsDispatching] = useState(false);
  const [results, setResults] = useState<MixDispatchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dispatch = useCallback(async (targetSessionIds: string[], content: string): Promise<MixDispatchResult[]> => {
    setIsDispatching(true);
    setError(null);
    try {
      const response = await api.mix.dispatch({
        targets: targetSessionIds.map((sessionId) => ({ sessionId })),
        content,
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error?.message ?? 'The mix dispatch failed.');
      }
      const dispatched = (body.data?.results ?? []) as MixDispatchResult[];
      setResults(dispatched);
      return dispatched;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'The mix dispatch failed.';
      setError(message);
      throw caught;
    } finally {
      setIsDispatching(false);
    }
  }, []);

  return { dispatch, isDispatching, results, error };
}
