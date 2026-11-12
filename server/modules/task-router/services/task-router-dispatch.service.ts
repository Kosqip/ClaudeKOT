import { randomUUID } from 'node:crypto';

import { sessionsDb } from '@/modules/database/index.js';
import { dispatchMixTurn } from '@/modules/mix/index.js';
import { classifyTask } from '@/modules/task-router/services/task-router.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { startDetachedChatTurn } from '@/modules/websocket/index.js';
import type { LLMProvider, TaskRouterDispatchResult, TaskRouterSessionResult, TaskTag } from '@/shared/types.js';

/**
 * Opens one brand-new session for `provider` in `projectPath` and starts it
 * with `content` as its first message, mirroring the session-creation
 * pattern `planAndDispatchOrchestratorTask` already uses — a task-router
 * dispatch, like an orchestrator subtask, always starts a fresh session
 * rather than reusing or guessing at an existing one.
 */
async function dispatchToNewSession(
  provider: LLMProvider,
  projectPath: string,
  content: string,
  userId: number,
  runtime: ProviderRuntimeGateway,
): Promise<TaskRouterSessionResult> {
  const sessionId = randomUUID();
  try {
    sessionsDb.createAppSession(sessionId, provider, projectPath);
    const dispatch = await startDetachedChatTurn({ sessionId, userId, content }, { runtime });
    return { provider, sessionId, started: dispatch.started, error: dispatch.error ?? undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { provider, sessionId, started: false, error: message };
  }
}

/**
 * Routes one task to its tag's backend(s), per the original spec's fixed
 * rules — not configurable per tag, unlike the keyword lists that decide
 * *which* tag applies:
 * - `routine` → a new OpenRouter session (its catalog's `DEFAULT` model is
 *   already the free one — see `openrouter-models.provider.ts` — so no
 *   model override is needed here).
 * - `coding` → a new Claude session.
 * - `second_opinion` → new Claude and Codex sessions, both started with the
 *   same message via the mix module's `dispatchMixTurn` (reused exactly as
 *   the mix layer's own route calls it, just against two sessions this
 *   function creates itself rather than two the user already had open).
 * - `complex` → nothing is dispatched; the original spec calls this tag out
 *   as requiring the user's own explicit backend choice, not auto-routing.
 * - no tag (no keyword matched) → nothing is dispatched either, and `tag` is
 *   reported as `null` rather than passed off as a detected `complex`.
 *
 * Resolves once the routed turns have started, not when they end.
 *
 * `tag` is resolved by the caller via `classifyTask` (exported from this
 * module's sibling, re-exported here too since the route needs both the
 * classification step and this dispatch step). Consumed by
 * `task-router.routes.ts`.
 */
export async function dispatchTaskByTag(
  input: {
    projectPath: string;
    content: string;
    explicitTag?: TaskTag;
    userId: number;
  },
  runtime: ProviderRuntimeGateway,
): Promise<TaskRouterDispatchResult> {
  const tag = classifyTask(input.content, input.explicitTag);
  const autoDetected = !input.explicitTag;

  if (tag === null || tag === 'complex') {
    return {
      tag,
      autoDetected,
      manualSelectionRequired: true,
      sessions: [],
    };
  }

  if (tag === 'routine') {
    const result = await dispatchToNewSession('openrouter', input.projectPath, input.content, input.userId, runtime);
    return { tag, autoDetected, manualSelectionRequired: false, sessions: [result] };
  }

  if (tag === 'coding') {
    const result = await dispatchToNewSession('claude', input.projectPath, input.content, input.userId, runtime);
    return { tag, autoDetected, manualSelectionRequired: false, sessions: [result] };
  }

  // second_opinion: open both sessions first, then fan the same message out
  // to them together through the mix module, so both start as close to
  // simultaneously as dispatchMixTurn already guarantees for its own callers.
  const claudeSessionId = randomUUID();
  const codexSessionId = randomUUID();
  sessionsDb.createAppSession(claudeSessionId, 'claude', input.projectPath);
  sessionsDb.createAppSession(codexSessionId, 'codex', input.projectPath);

  const mixResults = await dispatchMixTurn(
    {
      targets: [{ sessionId: claudeSessionId }, { sessionId: codexSessionId }],
      userId: input.userId,
      content: input.content,
    },
    runtime,
  );

  const sessions: TaskRouterSessionResult[] = mixResults.map((result) => ({
    provider: result.provider,
    sessionId: result.sessionId,
    started: result.started,
    error: result.error ?? undefined,
  }));

  return { tag, autoDetected, manualSelectionRequired: false, sessions };
}
