import { randomUUID } from 'node:crypto';

import { sessionsDb } from '@/modules/database/index.js';
import { isProviderLimited } from '@/modules/handoff/index.js';
import {
  buildPlanRequestPrompt,
  buildPlanRetryPrompt,
  buildReviewPrompt,
  buildSubtaskPrompt,
  buildSubtaskTurnOptions,
  groupSubtasksIntoSteps,
  parseOrchestratorPlan,
  parseOrchestratorReview,
  resolveSubtaskProvider,
} from '@/modules/orchestrator/services/orchestrator-plan.service.js';
import type { OrchestratorReview, SubtaskReport } from '@/modules/orchestrator/services/orchestrator-plan.service.js';
import { sessionsService } from '@/modules/providers/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { runDetachedChatTurn } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';
import type {
  LLMProvider,
  OrchestratorRun,
  OrchestratorSubtask,
  OrchestratorSubtaskResult,
  ProviderRole,
} from '@/shared/types.js';

/** Rounds a run gets when the caller names none: the plan, then one round of follow-ups. */
export const DEFAULT_ORCHESTRATOR_MAX_ROUNDS = 2;
/** Upper bound on rounds a caller may ask for — each one spends every involved backend's quota. */
export const ORCHESTRATOR_MAX_ROUNDS_LIMIT = 4;
/** Finished runs kept in memory for the UI to read back. */
const MAX_REMEMBERED_RUNS = 50;

/**
 * What the run needs from the rest of the app, as functions so tests can
 * stand in for real backends: run one turn in a session to its end, and
 * read the last thing the assistant said there.
 */
export type OrchestratorRunDependencies = {
  runTurn(input: { sessionId: string; userId: number; content: string; options?: Record<string, unknown> }): Promise<{ started: boolean; error: string | null }>;
  readLastReply(sessionId: string): Promise<string | null>;
  isProviderAvailable(provider: LLMProvider): boolean;
};

/** The real dependencies: turns go through the chat pipeline, replies are read from session history. */
export function createOrchestratorRunDependencies(runtime: ProviderRuntimeGateway): OrchestratorRunDependencies {
  return {
    runTurn: (input) => runDetachedChatTurn(input, { runtime }),
    readLastReply: async (sessionId) => {
      const history = await sessionsService.fetchHistory(sessionId, { limit: null, offset: 0 });
      for (let index = history.messages.length - 1; index >= 0; index -= 1) {
        const message = history.messages[index];
        if (message.role === 'assistant' && message.content?.trim()) {
          return message.content;
        }
      }
      return null;
    },
    isProviderAvailable: (provider) => !isProviderLimited(provider),
  };
}

type RunState = {
  run: OrchestratorRun;
  userId: number;
  providerRoles: Partial<Record<LLMProvider, ProviderRole>>;
  projectPath: string;
  cancelled: boolean;
};

/** Runs by id, oldest first. In memory: a restart ends every run anyway, since its turns die with the process. */
const runs = new Map<string, RunState>();

function isActive(run: OrchestratorRun): boolean {
  return run.phase === 'planning' || run.phase === 'running' || run.phase === 'reviewing';
}

function snapshot(run: OrchestratorRun): OrchestratorRun {
  return { ...run, subtasks: run.subtasks.map((subtask) => ({ ...subtask })) };
}

/** One run as it stands now, or null for an unknown id. Used by `orchestrator.routes.ts`. */
export function getOrchestratorRun(runId: string): OrchestratorRun | null {
  const state = runs.get(runId);
  return state ? snapshot(state.run) : null;
}

/** The most recent run started from a session, so its panel can show it again after a reload. Used by `orchestrator.routes.ts`. */
export function findLatestOrchestratorRun(orchestratorSessionId: string): OrchestratorRun | null {
  let latest: OrchestratorRun | null = null;
  for (const state of runs.values()) {
    if (state.run.orchestratorSessionId === orchestratorSessionId) {
      latest = state.run;
    }
  }
  return latest ? snapshot(latest) : null;
}

/**
 * Stops a run from starting anything further: subtasks not yet begun are
 * skipped and no review is asked for. A subtask already running is left to
 * finish in its own session, where the user can stop it like any other turn.
 * Used by `orchestrator.routes.ts`.
 */
export function cancelOrchestratorRun(runId: string): OrchestratorRun | null {
  const state = runs.get(runId);
  if (!state) {
    return null;
  }
  if (isActive(state.run)) {
    state.cancelled = true;
  }
  return snapshot(state.run);
}

/** Forgets every run. Used only by this module's tests. */
export function resetOrchestratorRuns(): void {
  runs.clear();
}

/**
 * Sends the orchestrator one message, waits for its turn to end and parses
 * the reply. A reply that does not parse gets one more chance with the
 * problem spelled out — models drop the required format often enough that
 * failing the whole run on the first miss would be wasteful.
 */
async function askOrchestrator<T>(
  state: RunState,
  prompt: string,
  parse: (reply: string) => T,
  shape: 'plan' | 'review',
  dependencies: OrchestratorRunDependencies,
): Promise<T> {
  const ask = async (content: string): Promise<string> => {
    const turn = await dependencies.runTurn({ sessionId: state.run.orchestratorSessionId, userId: state.userId, content });
    if (!turn.started) {
      throw new AppError(turn.error ?? 'The orchestrator session could not take the request.', {
        code: 'ORCHESTRATOR_PLAN_DISPATCH_FAILED',
        statusCode: 502,
      });
    }
    const reply = await dependencies.readLastReply(state.run.orchestratorSessionId);
    if (!reply) {
      throw new AppError(turn.error ?? 'The orchestrator session ended its turn without a reply — its chat shows the reason.', {
        code: 'ORCHESTRATOR_PLAN_PARSE_FAILED',
        statusCode: 502,
      });
    }
    return reply;
  };

  const firstReply = await ask(prompt);
  try {
    return parse(firstReply);
  } catch (error) {
    const problem = error instanceof Error ? error.message.split('\n')[0] : 'it was not in the required format.';
    return parse(await ask(buildPlanRetryPrompt(problem, shape)));
  }
}

/** Runs one subtask in a new session of its role's backend to the end and reports how it went. */
async function runSubtask(
  state: RunState,
  entry: OrchestratorSubtaskResult,
  subtask: OrchestratorSubtask,
  earlier: SubtaskReport[],
  dependencies: OrchestratorRunDependencies,
): Promise<SubtaskReport> {
  const fail = (status: 'failed' | 'skipped', error: string): SubtaskReport => {
    entry.status = status;
    entry.error = error;
    return { title: subtask.title, status, result: error };
  };

  const provider = resolveSubtaskProvider(subtask.role, state.providerRoles, dependencies.isProviderAvailable);
  if (!provider) {
    return fail('skipped', `No backend has the "${subtask.role}" role assigned.`);
  }

  try {
    const sessionId = randomUUID();
    sessionsDb.createAppSession(sessionId, provider, state.projectPath, subtask.title);
    entry.provider = provider;
    entry.sessionId = sessionId;
    entry.status = 'running';

    const turn = await dependencies.runTurn({
      sessionId,
      userId: state.userId,
      content: buildSubtaskPrompt(subtask, earlier),
      options: buildSubtaskTurnOptions(provider, subtask.access),
    });
    if (!turn.started) {
      return fail('failed', turn.error ?? 'The subtask could not be started.');
    }

    const reply = await dependencies.readLastReply(sessionId);
    if (!reply) {
      return fail('failed', turn.error ?? 'The backend finished without a reply — open its session for the reason.');
    }
    entry.status = 'done';
    return { title: subtask.title, status: 'done', result: reply };
  } catch (error) {
    return fail('failed', error instanceof Error ? error.message : String(error));
  }
}

/** The whole life of one run after its request has been accepted; never throws — a failure ends up on the run itself. */
async function executeRun(state: RunState, dependencies: OrchestratorRunDependencies): Promise<void> {
  const { run } = state;
  try {
    let subtasks = await askOrchestrator(state, buildPlanRequestPrompt(run.task), parseOrchestratorPlan, 'plan', dependencies);

    for (let round = 1; round <= run.maxRounds; round += 1) {
      run.round = round;
      run.phase = 'running';
      const entries = subtasks.map((subtask): OrchestratorSubtaskResult => ({
        title: subtask.title,
        role: subtask.role,
        access: subtask.access,
        round,
        status: 'pending',
      }));
      run.subtasks.push(...entries);

      const reports: SubtaskReport[] = [];
      const steps = groupSubtasksIntoSteps(subtasks.map((subtask, index) => ({ ...subtask, entry: entries[index] })));
      for (const step of steps) {
        if (state.cancelled) {
          break;
        }
        const earlier = [...reports];
        reports.push(...await Promise.all(step.map(({ entry, ...subtask }) =>
          runSubtask(state, entry, subtask, earlier, dependencies))));
      }

      if (state.cancelled) {
        for (const entry of entries) {
          if (entry.status === 'pending') {
            entry.status = 'skipped';
          }
        }
        run.phase = 'cancelled';
        return;
      }

      run.phase = 'reviewing';
      let review: OrchestratorReview;
      try {
        review = await askOrchestrator(
          state,
          buildReviewPrompt(run.task, reports, round < run.maxRounds),
          parseOrchestratorReview,
          'review',
          dependencies,
        );
      } catch {
        // The work is done either way; an unreadable verdict must not turn it into a failed run.
        const lastWord = await dependencies.readLastReply(run.orchestratorSessionId).catch(() => null);
        review = { status: 'done', summary: lastWord ?? '' };
      }

      if (review.status === 'done' || round === run.maxRounds) {
        run.summary = review.status === 'done' ? review.summary : '';
        run.phase = 'done';
        return;
      }
      subtasks = review.subtasks;
    }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
    run.phase = 'failed';
  }
}

/**
 * Starts an orchestrated task and returns it at once, still planning.
 *
 * The session's own backend (which must hold the `orchestrator` role) is
 * asked to split `task` into subtasks. Each subtask runs in a new session on
 * the backend holding its role (`hands`/`routine`), with the access the plan
 * gave it: `read` subtasks side by side, `write` ones one at a time, each
 * told what the earlier ones reported. The reports then go back to the
 * orchestrator, which closes the task with a summary or plans a follow-up
 * round — up to `maxRounds` rounds. A subtask whose role no backend holds is
 * skipped rather than given to a substitute.
 *
 * Progress is read back with `getOrchestratorRun`; nothing here waits for
 * the run to finish. A backend never starts subtasks of its own: delegation
 * is always decided by the one orchestrator session, round by round.
 *
 * Consumed by `orchestrator.routes.ts`.
 */
export function startOrchestratorRun(
  input: {
    orchestratorSessionId: string;
    userId: number;
    task: string;
    providerRoles: Partial<Record<LLMProvider, ProviderRole>>;
    maxRounds?: number;
  },
  dependencies: OrchestratorRunDependencies,
): { run: OrchestratorRun; finished: Promise<void> } {
  const orchestratorSession = sessionsDb.getSessionById(input.orchestratorSessionId);
  if (!orchestratorSession) {
    throw new AppError(`Session "${input.orchestratorSessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }

  const orchestratorProvider = orchestratorSession.provider as LLMProvider;
  if (input.providerRoles[orchestratorProvider] !== 'orchestrator') {
    throw new AppError(
      'This session\'s provider has no "orchestrator" role assigned. Assign the orchestrator role to it (or switch to a session whose provider has that role) in settings first.',
      { code: 'NO_ORCHESTRATOR_ROLE', statusCode: 409 },
    );
  }

  for (const existing of runs.values()) {
    if (existing.run.orchestratorSessionId === input.orchestratorSessionId && isActive(existing.run)) {
      throw new AppError('This session is already coordinating a task. Wait for it to finish or cancel it first.', {
        code: 'ORCHESTRATOR_RUN_ACTIVE',
        statusCode: 409,
      });
    }
  }

  const state: RunState = {
    run: {
      id: randomUUID(),
      orchestratorSessionId: input.orchestratorSessionId,
      task: input.task,
      phase: 'planning',
      round: 0,
      maxRounds: Math.min(ORCHESTRATOR_MAX_ROUNDS_LIMIT, Math.max(1, Math.trunc(input.maxRounds ?? DEFAULT_ORCHESTRATOR_MAX_ROUNDS))),
      subtasks: [],
    },
    userId: input.userId,
    providerRoles: input.providerRoles,
    projectPath: orchestratorSession.project_path ?? '',
    cancelled: false,
  };
  runs.set(state.run.id, state);
  while (runs.size > MAX_REMEMBERED_RUNS) {
    const oldest = [...runs.values()].find((candidate) => !isActive(candidate.run));
    if (!oldest) {
      break;
    }
    runs.delete(oldest.run.id);
  }

  return { run: snapshot(state.run), finished: executeRun(state, dependencies) };
}
