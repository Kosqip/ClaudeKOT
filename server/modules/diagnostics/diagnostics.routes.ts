import express from 'express';
import type { Request, Response } from 'express';

import { buildDiagnosticsReport } from '@/modules/diagnostics/services/diagnostics-report.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

/**
 * Routes for the diagnostics report. The app's version and install mode are
 * known only to the entry point, so they are handed in when the router is
 * created. Mounted by `server/index.ts`.
 */
export function createDiagnosticsRouter(app: { getVersion: () => string | null; installMode: string }): express.Router {
  const router = express.Router();

  /** The report as text, for the settings page to save to a file or copy. */
  router.get(
    '/report',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = Number((req as AuthenticatedRequest).user?.id);
      if (!Number.isInteger(userId)) {
        throw new AppError('Authenticated user is required.', { code: 'USER_REQUIRED', statusCode: 401 });
      }
      const report = await buildDiagnosticsReport({ userId, appVersion: app.getVersion(), installMode: app.installMode });
      res.json(createApiSuccessResponse({ report }));
    }),
  );

  return router;
}
