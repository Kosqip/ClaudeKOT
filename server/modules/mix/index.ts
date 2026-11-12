// dispatchMixTurn: fans one message out to several existing sessions at
// once. Used by mix.routes.ts and by the task router's "second_opinion" tag
// (server/modules/task-router/), which creates the two sessions itself and
// then reuses this to start them together.
export { dispatchMixTurn } from '@/modules/mix/services/mix-dispatch.service.js';

// Mounted at /api/mix in server/index.ts, behind the same authenticateToken
// middleware every other provider-facing route uses.
export { default as mixRoutes } from '@/modules/mix/mix.routes.js';
