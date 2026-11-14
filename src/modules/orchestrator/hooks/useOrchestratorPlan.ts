import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { LLMProvider, ProviderFatalFailureCause } from '@/shared/types';

/** One subtask of an orchestrated task as the server reports it (mirrors the server's `OrchestratorSubtaskResult`). */
export type OrchestratorSubtaskResult = {
  title: string;
  /** `orchestrator` only for a pair run's reviewer turn. */
  role: 'orchestrator' | 'hands' | 'routine';
  access: 'read' | 'write';
  round: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  provider?: LLMProvider;
  sessionId?: string;
  error?: string;
  /** Set when the subtask failed fast: its backend cannot work at all, so it was not passed along the role chain. */
  failureCause?: ProviderFatalFailureCause;
  /** Backends that began the subtask and ran out of usage before `provider` took it over. */
  movedFrom?: LLMProvider[];
  /** Set only in a pair run: the writer's or the reviewer's turn. */
  pairPart?: 'writer' | 'reviewer';
};

/** How a run works: `plan` splits the task into subtasks, `pair` runs a writer and a read-only reviewer in turns. */
export type OrchestratorRunMode = 'plan' | 'pair';

/** One reviewer finding of a pair run (mirrors the server's `OrchestratorReviewFinding`). */
type OrchestratorReviewFinding = { severity: 'P0' | 'P1' | 'P2'; text: string };

/** One round of a pair run (mirrors the server's `OrchestratorPairRound`); unset fields mean that turn has not finished yet. */
type OrchestratorPairRound = {
  round: number;
  writerDone?: boolean;
  verdict?: 'approved' | 'changes';
  findings: OrchestratorReviewFinding[];
  userContinued?: boolean;
};

/** One orchestrated task from start to finish (mirrors the server's `OrchestratorRun`). */
export type OrchestratorRun = {
  id: string;
  orchestratorSessionId: string;
  task: string;
  phase: 'planning' | 'running' | 'reviewing' | 'paused' | 'done' | 'failed' | 'cancelled';
  round: number;
  maxRounds: number;
  subtasks: OrchestratorSubtaskResult[];
  /** The backend and session that plan and review now; they change when the orchestrator's backend runs out of usage. */
  coordinatorProvider?: LLMProvider;
  coordinatorSessionId?: string;
  /** `decision`: a pair run stuck on the same P0/P1 finding two rounds in a row, waiting for the user. */
  pauseReason?: 'limit' | 'restart' | 'decision';
  /** Unset means `plan`. */
  mode?: OrchestratorRunMode;
  pairRounds?: OrchestratorPairRound[];
  /** How a finished pair run ended: approved, or out of rounds with findings open. */
  pairOutcome?: 'approved' | 'rounds';
  waitingFor?: LLMProvider;
  resumeAt?: string;
  summary?: string;
  error?: string;
};

const POLL_INTERVAL_MS = 2000;

/** True while the run is not over: working, or paused and able to go on. */
export function isOrchestratorRunActive(run: OrchestratorRun | null): boolean {
  return run?.phase === 'planning' || run?.phase === 'running' || run?.phase === 'reviewing' || run?.phase === 'paused';
}

async function readRun(response: Response): Promise<OrchestratorRun | null> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message ?? 'The orchestrator request failed.');
  }
  return (body?.data?.run ?? null) as OrchestratorRun | null;
}

/**
 * Starts orchestrated tasks from one session and follows the current one for
 * `OrchestratorPlanPanel`: the server works on a run on its own, so this
 * asks for its state every couple of seconds while it is active, and picks
 * the session's latest run back up when the panel mounts (after a reload,
 * or on returning to the session).
 */
export function useOrchestratorPlan(sessionId: string) {
  const [run, setRun] = useState<OrchestratorRun | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a slow answer for a previous session landing in this one.
  const sessionRef = useRef(sessionId);

  useEffect(() => {
    sessionRef.current = sessionId;
    let cancelled = false;
    void api.orchestrator.latestRun(sessionId).then(readRun).then(
      (latest) => {
        if (!cancelled) {
          setRun(latest);
          setError(null);
        }
      },
      () => {
        if (!cancelled) {
          setRun(null);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const runId = run?.id;
  const active = isOrchestratorRunActive(run);
  useEffect(() => {
    if (!runId || !active) {
      return undefined;
    }
    const timer = setInterval(() => {
      void api.orchestrator.run(runId).then(readRun).then(
        (next) => {
          if (next && sessionRef.current === next.orchestratorSessionId) {
            setRun(next);
          }
        },
        // A missed poll is retried by the next one; a server that forgot the run (restart) ends it here.
        (caught: unknown) => {
          if (caught instanceof Error && /no longer known/.test(caught.message)) {
            setRun((current) => (current?.id === runId ? { ...current, phase: 'failed', error: caught.message } : current));
          }
        },
      );
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [runId, active]);

  const start = useCallback(async (task: string, maxRounds: number, mode: OrchestratorRunMode = 'plan'): Promise<void> => {
    setIsStarting(true);
    setError(null);
    try {
      setRun(await readRun(await api.orchestrator.plan({ sessionId, task, maxRounds, mode })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The orchestrator request failed.');
    } finally {
      setIsStarting(false);
    }
  }, [sessionId]);

  const cancel = useCallback(async (): Promise<void> => {
    if (!runId) {
      return;
    }
    try {
      setRun(await readRun(await api.orchestrator.cancel(runId)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The orchestrator request failed.');
    }
  }, [runId]);

  const resume = useCallback(async (): Promise<void> => {
    if (!runId) {
      return;
    }
    try {
      setError(null);
      setRun(await readRun(await api.orchestrator.resume(runId)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The orchestrator request failed.');
    }
  }, [runId]);

  return { run, isStarting, error, start, cancel, resume };
}
