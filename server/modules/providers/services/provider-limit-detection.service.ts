import type {
  LLMProvider,
  ProviderLimitDetectionResult,
} from '@/shared/types.js';

/**
 * Claude's `SDKRateLimitInfo.rateLimitType` values that map directly onto our
 * reason vocabulary (source: `@anthropic-ai/claude-agent-sdk/sdk.d.ts`,
 * `SDKRateLimitInfo`). `seven_day_overage_included` and `overage` describe a
 * paid-overage state rather than a hard stop, so they are intentionally left
 * out — a request still goes through there, there is nothing to hand off.
 */
const CLAUDE_RATE_LIMIT_TYPE_TO_REASON: Partial<Record<string, 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet'>> = {
  five_hour: 'five_hour',
  seven_day: 'seven_day',
  seven_day_opus: 'seven_day_opus',
  seven_day_sonnet: 'seven_day_sonnet',
};

/**
 * Codex's SDK (`@openai/codex-sdk`) gives only a free-text `message` on its
 * `ThreadError`/`ErrorItem` — no structured error code. OpenAI's own rate
 * limit responses use these phrasings as of the SDK version pinned in
 * package.json; text matching is the only signal available, so this is
 * strictly less reliable than Claude's structured field above and can miss a
 * reworded message in a future SDK release.
 */
const CODEX_RATE_LIMIT_TEXT_PATTERNS = [
  /rate.?limit/i,
  /usage limit/i,
  /quota/i,
  /\b429\b/i,
];

/**
 * Detects whether one provider's raw runtime error/event represents a
 * subscription or API rate limit rather than an ordinary failure.
 *
 * Used by the handoff module (`server/modules/handoff/`) to decide whether a
 * failed turn should trigger an automatic switch to a fallback backend, and
 * by its tests. Each provider's detection logic documents the exact field or
 * pattern it reads and where that shape came from, so a provider SDK upgrade
 * that changes the shape is easy to track down — see the comments on each
 * branch below rather than guessing from behavior.
 */
export function detectProviderLimit(
  provider: LLMProvider,
  signal: {
    /** The `error` field of a Claude `SDKAssistantMessage`/`SDKResultMessage` (`SDKAssistantMessageError`), when present. */
    claudeSdkError?: string;
    /** `rate_limit_info` from a Claude `SDKRateLimitEvent`, when present. */
    claudeRateLimitInfo?: { status?: string; rateLimitType?: string; resetsAt?: number };
    /** The plain-text error message surfaced by the runtime (Codex `ThreadError.message`, OpenRouter's thrown error text, or any provider's generic error content). */
    message?: string;
  },
): ProviderLimitDetectionResult {
  if (provider === 'claude') {
    // A rejected rate-limit window is the authoritative signal: it names
    // exactly which window (five_hour/seven_day/...) blocked the request.
    if (signal.claudeRateLimitInfo?.status === 'rejected') {
      const reason = signal.claudeRateLimitInfo.rateLimitType
        ? CLAUDE_RATE_LIMIT_TYPE_TO_REASON[signal.claudeRateLimitInfo.rateLimitType]
        : undefined;
      return {
        detected: true,
        reason: reason ?? 'rate_limit',
        resetsAt: signal.claudeRateLimitInfo.resetsAt
          ? new Date(signal.claudeRateLimitInfo.resetsAt).toISOString()
          : undefined,
      };
    }
    // The assistant-message error literal 'rate_limit' is set on the SDK's
    // `SDKAssistantMessageError` union without a window breakdown.
    if (signal.claudeSdkError === 'rate_limit') {
      return { detected: true, reason: 'rate_limit' };
    }
    return { detected: false };
  }

  if (provider === 'codex') {
    if (signal.message && CODEX_RATE_LIMIT_TEXT_PATTERNS.some((pattern) => pattern.test(signal.message!))) {
      return { detected: true, reason: 'unknown_limit' };
    }
    return { detected: false };
  }

  if (provider === 'openrouter') {
    // openrouter-runtime.provider.ts throws `OpenRouter request failed (<status>): ...`
    // for any non-ok response, so the status code is always in parentheses —
    // no need to guess from the response body's wording.
    const statusMatch = signal.message?.match(/OpenRouter request failed \((\d+)\)/);
    if (statusMatch && statusMatch[1] === '429') {
      return { detected: true, reason: 'rate_limit' };
    }
    return { detected: false };
  }

  // Cursor and OpenCode: no known structured or text signal was found in
  // their runtime adapters for a usage/rate limit specifically (as opposed
  // to a generic failure). Reporting `detected: false` here is deliberate —
  // guessing from an unverified text pattern would risk false positives that
  // send the handoff module hunting for a replacement backend on an
  // unrelated error. Revisit if either CLI starts surfacing a documented
  // limit signal.
  return { detected: false };
}
