import { useCallback, useState } from 'react';

import { api } from '@/shared/api.js';
import type { LLMProvider } from '@/shared/types.js';

/** One subtask's outcome after the orchestrator split the task and dispatched it, as the plan endpoint reports it. */
export type OrchestratorSubtaskResult = {
  title: string;
  role: 'hands' | 'routine';
  provider?: LLMProvider;
  sessionId?: string;
  started: boolean;
  error?: string;
};

/**
 * Asks the given orchestrator session to split one task into subtasks and
 * tracks the in-flight/result state for `OrchestratorPlanPanel`.
 *
 * Each dispatched subtask keeps streaming its own reply through the chat
 * view already subscribed to its new session id — this hook only reports
 * the plan and which subtasks started, mirroring `useMixDispatch`.
 */
export function useOrchestratorPlan() {
  const [isPlanning, setIsPlanning] = useState(false);
  const [subtasks, setSubtasks] = useState<OrchestratorSubtaskResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plan = useCallback(async (sessionId: string, task: string): Promise<OrchestratorSubtaskResult[]> => {
    setIsPlanning(true);
    setError(null);
    try {
      const response = await api.orchestrator.plan({ sessionId, task });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error?.message ?? 'The orchestrator could not split this task.');
      }
      const result = (body.data?.subtasks ?? []) as OrchestratorSubtaskResult[];
      setSubtasks(result);
      return result;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'The orchestrator could not split this task.';
      setError(message);
      throw caught;
    } finally {
      setIsPlanning(false);
    }
  }, []);

  return { plan, isPlanning, subtasks, error };
}
