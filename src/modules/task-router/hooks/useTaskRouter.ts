import { useCallback, useState } from 'react';

import { api } from '@/shared/api.js';
import type { LLMProvider } from '@/shared/types.js';

/** The four fixed task tags — mirrors the backend's `TaskTag` union by hand. */
export type TaskTag = 'routine' | 'coding' | 'second_opinion' | 'complex';

/** One session a dispatch started, as the task-router endpoint reports it. */
export type TaskRouterSessionResult = {
  provider: LLMProvider;
  sessionId: string;
  started: boolean;
  error?: string;
};

/** The task-router endpoint's full result, as `TaskRouterPanel` renders it. */
export type TaskRouterDispatchResult = {
  tag: TaskTag;
  autoDetected: boolean;
  manualSelectionRequired: boolean;
  sessions: TaskRouterSessionResult[];
};

/**
 * Sends one task to the task-router endpoint — either with an explicit tag
 * or letting the server's keyword config decide — and tracks the in-flight/
 * result state for `TaskRouterPanel`.
 *
 * Dispatched sessions keep streaming their own replies through the chat
 * view already subscribed to their new session ids, mirroring
 * `useMixDispatch`/`useOrchestratorPlan` — this hook only reports the
 * routing outcome.
 */
export function useTaskRouter() {
  const [isDispatching, setIsDispatching] = useState(false);
  const [result, setResult] = useState<TaskRouterDispatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dispatch = useCallback(async (
    projectPath: string,
    content: string,
    explicitTag?: TaskTag,
  ): Promise<TaskRouterDispatchResult> => {
    setIsDispatching(true);
    setError(null);
    try {
      const response = await api.taskRouter.dispatch({ projectPath, content, explicitTag });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error?.message ?? 'The task router could not route this task.');
      }
      const dispatched = body.data as TaskRouterDispatchResult;
      setResult(dispatched);
      return dispatched;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'The task router could not route this task.';
      setError(message);
      throw caught;
    } finally {
      setIsDispatching(false);
    }
  }, []);

  return { dispatch, isDispatching, result, error };
}
