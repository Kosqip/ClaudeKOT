// planAndDispatchOrchestratorTask: splits a task into subtasks on an
// orchestrator session and dispatches each to a new session on whichever
// provider holds that subtask's role. Exported for this module's own tests
// and for whatever future layer needs to trigger it outside the route.
export { planAndDispatchOrchestratorTask } from '@/modules/orchestrator/services/orchestrator-dispatch.service.js';

// buildPlanRequestPrompt / parseOrchestratorPlan / resolveSubtaskProvider:
// the orchestrator's own pure logic, exported for this module's tests.
export {
  buildPlanRequestPrompt,
  parseOrchestratorPlan,
  resolveSubtaskProvider,
} from '@/modules/orchestrator/services/orchestrator-plan.service.js';

// Mounted at /api/orchestrator in server/index.ts, behind the same
// authenticateToken middleware every other provider-facing route uses.
export { default as orchestratorRoutes } from '@/modules/orchestrator/orchestrator.routes.js';
