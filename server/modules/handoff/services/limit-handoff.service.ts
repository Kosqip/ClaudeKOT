import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb, userPreferencesDb } from '@/modules/database/index.js';
import { mapClaudeRateLimitType, providerAuthService, sessionsService } from '@/modules/providers/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { broadcastToConnectedClients, startDetachedChatTurn } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';
import type {
  HandoffSuggestion,
  LimitHandoffMode,
  LimitHandoffResult,
  LLMProvider,
  ProviderLimitReason,
  RateLimitStatus,
} from '@/shared/types.js';

/**
 * Sessions an automatic handoff has already been started for, and in which
 * mode. Claude reports its rate-limit state repeatedly and a failed turn can
 * surface the same limit more than once, so without this every repeat would
 * open another fallback session for the same conversation. In memory on
 * purpose: after a restart a still-limited session simply hands off again.
 */
const claimedSessions = new Map<string, LimitHandoffMode>();

/**
 * Claims an automatic action for a session; false when one in this mode (or
 * a stronger one) was already claimed. `standby` is the one-time suggestion
 * to switch, `continue` the automatic move on a refusal — which may follow a
 * suggestion: a user who kept working in the original session still gets
 * moved when the provider finally refuses a request. Used by `server/index.ts`; the manual route does not claim, since
 * the user asking again is the point.
 */
export function tryClaimHandoff(sessionId: string, mode: LimitHandoffMode): boolean {
  const claimed = claimedSessions.get(sessionId);
  if (claimed === 'continue' || claimed === mode) {
    return false;
  }
  claimedSessions.set(sessionId, mode);
  return true;
}

/** Gives a claim back after a handoff that failed, so a later signal can retry. Used by `server/index.ts`. */
export function releaseHandoffClaim(sessionId: string): void {
  claimedSessions.delete(sessionId);
}

/** How long a provider is skipped as a fallback when its limit gave no reset time. */
const DEFAULT_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Providers known to be at their limit, with when to try them again. Without
 * it two exhausted backends hand a conversation back and forth forever: the
 * fallback hits its own limit and the only provider it excludes is itself.
 */
const limitedProviders = new Map<LLMProvider, number>();

/** Records that `provider` hit a limit until `untilMs` (default: one hour from now). Exported for this module's tests. */
export function markProviderLimited(provider: LLMProvider, untilMs: number = Date.now() + DEFAULT_LIMIT_COOLDOWN_MS): void {
  limitedProviders.set(provider, untilMs);
}

/** True while a recorded limit on `provider` has not yet reset. Exported for this module's tests. */
export function isProviderLimited(provider: LLMProvider, now: number = Date.now()): boolean {
  const until = limitedProviders.get(provider);
  if (until === undefined) {
    return false;
  }
  if (until <= now) {
    limitedProviders.delete(provider);
    return false;
  }
  return true;
}

/** Clears the in-memory claim and limit records. Used only by this module's tests. */
export function resetHandoffState(): void {
  claimedSessions.clear();
  limitedProviders.clear();
}

/**
 * Utilization percentage, as `RateLimitStatus.utilization * 100`, at which
 * `shouldHandoffForRateLimitStatus` hands off proactively — before Claude's
 * SDK actually reports `status: 'rejected'`. `100` disables proactive
 * handoff entirely (only a hard rejection triggers it, the pre-proactive
 * behavior); the UI's selectable options are 100/95/90/85/80
 * (`HANDOFF_THRESHOLD_OPTIONS` in `src/shared/userSettings.ts`, which this
 * mirrors by hand). Used whenever a user has not set their own
 * `handoffThresholdPercent` preference.
 */
export const DEFAULT_HANDOFF_THRESHOLD_PERCENT = 90;

/**
 * Decides whether one live `rate_limit_status` reading should trigger a
 * handoff, and if so, the reason to record.
 *
 * A hard `rejected` always hands off regardless of the configured
 * threshold — that is Claude actually refusing the request, not a
 * prediction. Below `rejected`, a handoff fires only once `utilization`
 * (0–1) reaches `thresholdPercent`, and only for `allowed_warning` (a plain
 * `allowed` at or above the threshold should not occur, but is deliberately
 * not treated as a trigger either, since Claude itself has not yet flagged
 * the window as being close to its limit).
 */
export function shouldHandoffForRateLimitStatus(
  status: RateLimitStatus,
  thresholdPercent: number,
): { handoff: true; reason: ProviderLimitReason } | { handoff: false } {
  if (status.status === 'rejected') {
    return { handoff: true, reason: mapClaudeRateLimitType(status.rateLimitType) };
  }

  if (
    status.status === 'allowed_warning'
    && thresholdPercent < 100
    && typeof status.utilization === 'number'
    && status.utilization * 100 >= thresholdPercent
  ) {
    return { handoff: true, reason: mapClaudeRateLimitType(status.rateLimitType) };
  }

  return { handoff: false };
}

/**
 * Default fallback order consulted when a session's own project has no
 * explicit priority configured. Deliberately short and provider-agnostic —
 * OpenRouter is listed last because, unlike Claude/Codex, it is metered per
 * token rather than by a subscription window, so it is the natural "never
 * runs out" backstop rather than a preferred fallback.
 */
export const DEFAULT_FALLBACK_ORDER: LLMProvider[] = ['codex', 'claude', 'opencode', 'cursor', 'openrouter'];

/**
 * Renders a session's history as plain text so a fallback provider's CLI,
 * which has no notion of another provider's native transcript format, can
 * read it as an ordinary opening message instead of needing a conversion for
 * each provider pair.
 */
export function renderHistoryAsText(messages: Array<{ role?: 'user' | 'assistant'; content?: string }>): string {
  return messages
    .filter((message) => message.content)
    .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
    .join('\n\n');
}

/**
 * Where a handoff's rendered history is written for the fallback session to
 * read, one file per `toSessionId` — never inlined into the opening message
 * itself. A long conversation inlined directly into a prompt risks blowing
 * past the fallback provider's own context window before the user's actual
 * request is even reached; pointing at a file the fallback CLI reads with
 * its own file tool (as `~/.cloudcli` already does for OpenRouter's session
 * history — see `openrouter-history.store.ts`) keeps the opening message
 * itself small regardless of how long the original conversation was.
 *
 * Assumes the fallback provider's file tool can read an absolute path
 * outside the project directory, which holds for Claude Code and Codex as
 * run by this app today; revisit if a future provider sandboxes file reads
 * to the project root only.
 */
const HANDOFF_CONTEXT_DIR = path.join(os.homedir(), '.cloudcli', 'handoff-context');

/**
 * Writes one handoff's rendered history to its own file and returns the
 * absolute path, creating the directory on first use.
 *
 * Exported for `handoffSessionOnLimit` (above, the only real caller) and for
 * this module's own tests, which verify the file is actually written and
 * readable rather than only checking the opening message's text.
 */
export async function writeHandoffContextFile(toSessionId: string, historyText: string): Promise<string> {
  await mkdir(HANDOFF_CONTEXT_DIR, { recursive: true });
  const filePath = path.join(HANDOFF_CONTEXT_DIR, `${toSessionId}.md`);
  await writeFile(filePath, historyText || '(no prior messages)', 'utf8');
  return filePath;
}

const REASON_LABEL: Record<ProviderLimitReason, string> = {
  five_hour: 'the 5-hour usage limit',
  seven_day: 'the weekly usage limit',
  seven_day_opus: 'the weekly Opus usage limit',
  seven_day_sonnet: 'the weekly Sonnet usage limit',
  rate_limit: 'a rate limit',
  unknown_limit: 'a usage limit',
};

/**
 * Lists the providers in `fallbackOrder` a session may be handed to, in
 * order: not `excludeProvider`, with a registered runtime, and not currently
 * recorded as at its own limit. Whether each is installed and signed in is
 * checked separately by `handoffSessionOnLimit`, since that lookup is async.
 */
export function listFallbackCandidates(
  fallbackOrder: LLMProvider[],
  excludeProvider: LLMProvider,
  runtime: ProviderRuntimeGateway,
): LLMProvider[] {
  return fallbackOrder.filter((provider) =>
    provider !== excludeProvider && runtime.hasRuntime(provider) && !isProviderLimited(provider));
}

/**
 * The first of `listFallbackCandidates`, or `null` when none qualifies (the
 * order is empty, or every fallback is at its own limit too), so the caller
 * can report "no fallback available" instead of looping forever.
 */
export function pickFallbackProvider(
  fallbackOrder: LLMProvider[],
  excludeProvider: LLMProvider,
  runtime: ProviderRuntimeGateway,
): LLMProvider | null {
  return listFallbackCandidates(fallbackOrder, excludeProvider, runtime)[0] ?? null;
}

const KNOWN_PROVIDERS: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode', 'openrouter'];

/**
 * The user's own fallback order from settings (`handoffFallbackOrder`), or
 * `undefined` to use `DEFAULT_FALLBACK_ORDER`. Preferences are stored as
 * arbitrary JSON, so anything that is not a non-empty list of known provider
 * ids counts as not set. Used by `server/index.ts` and `handoff.routes.ts`.
 */
export function readStoredFallbackOrder(userId: number): LLMProvider[] | undefined {
  const stored = userPreferencesDb.getPreferences(userId).handoffFallbackOrder;
  if (!Array.isArray(stored) || stored.length === 0) {
    return undefined;
  }
  return stored.every((entry) => KNOWN_PROVIDERS.includes(entry)) ? stored as LLMProvider[] : undefined;
}

/** The first fallback for `fromProvider` that is installed, signed in and not at its own limit; null when there is none. */
async function findReadyFallback(
  fromProvider: LLMProvider,
  fallbackOrder: LLMProvider[] | undefined,
  runtime: ProviderRuntimeGateway,
  isReady: (provider: LLMProvider) => Promise<boolean>,
): Promise<LLMProvider | null> {
  for (const candidate of listFallbackCandidates(fallbackOrder ?? DEFAULT_FALLBACK_ORDER, fromProvider, runtime)) {
    if (await isReady(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Offers to move a session whose provider is close to its limit, without
 * starting anything: tells every connected client with a `handoff_suggestion`
 * event naming the fallback that would take over. Resolves to null — and
 * sends nothing — when the session is gone or no fallback is ready, since an
 * offer the user cannot accept is only noise.
 *
 * Consumed by `server/index.ts` once a turn ends above the user's threshold.
 */
export async function suggestHandoff(
  input: {
    fromSessionId: string;
    reason: ProviderLimitReason;
    /** Share of the window used, 0–100. */
    utilizationPercent?: number;
    fallbackOrder?: LLMProvider[];
  },
  runtime: ProviderRuntimeGateway,
  isReady: (provider: LLMProvider) => Promise<boolean> = isProviderReady,
): Promise<HandoffSuggestion | null> {
  const fromSession = sessionsDb.getSessionById(input.fromSessionId);
  if (!fromSession) {
    return null;
  }
  const fromProvider = fromSession.provider as LLMProvider;
  const toProvider = await findReadyFallback(fromProvider, input.fallbackOrder, runtime, isReady);
  if (!toProvider) {
    return null;
  }

  const suggestion: HandoffSuggestion = {
    fromSessionId: input.fromSessionId,
    fromProvider,
    toProvider,
    reason: input.reason,
    utilizationPercent: input.utilizationPercent,
  };
  broadcastToConnectedClients(JSON.stringify({ kind: 'handoff_suggestion', sessionId: input.fromSessionId, ...suggestion }));
  return suggestion;
}

/** True when `provider` is installed and signed in, so a session handed to it can actually run. */
async function isProviderReady(provider: LLMProvider): Promise<boolean> {
  try {
    const status = await providerAuthService.getProviderAuthStatus(provider);
    return status.installed && status.authenticated;
  } catch {
    return false;
  }
}

/**
 * Moves a session's conversation to a fallback provider after its current
 * provider hit a subscription/rate limit, or is about to.
 *
 * Records the original provider as limited when it refused a request
 * (`continue` — one that is merely close stays usable as a fallback for
 * others), picks the first fallback that is installed, signed in and not
 * itself limited, writes the session's history
 * to a file (`writeHandoffContextFile`), opens a new session for the fallback
 * in the same project and starts it with a short note pointing at that file.
 * `mode` decides what the note asks for — see `LimitHandoffMode`. The
 * fallback receives none of the original provider's session state, auth or
 * process, only an ordinary first message.
 *
 * Resolves once the fallback's turn has started, not when it ends, and tells
 * every connected client with a `handoff_notice` event so the switch shows
 * up in the original session instead of only in the server log.
 *
 * Consumed by `handoff.routes.ts` (manual) and `server/index.ts` (automatic).
 */
export async function handoffSessionOnLimit(
  input: {
    fromSessionId: string;
    userId: number;
    reason: ProviderLimitReason;
    /** Defaults to `continue`. */
    mode?: LimitHandoffMode;
    /** When the original provider's limit resets (ISO), if it said. */
    resetsAt?: string;
    /** Overrides `DEFAULT_FALLBACK_ORDER` — e.g. a user's configured backend priority. */
    fallbackOrder?: LLMProvider[];
  },
  runtime: ProviderRuntimeGateway,
  isReady: (provider: LLMProvider) => Promise<boolean> = isProviderReady,
): Promise<LimitHandoffResult> {
  const fromSession = sessionsDb.getSessionById(input.fromSessionId);
  if (!fromSession) {
    throw new AppError(`Session "${input.fromSessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }

  const fromProvider = fromSession.provider as LLMProvider;
  const mode = input.mode ?? 'continue';
  if (mode === 'continue') {
    const resetsAtMs = input.resetsAt ? Date.parse(input.resetsAt) : Number.NaN;
    markProviderLimited(fromProvider, Number.isFinite(resetsAtMs) && resetsAtMs > Date.now() ? resetsAtMs : undefined);
  }

  const toProvider = await findReadyFallback(fromProvider, input.fallbackOrder, runtime, isReady);
  if (!toProvider) {
    throw new AppError('No fallback backend is available to continue this session: each one is not installed, not signed in, or at its own limit.', {
      code: 'NO_FALLBACK_PROVIDER',
      statusCode: 409,
    });
  }

  const history = await sessionsService.fetchHistory(input.fromSessionId, { limit: null, offset: 0 });
  const historyText = renderHistoryAsText(history.messages);

  const toSessionId = randomUUID();
  sessionsDb.createAppSession(
    toSessionId,
    toProvider,
    fromSession.project_path ?? '',
    fromSession.custom_name ? `${fromSession.custom_name} (continued)` : undefined,
  );

  const contextFilePath = await writeHandoffContextFile(toSessionId, historyText);

  const openingMessage = mode === 'continue'
    ? [
      `[Continued automatically: the previous backend hit ${REASON_LABEL[input.reason]}.]`,
      `The prior conversation is saved at ${contextFilePath} — read it first, then continue from where it leaves off.`,
      // The previous agent was cut off mid-task: what it says it did and what is on disk can differ.
      'The previous backend was interrupted and may have left changes half-made. Before redoing or building on any step, check the actual state of the working folder (for example `git status` and `git diff`) and trust it over the conversation.',
    ].join('\n\n')
    : [
      `[Switched: the previous backend is close to ${REASON_LABEL[input.reason]}.]`,
      `The prior conversation is saved at ${contextFilePath} — read it so you have the context. Its last turn finished normally, so do not start any work yet: reply briefly that you are ready and wait for the next instruction.`,
    ].join('\n\n');

  const dispatch = await startDetachedChatTurn(
    { sessionId: toSessionId, userId: input.userId, content: openingMessage },
    { runtime },
  );
  if (!dispatch.started) {
    throw new AppError(dispatch.error ?? 'Failed to start the fallback session.', {
      code: 'HANDOFF_DISPATCH_FAILED',
      statusCode: 502,
    });
  }

  const result: LimitHandoffResult = {
    fromSessionId: input.fromSessionId,
    fromProvider,
    toSessionId,
    toProvider,
    reason: input.reason,
    mode,
  };
  broadcastToConnectedClients(JSON.stringify({ kind: 'handoff_notice', sessionId: input.fromSessionId, ...result }));
  return result;
}
