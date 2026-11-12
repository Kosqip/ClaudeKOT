import express from 'express';
import type { Request, Response } from 'express';

import { userPreferencesDb } from '@/modules/database/index.js';
import {
  cancelOrchestratorRun,
  createOrchestratorRunDependencies,
  findLatestOrchestratorRun,
  getOrchestratorRun,
  ORCHESTRATOR_MAX_ROUNDS_LIMIT,
  startOrchestratorRun,
} from '@/modules/orchestrator/services/orchestrator-dispatch.service.js';
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

function readMaxRounds(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > ORCHESTRATOR_MAX_ROUNDS_LIMIT) {
    throw new AppError(`maxRounds must be a whole number from 1 to ${ORCHESTRATOR_MAX_ROUNDS_LIMIT}.`, {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  return value;
}

function requireRun<T>(run: T | null): T {
  if (!run) {
    throw new AppError('This orchestrated task is no longer known to the server.', {
      code: 'ORCHESTRATOR_RUN_NOT_FOUND',
      statusCode: 404,
    });
  }
  return run;
}

const router = express.Router();

/**
 * Starts an orchestrated task on the given session and answers at once with
 * the run, still planning; the client follows it through `GET /runs/:id`
 * (see `startOrchestratorRun` for the whole flow).
 */
router.post(
  '/plan',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
      throw new AppError('sessionId is required.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }

    const userId = readUserId(req);
    const { run, finished } = startOrchestratorRun(
      {
        orchestratorSessionId: body.sessionId,
        userId,
        task: readTask(body.task),
        providerRoles: readStoredProviderRoles(userId),
        maxRounds: readMaxRounds(body.maxRounds),
      },
      createOrchestratorRunDependencies(providerRuntimeService),
    );
    void finished;
    res.json(createApiSuccessResponse({ run }));
  }),
);

/** The latest run started from a session (`?sessionId=`), or `run: null` — lets the panel pick a run back up after a reload. */
router.get(
  '/runs',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    res.json(createApiSuccessResponse({ run: sessionId ? findLatestOrchestratorRun(sessionId) : null }));
  }),
);

/** One run as it stands now. */
router.get(
  '/runs/:runId',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ run: requireRun(getOrchestratorRun(String(req.params.runId))) }));
  }),
);

/** Stops a run from starting anything further (see `cancelOrchestratorRun`). */
router.post(
  '/runs/:runId/cancel',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ run: requireRun(cancelOrchestratorRun(String(req.params.runId))) }));
  }),
);

export default router;
