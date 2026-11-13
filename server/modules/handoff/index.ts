// handoffSessionOnLimit: continues a session on a fallback provider after a
// usage/rate limit, carrying its history over as the opening message.
// Consumed directly by handoff.routes.ts and by server/index.ts's live
// rate-limit wiring.
export { handoffSessionOnLimit } from '@/modules/handoff/services/limit-handoff.service.js';

// tryClaimHandoff / releaseHandoffClaim: used by server/index.ts so a session
// gets one automatic handoff however many times its limit is reported.
export { releaseHandoffClaim, tryClaimHandoff } from '@/modules/handoff/services/limit-handoff.service.js';

// shouldHandoffForRateLimitStatus / DEFAULT_HANDOFF_THRESHOLD_PERCENT: used
// by server/index.ts to decide, from a live rate_limit_status message and
// the user's configured threshold preference, whether to call
// handoffSessionOnLimit proactively (before Claude actually rejects a
// request) or only on a hard rejection.
export {
  DEFAULT_HANDOFF_THRESHOLD_PERCENT,
  shouldHandoffForRateLimitStatus,
} from '@/modules/handoff/services/limit-handoff.service.js';

// suggestHandoff: used by server/index.ts to offer a switch (without starting
// one) when a turn ends above the user's threshold. readStoredFallbackOrder:
// the user's own fallback order, applied by server/index.ts on every
// automatic path.
export { readStoredFallbackOrder, suggestHandoff } from '@/modules/handoff/services/limit-handoff.service.js';

// isProviderLimited: lets the orchestrator module pass over a backend that
// is at its usage limit when it picks who gets a subtask.
// getProviderLimitedUntil: when that limit resets, so the orchestrator can wait
// for it (also read by the diagnostics report). recordSessionProviderLimit:
// used by server/index.ts to note a limit hit in an orchestrator-run session
// without moving that session.
export { getProviderLimitedUntil, isProviderLimited, recordSessionProviderLimit } from '@/modules/handoff/services/limit-handoff.service.js';

// Mounted at /api/handoff in server/index.ts, behind the same
// authenticateToken middleware every other provider-facing route uses.
export { default as handoffRoutes } from '@/modules/handoff/handoff.routes.js';
