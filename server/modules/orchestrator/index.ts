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
