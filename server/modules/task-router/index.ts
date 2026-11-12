// classifyTask: decides a task's tag (explicit choice wins outright, else a
// keyword match against task-router.config.json). Exported for this
// module's own tests and for dispatchTaskByTag.
export { classifyTask, loadTaskRouterConfig } from '@/modules/task-router/services/task-router.service.js';

// dispatchTaskByTag: classifies then routes a task per the fixed per-tag
// rules (routine -> free OpenRouter model, coding -> Claude,
// second_opinion -> Claude + Codex via the mix module, complex -> no
// auto-dispatch). Exported for this module's own tests.
export { dispatchTaskByTag } from '@/modules/task-router/services/task-router-dispatch.service.js';

// Mounted at /api/task-router in server/index.ts, behind the same
// authenticateToken middleware every other provider-facing route uses.
export { default as taskRouterRoutes } from '@/modules/task-router/task-router.routes.js';
