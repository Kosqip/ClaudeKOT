import { randomUUID } from 'node:crypto';

import { orchestratorRunsDb, sessionsDb } from '@/modules/database/index.js';
import { getProviderLimitedUntil } from '@/modules/handoff/index.js';
import {
  buildCoordinatorTakeoverNote,
  buildPlanRequestPrompt,
  buildPlanRetryPrompt,
  buildReviewPrompt,
  buildSubtaskPrompt,
  buildSubtaskTurnOptions,
  groupSubtasksIntoSteps,
  isTextOnlyProvider,
  listRoleCandidates,
  parseOrchestratorPlan,
  parseOrchestratorReview,
} from '@/modules/orchestrator/services/orchestrator-plan.service.js';
import type { OrchestratorReview, SubtaskReport } from '@/modules/orchestrator/services/orchestrator-plan.service.js';
import { sessionsService } from '@/modules/providers/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
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
/** How many backends one step may be passed along before it is given up on — a guard against two backends bouncing it forever. */
const MAX_ATTEMPTS_PER_STEP = 6;
/** Longest single sleep while paused; the limit is looked at again after each, so a reset that came early is noticed. */
const MAX_PAUSE_SLICE_MS = 5 * 60 * 1000;

/**
 * What the run needs from the rest of the app, as functions so tests can
 * stand in for real backends: run one turn in a session to its end, read
 * the last thing the assistant said there, stop a turn that is going, and
 * say until when a backend is at its usage limit (null: it is free).
 */
export type OrchestratorRunDependencies = {
  runTurn(input: { sessionId: string; userId: number; content: string; options?: Record<string, unknown> }): Promise<{ started: boolean; error: string | null }>;
  readLastReply(sessionId: string): Promise<string | null>;
  abortTurn(sessionId: string): Promise<void>;
  limitedUntil(provider: LLMProvider): number | null;
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
    // The same two steps the chat's own stop button takes.
    abortTurn: async (sessionId) => {
      const activeRun = chatRunRegistry.getRun(sessionId);
      if (!activeRun || activeRun.status !== 'running') {
        return;
      }
      const aborted = await runtime.abort(activeRun.provider, sessionId);
      chatRunRegistry.completeRunIfCurrent(activeRun, { exitCode: aborted ? 0 : 1, aborted: true });
    },
    limitedUntil: (provider) => getProviderLimitedUntil(provider),
  };
}

/**
 * Everything about a run that has to outlive the process, saved as one JSON
 * value after each change: the public run, who started it, the roles as
 * they were when it began, and the current round's plan with the reports
 * collected so far (same index as the plan; null: not finished yet).
 */
type RunState = {
  run: OrchestratorRun;
  userId: number;
  providerRoles: Partial<Record<LLMProvider, ProviderRole>>;
  preferredOrder: LLMProvider[];
  projectPath: string;
  /** Roles the plan was told are held by a text-only backend; null until the plan is asked for. */
  textOnlyRoles: Array<'hands' | 'routine'> | null;
  plan: OrchestratorSubtask[] | null;
  reports: Array<SubtaskReport | null>;
  /** The session each backend coordinates this run in, once it has had to. */
  coordinatorSessions: Partial<Record<LLMProvider, string>>;
};

/** What exists only while the process lives: the stop flag, the turns going now, and how to end a pause early. */
type RunControl = {
  cancelled: boolean;
  executing: boolean;
  activeTurns: Set<string>;
  wake: Array<(forced: boolean) => void>;
};

/** Thrown inside a run to unwind it once the user has stopped it. */
class RunStopped extends Error {}

/** Runs by id, oldest first. Mirrored to the database, so a restart keeps them. */
const runs = new Map<string, RunState>();
const controls = new Map<string, RunControl>();
let restoredFromDatabase = false;

function isActive(run: OrchestratorRun): boolean {
  return run.phase === 'planning' || run.phase === 'running' || run.phase === 'reviewing' || run.phase === 'paused';
}

function controlOf(runId: string): RunControl {
  let control = controls.get(runId);
  if (!control) {
    control = { cancelled: false, executing: false, activeTurns: new Set(), wake: [] };
    controls.set(runId, control);
  }
  return control;
}

function save(state: RunState): void {
  try {
    orchestratorRunsDb.save(state.run.id, state.run.orchestratorSessionId, state);
  } catch (error) {
    // The run itself goes on; it just would not survive a restart.
    console.warn('[Orchestrator] Could not save the task state:', error instanceof Error ? error.message : error);
  }
}

/**
 * Loads the saved runs once. A run that was mid-work when the process ended
 * has lost its turns with it, so it becomes a paused one: nothing done is
 * lost, and it goes on when asked (`resumeOrchestratorRun`) — or by itself,
 * if it was only waiting for a limit (`restoreOrchestratorRuns`).
 */
function ensureRestored(): void {
  if (restoredFromDatabase) {
    return;
  }
  restoredFromDatabase = true;
  let stored: unknown[] = [];
  try {
    stored = orchestratorRunsDb.listStates();
  } catch {
    return;
  }
  for (const value of stored) {
    const state = value as RunState;
    if (!state?.run?.id || !Array.isArray(state.run.subtasks) || runs.has(state.run.id)) {
      continue;
    }
    if (isActive(state.run) && !(state.run.phase === 'paused' && state.run.pauseReason === 'limit')) {
      state.run.phase = 'paused';
      state.run.pauseReason = 'restart';
      delete state.run.resumeAt;
      delete state.run.waitingFor;
    }
    for (const subtask of state.run.subtasks) {
      if (subtask.status === 'running') {
        subtask.status = 'pending';
      }
    }
    runs.set(state.run.id, state);
  }
}

function snapshot(run: OrchestratorRun): OrchestratorRun {
  return { ...run, subtasks: run.subtasks.map((subtask) => ({ ...subtask })) };
}

/** One run as it stands now, or null for an unknown id. Used by `orchestrator.routes.ts`. */
export function getOrchestratorRun(runId: string): OrchestratorRun | null {
  ensureRestored();
  const state = runs.get(runId);
  return state ? snapshot(state.run) : null;
}

/** The most recent run started from a session, so its panel can show it again after a reload. Used by `orchestrator.routes.ts`. */
export function findLatestOrchestratorRun(orchestratorSessionId: string): OrchestratorRun | null {
  ensureRestored();
  let latest: OrchestratorRun | null = null;
  for (const state of runs.values()) {
    if (state.run.orchestratorSessionId === orchestratorSessionId) {
      latest = state.run;
    }
  }
  return latest ? snapshot(latest) : null;
}

/** The newest runs, newest first, for the diagnostics report. */
export function listRecentOrchestratorRuns(limit: number): OrchestratorRun[] {
  ensureRestored();
  return [...runs.values()].slice(-limit).reverse().map((state) => snapshot(state.run));
}

/**
 * True for a session a run that is still going works in: its subtasks'
 * sessions and the sessions it is coordinated from. `server/index.ts` asks
 * before moving a session that hit a usage limit — these the run reassigns
 * itself, along the role's chain, and a second, generic move would put two
 * backends on the same work.
 */
export function isOrchestratorManagedSession(sessionId: string): boolean {
  for (const state of runs.values()) {
    if (!isActive(state.run)) {
      continue;
    }
    if (
      state.run.orchestratorSessionId === sessionId
      || Object.values(state.coordinatorSessions).includes(sessionId)
      || state.run.subtasks.some((subtask) => subtask.sessionId === sessionId)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Stops a run for good: nothing further is started, and every turn it has
 * going right now — subtasks and the orchestrator's own — is stopped the
 * way the chat's stop button would. A paused run is ended as well. Used by
 * `orchestrator.routes.ts`.
 */
export async function cancelOrchestratorRun(runId: string, dependencies: OrchestratorRunDependencies): Promise<OrchestratorRun | null> {
  ensureRestored();
  const state = runs.get(runId);
  if (!state) {
    return null;
  }
  if (isActive(state.run)) {
    const control = controlOf(runId);
    control.cancelled = true;
    if (control.executing) {
      for (const wake of control.wake.splice(0)) {
        wake(false);
      }
      await Promise.all([...control.activeTurns].map((sessionId) => dependencies.abortTurn(sessionId).catch(() => undefined)));
    } else {
      // Paused after a restart: no loop is alive to notice the flag.
      finishStopped(state);
    }
  }
  return snapshot(state.run);
}

/** Forgets every run, saved ones included. Used only by this module's tests. */
export function resetOrchestratorRuns(): void {
  runs.clear();
  controls.clear();
  restoredFromDatabase = true;
  try {
    orchestratorRunsDb.clear();
  } catch {
    // No database in this test: nothing was saved either.
  }
}

/** Drops what is in memory so the next read loads from the database again — a restart, as far as this module can tell. Used only by tests. */
export function forgetOrchestratorRunsInMemory(): void {
  runs.clear();
  controls.clear();
  restoredFromDatabase = false;
}

function finishStopped(state: RunState): void {
  for (const subtask of state.run.subtasks) {
    if (subtask.status === 'pending' || subtask.status === 'running') {
      subtask.status = 'skipped';
      subtask.error = 'Stopped.';
    }
  }
  state.run.phase = 'cancelled';
  delete state.run.pauseReason;
  delete state.run.resumeAt;
  delete state.run.waitingFor;
  save(state);
}

function throwIfStopped(state: RunState): void {
  if (controlOf(state.run.id).cancelled) {
    throw new RunStopped();
  }
}

/**
 * Waits for one of `candidates` to be free and returns it — at once when
 * one already is. Otherwise the run is shown as paused until the earliest
 * limit resets, and the choice is made again then, so whichever backend
 * comes back first (in chain order) gets the work. "Continue now" ends the
 * wait early and takes the first candidate as it is: the limit may have
 * been lifted without the app hearing of it.
 */
async function acquireProvider(
  state: RunState,
  candidates: LLMProvider[],
  phase: 'planning' | 'running' | 'reviewing',
  dependencies: OrchestratorRunDependencies,
): Promise<LLMProvider | null> {
  if (candidates.length === 0) {
    return null;
  }
  const control = controlOf(state.run.id);
  for (;;) {
    throwIfStopped(state);
    const free = candidates.find((provider) => dependencies.limitedUntil(provider) === null);
    if (free) {
      return free;
    }

    const waits = candidates.map((provider) => ({ provider, until: dependencies.limitedUntil(provider) ?? 0 }));
    const next = waits.reduce((earliest, entry) => (entry.until < earliest.until ? entry : earliest));
    state.run.phase = 'paused';
    state.run.pauseReason = 'limit';
    state.run.waitingFor = next.provider;
    state.run.resumeAt = new Date(next.until).toISOString();
    save(state);

    const forced = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), Math.max(1000, Math.min(next.until - Date.now(), MAX_PAUSE_SLICE_MS)));
      const finish = (byUser: boolean) => {
        clearTimeout(timer);
        control.wake = control.wake.filter((entry) => entry !== finish);
        resolve(byUser);
      };
      control.wake.push(finish);
    });
    throwIfStopped(state);
    if (forced || candidates.some((provider) => dependencies.limitedUntil(provider) === null)) {
      state.run.phase = phase;
      delete state.run.pauseReason;
      delete state.run.waitingFor;
      delete state.run.resumeAt;
      save(state);
      if (forced) {
        return candidates[0];
      }
    }
  }
}

/** Runs one turn, registered so "stop" can reach it. */
async function runTrackedTurn(
  state: RunState,
  input: { sessionId: string; content: string; options?: Record<string, unknown> },
  dependencies: OrchestratorRunDependencies,
): Promise<{ started: boolean; error: string | null }> {
  const control = controlOf(state.run.id);
  control.activeTurns.add(input.sessionId);
  try {
    return await dependencies.runTurn({ ...input, userId: state.userId });
  } finally {
    control.activeTurns.delete(input.sessionId);
  }
}

/** A text-only backend may get work only when it holds the role itself or the plan was written knowing about it. */
function coordinatorCandidates(state: RunState): LLMProvider[] {
  const origin = sessionsDb.getSessionById(state.run.orchestratorSessionId)?.provider as LLMProvider | undefined;
  const chain = listRoleCandidates('orchestrator', state.providerRoles, state.preferredOrder)
    .filter((provider) => state.providerRoles[provider] === 'orchestrator' || !isTextOnlyProvider(provider));
  // The session the task was started from keeps the lead for as long as its backend can work.
  return origin ? [origin, ...chain.filter((provider) => provider !== origin)] : chain;
}

function subtaskCandidates(state: RunState, subtask: OrchestratorSubtask): LLMProvider[] {
  return listRoleCandidates(subtask.role, state.providerRoles, state.preferredOrder)
    .filter((provider) => !isTextOnlyProvider(provider) || (state.textOnlyRoles ?? []).includes(subtask.role));
}

/**
 * Sends the coordinating backend one request, waits for its turn to end and
 * parses the reply. A reply that does not parse gets one more chance with
 * the problem spelled out — models drop the required format often enough
 * that failing the whole run on the first miss would be wasteful.
 *
 * The request goes to the first backend of the orchestrator chain that is
 * free: the session the task was started from, or — once that backend is at
 * its limit — a session of the next one, which is told it is taking over.
 * The requests carry the task and the reports themselves, so the newcomer
 * needs nothing from the earlier conversation. A backend that runs out
 * during the request is passed over the same way; with nobody free the run
 * pauses until a limit resets.
 */
async function askCoordinator<T>(
  state: RunState,
  prompt: string,
  parse: (reply: string) => T,
  shape: 'plan' | 'review',
  dependencies: OrchestratorRunDependencies,
): Promise<T> {
  const phase = shape === 'plan' ? 'planning' : 'reviewing';
  const candidates = coordinatorCandidates(state);

  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_STEP; attempt += 1) {
    const provider = await acquireProvider(state, candidates, phase, dependencies);
    if (!provider) {
      break;
    }
    let sessionId = provider === sessionsDb.getSessionById(state.run.orchestratorSessionId)?.provider
      ? state.run.orchestratorSessionId
      : state.coordinatorSessions[provider];
    const takingOver = !sessionId;
    if (!sessionId) {
      sessionId = randomUUID();
      sessionsDb.createAppSession(sessionId, provider, state.projectPath, `Coordinating: ${state.run.task.slice(0, 60)}`);
      state.coordinatorSessions[provider] = sessionId;
    }
    state.run.coordinatorProvider = provider;
    state.run.coordinatorSessionId = sessionId;
    save(state);

    const ask = async (content: string): Promise<string | null> => {
      const before = await dependencies.readLastReply(sessionId).catch(() => null);
      const turn = await runTrackedTurn(state, { sessionId, content }, dependencies);
      throwIfStopped(state);
      const reply = turn.started ? await dependencies.readLastReply(sessionId) : null;
      // A failed turn leaves the previous reply as the last one; that is not an answer to this request.
      const answered = Boolean(reply) && !(turn.error && reply === before);
      if (answered) {
        return reply;
      }
      if (dependencies.limitedUntil(provider) !== null) {
        return null;
      }
      throw new AppError(turn.error ?? 'The orchestrator session ended its turn without a reply — its chat shows the reason.', {
        code: turn.started ? 'ORCHESTRATOR_PLAN_PARSE_FAILED' : 'ORCHESTRATOR_PLAN_DISPATCH_FAILED',
        statusCode: 502,
      });
    };

    const firstReply = await ask((takingOver ? buildCoordinatorTakeoverNote() : '') + prompt);
    if (firstReply === null) {
      continue;
    }
    try {
      return parse(firstReply);
    } catch (error) {
      const problem = error instanceof Error ? error.message.split('\n')[0] : 'it was not in the required format.';
      const secondReply = await ask(buildPlanRetryPrompt(problem, shape));
      if (secondReply === null) {
        continue;
      }
      return parse(secondReply);
    }
  }
  throw new AppError('No backend could take the orchestrator role: each one ran out of usage or none is assigned.', {
    code: 'ORCHESTRATOR_PLAN_DISPATCH_FAILED',
    statusCode: 502,
  });
}

/**
 * Runs one subtask to the end in a new session of the first free backend of
 * its role's chain, and reports how it went. A backend that hits its usage
 * limit mid-subtask is passed over: the next one in the chain gets the same
 * subtask in a session of its own, told that the work was begun and to
 * check the folder before redoing anything. With nobody free the run
 * pauses until a limit resets, then goes on from here.
 */
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

  const candidates = subtaskCandidates(state, subtask);
  if (candidates.length === 0) {
    return fail('skipped', listRoleCandidates(subtask.role, state.providerRoles).length === 0
      ? `No backend has the "${subtask.role}" role assigned.`
      : 'The only backend left for this role is a text model, and this subtask needs the project folder.');
  }

  // A subtask that already has a session was begun before (a restart cut it off).
  let takenOver = Boolean(entry.sessionId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_STEP; attempt += 1) {
    const provider = await acquireProvider(state, candidates, 'running', dependencies);
    if (!provider) {
      break;
    }
    try {
      const sessionId = randomUUID();
      sessionsDb.createAppSession(sessionId, provider, state.projectPath, subtask.title);
      entry.provider = provider;
      entry.sessionId = sessionId;
      entry.status = 'running';
      delete entry.error;
      save(state);

      const turn = await runTrackedTurn(state, {
        sessionId,
        content: buildSubtaskPrompt(subtask, earlier, isTextOnlyProvider(provider), takenOver),
        options: buildSubtaskTurnOptions(provider, subtask.access),
      }, dependencies);
      const reply = turn.started ? await dependencies.readLastReply(sessionId) : null;
      // Work that finished is kept even when "stop" arrived during it.
      if (reply && !turn.error) {
        entry.status = 'done';
        return { title: subtask.title, status: 'done', result: reply };
      }
      throwIfStopped(state);
      if (dependencies.limitedUntil(provider) !== null) {
        entry.movedFrom = [...(entry.movedFrom ?? []), provider];
        entry.status = 'pending';
        takenOver = true;
        save(state);
        continue;
      }
      if (reply) {
        entry.status = 'done';
        return { title: subtask.title, status: 'done', result: reply };
      }
      return fail('failed', turn.error ?? (turn.started
        ? 'The backend finished without a reply — open its session for the reason.'
        : 'The subtask could not be started.'));
    } catch (error) {
      if (error instanceof RunStopped) {
        throw error;
      }
      return fail('failed', error instanceof Error ? error.message : String(error));
    }
  }
  return fail('failed', 'Every backend that could take this subtask ran out of usage.');
}

function beginRound(state: RunState, round: number, plan: OrchestratorSubtask[]): void {
  state.plan = plan;
  state.reports = plan.map(() => null);
  state.run.round = round;
  state.run.subtasks.push(...plan.map((subtask): OrchestratorSubtaskResult => ({
    title: subtask.title,
    role: subtask.role,
    access: subtask.access,
    round,
    status: 'pending',
  })));
}

/**
 * The whole life of one run after its request has been accepted; never
 * throws — a failure ends up on the run itself. Written to be entered
 * again: it goes on from whatever the saved state says is still open (no
 * plan yet, subtasks without a report, a round waiting for its review), so
 * the same function resumes a run after a restart or a failure.
 */
async function executeRun(state: RunState, dependencies: OrchestratorRunDependencies): Promise<void> {
  const { run } = state;
  const control = controlOf(run.id);
  control.executing = true;
  try {
    if (!state.plan) {
      run.phase = 'planning';
      state.textOnlyRoles = (['hands', 'routine'] as const).filter((role) => {
        const candidates = listRoleCandidates(role, state.providerRoles, state.preferredOrder);
        return isTextOnlyProvider(candidates.find((provider) => dependencies.limitedUntil(provider) === null) ?? candidates[0] ?? null);
      });
      save(state);
      const plan = await askCoordinator(state, buildPlanRequestPrompt(run.task, state.textOnlyRoles), parseOrchestratorPlan, 'plan', dependencies);
      beginRound(state, 1, plan);
    }

    for (;;) {
      const plan = state.plan ?? [];
      const entries = run.subtasks.filter((subtask) => subtask.round === run.round);
      run.phase = 'running';
      save(state);

      const steps = groupSubtasksIntoSteps(plan.map((subtask, index) => ({ ...subtask, index })));
      for (const step of steps) {
        throwIfStopped(state);
        const earlier = state.reports.slice(0, step[0].index).filter((report): report is SubtaskReport => report !== null);
        await Promise.all(step.filter(({ index }) => state.reports[index] === null).map(async ({ index, ...subtask }) => {
          state.reports[index] = await runSubtask(state, entries[index], subtask, earlier, dependencies);
          save(state);
        }));
      }
      throwIfStopped(state);

      const reports = state.reports.filter((report): report is SubtaskReport => report !== null);
      run.phase = 'reviewing';
      save(state);
      let review: OrchestratorReview;
      try {
        review = await askCoordinator(
          state,
          buildReviewPrompt(run.task, reports, run.round < run.maxRounds, state.textOnlyRoles ?? []),
          parseOrchestratorReview,
          'review',
          dependencies,
        );
      } catch (error) {
        if (error instanceof RunStopped) {
          throw error;
        }
        // The work is done either way; an unreadable verdict must not turn it into a failed run.
        const lastWord = run.coordinatorSessionId
          ? await dependencies.readLastReply(run.coordinatorSessionId).catch(() => null)
          : null;
        review = { status: 'done', summary: lastWord ?? '' };
      }

      if (review.status === 'done' || run.round === run.maxRounds) {
        run.summary = review.status === 'done' ? review.summary : '';
        run.phase = 'done';
        save(state);
        return;
      }
      beginRound(state, run.round + 1, review.subtasks);
    }
  } catch (error) {
    if (error instanceof RunStopped || control.cancelled) {
      finishStopped(state);
      return;
    }
    run.error = error instanceof Error ? error.message : String(error);
    run.phase = 'failed';
    save(state);
  } finally {
    control.executing = false;
  }
}

/**
 * Sets a paused or failed run going again from where it stands. A run
 * waiting for a usage limit stops waiting and tries its first-choice
 * backend now; one interrupted by a restart, or one that failed, re-enters
 * `executeRun`, which redoes only what has no result yet. Returns null for
 * an unknown run; a finished or stopped one is returned unchanged. Used by
 * `orchestrator.routes.ts`.
 */
export function resumeOrchestratorRun(
  runId: string,
  dependencies: OrchestratorRunDependencies,
): { run: OrchestratorRun; finished: Promise<void> } | null {
  ensureRestored();
  const state = runs.get(runId);
  if (!state) {
    return null;
  }
  const control = controlOf(runId);
  let finished: Promise<void> = Promise.resolve();
  if (control.executing) {
    for (const wake of control.wake.splice(0)) {
      wake(true);
    }
  } else if (state.run.phase === 'paused' || state.run.phase === 'failed') {
    control.cancelled = false;
    delete state.run.error;
    delete state.run.pauseReason;
    delete state.run.resumeAt;
    delete state.run.waitingFor;
    state.run.phase = state.plan ? 'running' : 'planning';
    finished = executeRun(state, dependencies);
  }
  return { run: snapshot(state.run), finished };
}

/**
 * Called once when the server starts: runs that were only waiting for a
 * usage limit when the process ended go back to waiting, and continue by
 * themselves when it resets. Runs cut off mid-work stay paused until the
 * user continues them — restarting agents unasked on boot would surprise.
 * Used by `server/index.ts`.
 */
export function restoreOrchestratorRuns(dependencies: OrchestratorRunDependencies): void {
  ensureRestored();
  for (const state of runs.values()) {
    if (state.run.phase === 'paused' && state.run.pauseReason === 'limit' && !controlOf(state.run.id).executing) {
      void executeRun(state, dependencies);
    }
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
 * round — up to `maxRounds` rounds. Who does what follows the role chains
 * (`listRoleCandidates`): a backend at its usage limit is passed over, mid-
 * subtask included, and when nobody is free the run pauses until a limit
 * resets instead of failing. The state is saved after every step, so a
 * restart loses no finished work.
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
    /** The user's own backend order; decides between backends holding the same role. */
    preferredOrder?: LLMProvider[];
    maxRounds?: number;
  },
  dependencies: OrchestratorRunDependencies,
): { run: OrchestratorRun; finished: Promise<void> } {
  ensureRestored();
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
      coordinatorProvider: orchestratorProvider,
      coordinatorSessionId: input.orchestratorSessionId,
    },
    userId: input.userId,
    providerRoles: input.providerRoles,
    preferredOrder: input.preferredOrder ?? [],
    projectPath: orchestratorSession.project_path ?? '',
    textOnlyRoles: null,
    plan: null,
    reports: [],
    coordinatorSessions: {},
  };
  runs.set(state.run.id, state);
  save(state);
  while (runs.size > MAX_REMEMBERED_RUNS) {
    const oldest = [...runs.values()].find((candidate) => !isActive(candidate.run));
    if (!oldest) {
      break;
    }
    runs.delete(oldest.run.id);
    controls.delete(oldest.run.id);
  }

  return { run: snapshot(state.run), finished: executeRun(state, dependencies) };
}
