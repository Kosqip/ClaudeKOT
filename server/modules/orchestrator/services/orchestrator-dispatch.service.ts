import { randomUUID } from 'node:crypto';

import { sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import {
  buildPlanRequestPrompt,
  parseOrchestratorPlan,
  resolveSubtaskProvider,
} from '@/modules/orchestrator/services/orchestrator-plan.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { runDetachedChatTurn, startDetachedChatTurn } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';
import type { LLMProvider, OrchestratorSubtaskResult, ProviderRole } from '@/shared/types.js';

/**
 * Finds the orchestrator's own plan response: the last `assistant` message
 * with non-empty content in its transcript, after the plan-request turn has
 * fully completed (`runDetachedChatTurn` resolves only once the run has
 * finished, so the response is already in history by the time this reads
 * it — no polling or streaming hookup needed here).
 */
function findLatestAssistantContent(messages: Array<{ role?: 'user' | 'assistant'; content?: string }>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.content?.trim()) {
      return message.content;
    }
  }
  return null;
}

/**
 * Manually-triggered, single-level task orchestration: asks the given
 * session's own provider (which the caller must already have confirmed
 * holds the `orchestrator` role) to split `task` into subtasks, then opens
 * one brand-new session per subtask on whichever provider the user has
 * assigned that subtask's role (`hands`/`routine`) and starts it with the
 * subtask's description as its first message.
 *
 * The plan turn is awaited — its reply is what gets parsed — but subtasks
 * only have to start: this resolves without waiting for them to finish.
 *
 * Subtasks are dispatched once and never themselves split further — this is
 * intentionally one level of delegation, not a recursive planner. A subtask
 * whose role has no assigned provider is reported as skipped rather than
 * guessing a substitute. Every new session gets the provider's full, normal
 * tool access today; scoping a delegated subtask's tools down (the
 * "delegation belt" idea logged in docs/PROJECT_REQUIREMENTS.md from
 * razzant/claudexor) is a deliberate non-goal of this first version.
 *
 * Consumed by `orchestrator.routes.ts`, the HTTP entry point for a manual
 * "split into subtasks" action.
 */
export async function planAndDispatchOrchestratorTask(
  input: {
    orchestratorSessionId: string;
    userId: number;
    task: string;
    providerRoles: Partial<Record<LLMProvider, ProviderRole>>;
  },
  runtime: ProviderRuntimeGateway,
): Promise<OrchestratorSubtaskResult[]> {
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

  const planDispatch = await runDetachedChatTurn(
    { sessionId: input.orchestratorSessionId, userId: input.userId, content: buildPlanRequestPrompt(input.task) },
    { runtime },
  );
  if (!planDispatch.started) {
    throw new AppError(planDispatch.error ?? 'Failed to ask the orchestrator for a plan.', {
      code: 'ORCHESTRATOR_PLAN_DISPATCH_FAILED',
      statusCode: 502,
    });
  }

  const history = await sessionsService.fetchHistory(input.orchestratorSessionId, { limit: null, offset: 0 });
  const planResponseText = findLatestAssistantContent(history.messages);
  if (!planResponseText) {
    throw new AppError('The orchestrator produced no response to parse a plan from.', {
      code: 'ORCHESTRATOR_PLAN_PARSE_FAILED',
      statusCode: 502,
    });
  }

  const subtasks = parseOrchestratorPlan(planResponseText);

  return Promise.all(subtasks.map(async (subtask): Promise<OrchestratorSubtaskResult> => {
    const provider = resolveSubtaskProvider(subtask.role, input.providerRoles);
    if (!provider) {
      return {
        title: subtask.title,
        role: subtask.role,
        started: false,
        error: `No provider has the "${subtask.role}" role assigned.`,
      };
    }

    try {
      const sessionId = randomUUID();
      sessionsDb.createAppSession(sessionId, provider, orchestratorSession.project_path ?? '', subtask.title);

      const dispatch = await startDetachedChatTurn(
        { sessionId, userId: input.userId, content: subtask.description },
        { runtime },
      );
      return {
        title: subtask.title,
        role: subtask.role,
        provider,
        sessionId,
        started: dispatch.started,
        error: dispatch.error ?? undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { title: subtask.title, role: subtask.role, provider, started: false, error: message };
    }
  }));
}
