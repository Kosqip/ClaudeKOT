import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { mapClaudeRateLimitType, sessionsService } from '@/modules/providers/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { runDetachedChatTurn } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';
import type { LimitHandoffResult, LLMProvider, ProviderLimitReason, RateLimitStatus } from '@/shared/types.js';

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
 * Picks the first provider in `fallbackOrder` that is not `excludeProvider`
 * and has a live runtime. Returns `null` when none qualifies (e.g. every
 * fallback has been exhausted too, or the order is empty), so the caller can
 * report "no fallback available" instead of looping forever.
 */
export function pickFallbackProvider(
  fallbackOrder: LLMProvider[],
  excludeProvider: LLMProvider,
  runtime: ProviderRuntimeGateway,
): LLMProvider | null {
  return fallbackOrder.find((provider) => provider !== excludeProvider && runtime.hasRuntime(provider)) ?? null;
}

/**
 * Continues a session's conversation on a fallback provider after its
 * current provider hit a subscription/rate limit (see
 * `detectProviderLimit` in the providers module, which decides *whether* to
 * call this).
 *
 * Reads the full history of `fromSessionId`, opens a brand-new app session
 * for the chosen fallback provider in the same project, writes that history
 * to its own file (`writeHandoffContextFile`, not inlined into the prompt —
 * see its doc comment), and starts the new session's first turn with a short
 * note identifying the reason and the file's path — the fallback provider
 * never receives any of the original provider's native session state, auth,
 * or process, only an ordinary first message pointing at a file. This is
 * intentionally the same path (`runDetachedChatTurn`) every other turn in
 * the app goes through; no provider's subprocess spawning or credential
 * handling is touched here.
 *
 * Consumed by whatever layer first wires live limit detection into a running
 * chat turn (not yet done — see the handoff module's README/report); callable
 * directly today for a manual "continue on another backend" action or tests.
 */
export async function handoffSessionOnLimit(
  input: {
    fromSessionId: string;
    userId: number;
    reason: ProviderLimitReason;
    /** Overrides `DEFAULT_FALLBACK_ORDER` — e.g. a user's configured backend priority. */
    fallbackOrder?: LLMProvider[];
  },
  runtime: ProviderRuntimeGateway,
): Promise<LimitHandoffResult> {
  const fromSession = sessionsDb.getSessionById(input.fromSessionId);
  if (!fromSession) {
    throw new AppError(`Session "${input.fromSessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }

  const fromProvider = fromSession.provider as LLMProvider;
  const toProvider = pickFallbackProvider(input.fallbackOrder ?? DEFAULT_FALLBACK_ORDER, fromProvider, runtime);
  if (!toProvider) {
    throw new AppError('No fallback backend is available to continue this session.', {
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

  const openingMessage = [
    `[Continued automatically: the previous backend hit ${REASON_LABEL[input.reason]}.]`,
    `The prior conversation is saved at ${contextFilePath} — read it first, then continue from where it leaves off.`,
  ].join('\n\n');

  const dispatch = await runDetachedChatTurn(
    { sessionId: toSessionId, userId: input.userId, content: openingMessage },
    { runtime },
  );
  if (!dispatch.started) {
    throw new AppError(dispatch.error ?? 'Failed to start the fallback session.', {
      code: 'HANDOFF_DISPATCH_FAILED',
      statusCode: 502,
    });
  }

  return {
    fromSessionId: input.fromSessionId,
    fromProvider,
    toSessionId,
    toProvider,
    reason: input.reason,
  };
}
