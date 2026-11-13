import express from 'express';
import type { Request, Response } from 'express';

import { handoffSessionOnLimit, readStoredFallbackOrder } from '@/modules/handoff/services/limit-handoff.service.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import type { LimitHandoffMode, LLMProvider, ProviderLimitReason } from '@/shared/types.js';
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

/** A `manual` switch has no limit reason; every other mode needs a known one. */
function readReason(value: unknown, mode: LimitHandoffMode): ProviderLimitReason | undefined {
  if (typeof value === 'string' && (KNOWN_REASONS as string[]).includes(value)) {
    return value as ProviderLimitReason;
  }
  if (mode === 'manual' && value === undefined) {
    return undefined;
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

function readMode(value: unknown): LimitHandoffMode {
  if (value === undefined || value === 'continue' || value === 'standby' || value === 'manual') {
    return value ?? 'continue';
  }
  throw new AppError('mode must be "continue", "standby" or "manual".', {
    code: 'INVALID_REQUEST_BODY',
    statusCode: 400,
  });
}

const router = express.Router();

/**
 * Manually moves a session to a fallback provider, carrying its history
 * over — the same action `server/index.ts` performs automatically when a
 * running turn reports a usage limit, here on the user's request and
 * without the one-handoff-per-session claim the automatic path takes. Also
 * how a `handoff_suggestion` is accepted (`mode: 'standby'`). Without a
 * `fallbackOrder` in the body the user's saved order applies.
 * Responds once the fallback session's turn has started.
 */
router.post(
  '/trigger',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
      throw new AppError('sessionId is required.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }

    const userId = readUserId(req);
    const mode = readMode(body.mode);
    const fallbackOrder = readFallbackOrder(body.fallbackOrder);
    // A manual switch names the one backend the user picked; silently
    // falling back to the saved default order could land on a different one.
    if (mode === 'manual' && (!fallbackOrder || fallbackOrder.length === 0)) {
      throw new AppError('fallbackOrder is required for a manual switch.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }
    const result = await handoffSessionOnLimit(
      {
        fromSessionId: body.sessionId,
        userId,
        reason: readReason(body.reason, mode),
        mode,
        fallbackOrder: fallbackOrder ?? readStoredFallbackOrder(userId),
      },
      providerRuntimeService,
    );
    res.json(createApiSuccessResponse({ result }));
  }),
);

export default router;
