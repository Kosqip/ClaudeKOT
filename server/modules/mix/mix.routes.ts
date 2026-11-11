import express from 'express';
import type { Request, Response } from 'express';

import { dispatchMixTurn } from '@/modules/mix/services/mix-dispatch.service.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import type { MixTarget } from '@/shared/types.js';
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

function readTargets(value: unknown): MixTarget[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new AppError('A mix dispatch requires at least two target sessions.', {
      code: 'INVALID_MIX_TARGETS',
      statusCode: 400,
    });
  }

  const sessionIds = value.map((entry) => {
    const sessionId = typeof entry === 'object' && entry !== null
      ? (entry as Record<string, unknown>).sessionId
      : entry;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new AppError('Every mix target needs a sessionId.', {
        code: 'INVALID_MIX_TARGETS',
        statusCode: 400,
      });
    }
    return sessionId;
  });

  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new AppError('A mix dispatch cannot target the same session twice.', {
      code: 'INVALID_MIX_TARGETS',
      statusCode: 400,
    });
  }

  return sessionIds.map((sessionId) => ({ sessionId }));
}

function readContent(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('content is required.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  return value;
}

const router = express.Router();

/**
 * Sends one user message to several existing provider sessions at once.
 *
 * Each target session keeps its own provider, model, and transcript; this
 * only starts their turns together. The actual replies stream to the client
 * exactly as any other provider run does — over `chat.subscribe` for each
 * session id — so this endpoint's response only reports which turns started.
 */
router.post(
  '/dispatch',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const results = await dispatchMixTurn(
      {
        targets: readTargets(body.targets),
        userId: readUserId(req),
        content: readContent(body.content),
        options: (body.options ?? {}) as Record<string, unknown>,
      },
      providerRuntimeService,
    );
    res.json(createApiSuccessResponse({ results }));
  }),
);

export default router;
