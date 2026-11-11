import express from 'express';
import type { Request, Response } from 'express';

import { handoffSessionOnLimit } from '@/modules/handoff/services/limit-handoff.service.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import type { LLMProvider, ProviderLimitReason } from '@/shared/types.js';
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

const KNOWN_REASONS: ProviderLimitReason[] = [
  'five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'rate_limit', 'unknown_limit',
];

function readReason(value: unknown): ProviderLimitReason {
  if (typeof value === 'string' && (KNOWN_REASONS as string[]).includes(value)) {
    return value as ProviderLimitReason;
  }
  throw new AppError(`reason must be one of: ${KNOWN_REASONS.join(', ')}.`, {
    code: 'INVALID_REQUEST_BODY',
    statusCode: 400,
  });
}

function readFallbackOrder(value: unknown): LLMProvider[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new AppError('fallbackOrder must be an array of provider ids.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  return value as LLMProvider[];
}

const router = express.Router();

/**
 * Manually continues a session on a fallback provider, carrying its full
 * history over as the fallback's opening message.
 *
 * This is the same action an automatic limit-triggered handoff will perform
 * once live detection is wired into a running chat turn (not yet done — the
 * detector in the providers module and this endpoint are the two pieces
 * built so far). Exposed now so the flow can be exercised by hand or by
 * other backend code ahead of that wiring.
 */
router.post(
  '/trigger',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
      throw new AppError('sessionId is required.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }

    const result = await handoffSessionOnLimit(
      {
        fromSessionId: body.sessionId,
        userId: readUserId(req),
        reason: readReason(body.reason),
        fallbackOrder: readFallbackOrder(body.fallbackOrder),
      },
      providerRuntimeService,
    );
    res.json(createApiSuccessResponse({ result }));
  }),
);

export default router;
