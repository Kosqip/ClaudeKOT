// handoffSessionOnLimit: continues a session on a fallback provider after a
// usage/rate limit, carrying its history over as the opening message.
// Consumed directly by handoff.routes.ts and, once live detection is wired
// in, by whatever layer intercepts a runtime's limit error.
export { handoffSessionOnLimit } from '@/modules/handoff/services/limit-handoff.service.js';

// Mounted at /api/handoff in server/index.ts, behind the same
// authenticateToken middleware every other provider-facing route uses.
export { default as handoffRoutes } from '@/modules/handoff/handoff.routes.js';
