// startOrchestratorRun and its readers: an orchestrated task — plan, subtasks
// on the backends holding their roles, review, optional follow-up rounds.
// Exported for this module's own tests and for whatever future layer needs
// to trigger a run outside the route.
export {
  cancelOrchestratorRun,
  createOrchestratorRunDependencies,
  findLatestOrchestratorRun,
  getOrchestratorRun,
  startOrchestratorRun,
} from '@/modules/orchestrator/services/orchestrator-dispatch.service.js';

// isOrchestratorManagedSession: asked by server/index.ts before it moves a
// session that hit a usage limit — a run reassigns its own sessions' work.
// restoreOrchestratorRuns: called by server/index.ts at startup so tasks
// that were waiting for a limit go on waiting. listRecentOrchestratorRuns:
// read by the diagnostics module's report.
export {
  isOrchestratorManagedSession,
  listRecentOrchestratorRuns,
  restoreOrchestratorRuns,
} from '@/modules/orchestrator/services/orchestrator-dispatch.service.js';

// The orchestrator's own pure logic (prompts, parsers, step grouping, access
// options), exported for this module's tests.
export {
  buildPlanRequestPrompt,
  buildSubtaskTurnOptions,
  groupSubtasksIntoSteps,
  parseOrchestratorPlan,
  parseOrchestratorReview,
  resolveSubtaskProvider,
} from '@/modules/orchestrator/services/orchestrator-plan.service.js';

// Mounted at /api/orchestrator in server/index.ts, behind the same
// authenticateToken middleware every other provider-facing route uses.
export { default as orchestratorRoutes } from '@/modules/orchestrator/orchestrator.routes.js';
