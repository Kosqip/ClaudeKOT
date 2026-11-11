// Mounted at /api/mix in server/index.ts, behind the same authenticateToken
// middleware every other provider-facing route uses.
export { default as mixRoutes } from '@/modules/mix/mix.routes.js';
