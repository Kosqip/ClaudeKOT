import express from 'express';
import type { Request, Response } from 'express';

import { dispatchTaskByTag } from '@/modules/task-router/services/task-router-dispatch.service.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import type { TaskTag } from '@/shared/types.js';
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

const KNOWN_TASK_TAGS: TaskTag[] = ['routine', 'coding', 'second_opinion', 'complex'];

function readExplicitTag(value: unknown): TaskTag | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !(KNOWN_TASK_TAGS as string[]).includes(value)) {
    throw new AppError(`explicitTag must be one of: ${KNOWN_TASK_TAGS.join(', ')}.`, {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  return value as TaskTag;
}

function readProjectPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('projectPath is required.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return value;
}

function readContent(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('content is required.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return value;
}

const router = express.Router();

/**
 * Classifies one task by tag (explicit choice, or keyword match against
 * `task-router.config.json`) and routes it per the fixed per-tag rules in
 * `dispatchTaskByTag`'s doc comment. A `complex` result (explicit or
 * unmatched) dispatches nothing — the response's `manualSelectionRequired`
 * tells the caller to prompt the user for a backend instead.
 */
router.post(
  '/dispatch',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await dispatchTaskByTag(
      {
        projectPath: readProjectPath(body.projectPath),
        content: readContent(body.content),
        explicitTag: readExplicitTag(body.explicitTag),
        userId: readUserId(req),
      },
      providerRuntimeService,
    );
    res.json(createApiSuccessResponse(result));
  }),
);

export default router;
