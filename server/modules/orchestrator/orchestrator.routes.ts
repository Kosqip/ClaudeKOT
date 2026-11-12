import express from 'express';
import type { Request, Response } from 'express';

import { userPreferencesDb } from '@/modules/database/index.js';
import { planAndDispatchOrchestratorTask } from '@/modules/orchestrator/services/orchestrator-dispatch.service.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import type { LLMProvider, ProviderRole } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function readUserId(request: Request): number {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  if (!Number.isInteger(userId)) {
    throw new AppError('Authenticated user is required.', {
      code: 'USER_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

const KNOWN_LLM_PROVIDERS: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode', 'openrouter'];
const KNOWN_PROVIDER_ROLES: ProviderRole[] = ['orchestrator', 'hands', 'routine'];

/**
 * Reads the user's `providerRoles` preference, discarding any entry whose
 * key isn't a known provider or whose value isn't a known role —
 * `userPreferencesDb` stores arbitrary JSON, so a stale or hand-edited value
 * is dropped rather than trusted (mirrors `readStoredFallbackOrder` in
 * `server/index.ts`, the same defensive pattern for the handoff module's own
 * stored preference).
 */
function readStoredProviderRoles(userId: number): Partial<Record<LLMProvider, ProviderRole>> {
  const stored = userPreferencesDb.getPreferences(userId).providerRoles;
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return {};
  }

  const roles: Partial<Record<LLMProvider, ProviderRole>> = {};
  for (const [provider, role] of Object.entries(stored as Record<string, unknown>)) {
    if ((KNOWN_LLM_PROVIDERS as string[]).includes(provider) && (KNOWN_PROVIDER_ROLES as string[]).includes(role as string)) {
      roles[provider as LLMProvider] = role as ProviderRole;
    }
  }
  return roles;
}

function readTask(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('task is required.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return value;
}

const router = express.Router();

/**
 * Manually splits one task into subtasks on the orchestrator's own session,
 * then opens one new session per subtask on whichever provider the user has
 * assigned that subtask's role (see `planAndDispatchOrchestratorTask`'s doc
 * comment for the full flow and its deliberate one-level-only scope).
 */
router.post(
  '/plan',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
      throw new AppError('sessionId is required.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }

    const userId = readUserId(req);
    const subtasks = await planAndDispatchOrchestratorTask(
      {
        orchestratorSessionId: body.sessionId,
        userId,
        task: readTask(body.task),
        providerRoles: readStoredProviderRoles(userId),
      },
      providerRuntimeService,
    );
    res.json(createApiSuccessResponse({ subtasks }));
  }),
);

export default router;
