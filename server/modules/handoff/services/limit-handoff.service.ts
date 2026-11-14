import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { handoffLinksDb, sessionsDb, userPreferencesDb } from '@/modules/database/index.js';
import { detectProviderLimit, mapClaudeRateLimitType, providerAuthService, sessionsService } from '@/modules/providers/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { broadcastToConnectedClients, startDetachedChatTurn } from '@/modules/websocket/index.js';
import { AppError, isTextOnlyProvider } from '@/shared/utils.js';
import type {
  HandoffSuggestion,
  ProviderFatalFailureCause,
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

/** True while a recorded limit on `provider` has not yet reset. Exported for this module's tests and the orchestrator. */
export function isProviderLimited(provider: LLMProvider, now: number = Date.now()): boolean {
  return getProviderLimitedUntil(provider, now) !== null;
}

/**
 * When a recorded limit on `provider` resets (ms since epoch), or null when
 * it is free to take work. Used by the orchestrator module to wait for a
 * backend instead of failing a task when every candidate is at its limit,
 * and by the diagnostics report.
 */
export function getProviderLimitedUntil(provider: LLMProvider, now: number = Date.now()): number | null {
  const until = limitedProviders.get(provider);
  if (until === undefined) {
    return null;
  }
  if (until <= now) {
    limitedProviders.delete(provider);
    return null;
  }
  return until;
}

/**
 * Records a limit reported by a turn in `sessionId` without moving the
 * session anywhere. Used by `server/index.ts` for sessions the orchestrator
 * runs itself: it reassigns the work along the role's own chain, so the
 * generic move to a fallback must not also happen.
 */
export function recordSessionProviderLimit(sessionId: string, resetsAt?: string): void {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    return;
  }
  const resetsAtMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  markProviderLimited(session.provider as LLMProvider, Number.isFinite(resetsAtMs) && resetsAtMs > Date.now() ? resetsAtMs : undefined);
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
 * Decides what a failed turn's error means for the relay ("fail fast",
 * after Audatic07/duo):
 * - `fail_fast` — the CLI is missing, the sign-in is missing/expired or the
 *   model is unknown. No retry or other backend can fix that, so no relay is
 *   started (it would only spend the fallback's limit on a doomed turn); the
 *   chat shows the error with a localized explanation instead.
 * - `handoff` — a subscription/rate limit: move the session to a fallback.
 * - `none` — any other failure: left to the user, as before.
 *
 * `errorCode` is the provider's structured code when there is one (Claude's
 * `SDKAssistantMessageError`); the message text is used only where the
 * provider gives nothing else. Used by `server/index.ts` for every failed
 * chat turn, and by this module's tests.
 */
export function decideHandoffForRunFailure(
  provider: LLMProvider,
  failure: { message: string; errorCode?: string },
):
  | { action: 'handoff'; reason: ProviderLimitReason }
  | { action: 'fail_fast'; cause: ProviderFatalFailureCause }
  | { action: 'none' } {
  const detection = detectProviderLimit(provider, {
    message: failure.message,
    claudeSdkError: provider === 'claude' ? failure.errorCode : undefined,
  });
  if (detection.detected) {
    return { action: 'handoff', reason: detection.reason };
  }
  if (detection.fatalCause) {
    return { action: 'fail_fast', cause: detection.fatalCause };
  }
  return { action: 'none' };
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
 * Renders one or more backends' turns, in the order the conversation
 * actually moved through them, each under a heading naming which backend
 * produced it — used once a conversation has been handed off more than
 * once, so a new (or resumed) session sees the whole history instead of
 * only the hop it is being moved from. A single-segment call renders the
 * same as `renderHistoryAsText` alone, just under one heading.
 */
export function renderFamilyHistoryAsText(segments: Array<{ provider: LLMProvider; text: string }>): string {
  return segments
    .filter((segment) => segment.text.trim())
    .map((segment) => `### On ${segment.provider}\n\n${segment.text}`)
    .join('\n\n---\n\n');
}

/**
 * Where a handoff's rendered history is written for the fallback session to
 * read, one file per `toSessionId`, for every target except a text-only one
 * (see `isTextOnlyProvider`), which has no file tool to read it with and
 * gets the history inlined instead (`truncateForInlineContext`). A long
 * conversation inlined directly into a prompt risks blowing past the
 * fallback provider's own context window before the user's actual request
 * is even reached; pointing at a file the fallback CLI reads with its own
 * file tool keeps the opening message itself small regardless of how long
 * the original conversation was.
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
/** Longest history a text-only target's opening message carries; past this it would eat into the window the user's actual request needs. */
const MAX_INLINE_CONTEXT_CHARS = 12000;

/**
 * Keeps the *end* of `historyText` (the most recent, most relevant turns)
 * within `MAX_INLINE_CONTEXT_CHARS`, since a text-only target has no file
 * tool to read the rest from if it is cut. Used by `handoffSessionOnLimit`
 * for a text-only target in place of `writeHandoffContextFile`.
 */
export function truncateForInlineContext(historyText: string): string {
  if (historyText.length <= MAX_INLINE_CONTEXT_CHARS) {
    return historyText;
  }
  return `[…earlier history cut, too long to include…]\n\n${historyText.slice(-MAX_INLINE_CONTEXT_CHARS)}`;
}

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
    /** Required for `continue`/`standby`; a `manual` switch has no limit reason to carry. */
    reason?: ProviderLimitReason;
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

  // This conversation's whole lineage: every session a handoff has ever
  // moved it through (including, after this call, the one being created or
  // resumed now), so a repeat visit to a backend already used earlier finds
  // it, and whichever session ends up receiving the history gets the whole
  // chain, not only the one hop it is being moved from.
  const familyId = handoffLinksDb.getFamilyId(input.fromSessionId) ?? input.fromSessionId;
  handoffLinksDb.link(input.fromSessionId, familyId, fromProvider);

  const existingMemberId = handoffLinksDb.findMember(familyId, toProvider);
  const existingMember = existingMemberId ? sessionsDb.getSessionById(existingMemberId) : null;
  // A resumed member keeps its own native history; an archived one is treated as gone rather than silently revived.
  const resuming = Boolean(existingMember) && existingMember!.isArchived !== 1;

  const toSessionId = resuming ? existingMember!.session_id : randomUUID();
  if (!resuming) {
    sessionsDb.createAppSession(
      toSessionId,
      toProvider,
      fromSession.project_path ?? '',
      fromSession.custom_name ? `${fromSession.custom_name} (continued)` : undefined,
    );
    handoffLinksDb.link(toSessionId, familyId, toProvider);
  }

  // Everyone else in the family (chronological, so earlier hops read before later ones) — the
  // target's own native history already covers its own earlier turns when resuming.
  const otherMembers = handoffLinksDb.listMembers(familyId).filter((member) => member.sessionId !== toSessionId);
  const segments = await Promise.all(otherMembers.map(async (member) => ({
    provider: member.provider as LLMProvider,
    text: renderHistoryAsText((await sessionsService.fetchHistory(member.sessionId, { limit: null, offset: 0 })).messages),
  })));
  const historyText = renderFamilyHistoryAsText(segments);

  // A text-only target (Custom API) has no file or shell access at all, so
  // pointing it at a path — the only thing every other backend needs — would
  // leave it stuck: it would say so, or worse, guess. Its history goes
  // straight into the message instead, trimmed to a sane size since there is
  // no file to defer the length to; every other backend keeps the file, kept
  // out of the message itself so a long conversation cannot blow past the
  // fallback's own context window before it even reaches the real request.
  const targetIsTextOnly = isTextOnlyProvider(toProvider);
  const contextReference = targetIsTextOnly
    ? `\n\n${truncateForInlineContext(historyText)}`
    : `, saved at ${await writeHandoffContextFile(toSessionId, historyText)} — read it`;

  // The previous agent may have been cut off mid-task (continue/manual) or simply
  // interrupted between turns (manual) — what it says it did and what is on disk
  // can differ either way. Meaningless for a text-only target, which has no folder to check.
  const checkFolderFirst = targetIsTextOnly
    ? []
    : ['The previous backend may have left this mid-task. Before redoing or building on any step, check the actual state of the working folder (for example `git status` and `git diff`) and trust it over the conversation.'];

  // A resumed session already has its own earlier turns natively; the context only adds what happened elsewhere meanwhile.
  const readTheContext = resuming
    ? `What happened on other backends since you were last active here${contextReference}, then continue from where YOU left off, folding in anything new.`
    : `The prior conversation${contextReference} first, then continue from where it leaves off.`;

  const openingMessage = mode === 'standby'
    ? [
      `[Switched: the previous backend is close to ${REASON_LABEL[input.reason!]}.]`,
      `The prior conversation${contextReference} so you have the context. Its last turn finished normally, so do not start any work yet: reply briefly that you are ready and wait for the next instruction.`,
    ].join('\n\n')
    : [
      mode === 'manual'
        ? (resuming
          ? '[Switched: the user asked for this conversation to continue here again.]'
          : '[Switched: the user asked for this conversation to continue on a different backend.]')
        : `[Continued automatically: the previous backend hit ${REASON_LABEL[input.reason!]}.]`,
      readTheContext,
      ...checkFolderFirst,
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
