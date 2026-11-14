import type {
  LLMProvider,
  ProviderFatalFailureCause,
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
 * Maps Claude's `SDKRateLimitInfo.rateLimitType` to this app's reason
 * vocabulary, falling back to the generic `rate_limit` for a window Claude
 * reports that this app does not name individually (e.g. an overage state).
 *
 * Exported for the handoff module's proactive threshold path, which decides
 * to hand off from a live `rate_limit_status` message's `utilization`
 * before the window is actually exhausted — `detectProviderLimit` below only
 * ever fires on `status: 'rejected'`, so a proactive handoff needs this
 * mapping directly rather than going through it.
 */
export function mapClaudeRateLimitType(rateLimitType: string | undefined): 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'rate_limit' {
  return (rateLimitType ? CLAUDE_RATE_LIMIT_TYPE_TO_REASON[rateLimitType] : undefined) ?? 'rate_limit';
}

/**
 * Codex's SDK (`@openai/codex-sdk`) gives only a free-text `message` on its
 * `ThreadError`/`ErrorItem` — no structured error code. OpenAI's own rate
 * limit responses use these phrasings as of the SDK version pinned in
 * package.json; text matching is the only signal available, so this is
 * strictly less reliable than Claude's structured field above and can miss a
 * reworded message in a future SDK release.
 *
 * The patterns name a limit specifically: a bare "quota" or "429" also
 * appears in ordinary output (a file path, a line number, a disk-quota
 * error), and a false match would move the session to another backend over
 * an unrelated failure. `usageLimitExceeded` is Codex's own error code.
 */
const CODEX_RATE_LIMIT_TEXT_PATTERNS = [
  /rate.?limit/i,
  /usage.?limit/i,
  /too many requests/i,
  /quota[ _-]?(?:exceeded|exhausted|reached)/i,
  /insufficient.?quota/i,
  /(?:http|status|code)[ :/]?429/i,
];

/**
 * Claude's structured `SDKAssistantMessageError` codes
 * (`@anthropic-ai/claude-agent-sdk/sdk.d.ts`) that no retry or backend
 * switch can fix. `account_on_hold`, `billing_error` and
 * `verification_required` are left out on purpose: they are account states
 * the user may resolve outside the app, and moving the conversation to
 * another backend is a reasonable answer to them.
 */
const CLAUDE_FATAL_SDK_ERRORS: Partial<Record<string, ProviderFatalFailureCause>> = {
  authentication_failed: 'auth_required',
  oauth_org_not_allowed: 'auth_required',
  model_not_found: 'unknown_model',
};

/**
 * Error texts that mean the provider's CLI binary is missing. Each one is
 * written by this app's own runtimes (`<Name> CLI is not installed`, the
 * Claude runtime's `Claude Code is not installed`), by the Claude Agent SDK
 * (`Claude Code executable/native binary not found at …`) or by Node itself
 * when the binary cannot be spawned (`spawn codex ENOENT`) — never by a
 * model's reply, so a match is not a guess at free text from the provider.
 */
const CLI_MISSING_TEXT_PATTERNS = [
  /\b(?:CLI|Claude Code) is not installed\b/i,
  /Claude Code (?:executable|native binary) not found at\b/i,
  /\bspawn \S+ ENOENT\b/,
];

/**
 * Codex sign-in failures. The Codex SDK gives only a free-text message (see
 * `CODEX_RATE_LIMIT_TEXT_PATTERNS`), so these are the phrasings `codex exec`
 * uses when it has no usable login or its refresh token has expired —
 * deliberately specific (a bare "401" or "token" also appears in ordinary
 * output).
 */
const CODEX_AUTH_TEXT_PATTERNS = [
  /\bnot logged in\b/i,
  /\bplease (?:log|sign) in again\b/i,
  /\brefresh token (?:has )?(?:expired|was already used|is invalid)\b/i,
  /\btoken_expired\b/,
  /\brefresh_token_(?:expired|reused|invalidated)\b/,
  /\b401 Unauthorized\b/i,
];

/** Codex's wording for a model id the account cannot use or that does not exist. */
const CODEX_UNKNOWN_MODEL_TEXT_PATTERNS = [
  /\bmodel_not_found\b/,
  /\bmodel [`'"]?[\w.:-]+[`'"]? does not exist\b/i,
  /\bunsupported model\b/i,
  /\bunknown model\b/i,
];

/**
 * Finds a failure no retry or handoff can fix. Structured fields are read
 * first (Claude's `SDKAssistantMessageError`, OpenRouter's HTTP status);
 * text only where the provider gives nothing else (Codex) or where the text
 * is this app's/SDK's own (a missing binary). Returns undefined when the
 * failure may well be fixed by waiting or by another backend.
 */
function detectFatalFailure(
  provider: LLMProvider,
  signal: { claudeSdkError?: string; message?: string },
): ProviderFatalFailureCause | undefined {
  const message = signal.message ?? '';
  if (message && CLI_MISSING_TEXT_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'cli_missing';
  }

  if (provider === 'claude') {
    return signal.claudeSdkError ? CLAUDE_FATAL_SDK_ERRORS[signal.claudeSdkError] : undefined;
  }

  if (provider === 'codex') {
    if (CODEX_AUTH_TEXT_PATTERNS.some((pattern) => pattern.test(message))) {
      return 'auth_required';
    }
    if (CODEX_UNKNOWN_MODEL_TEXT_PATTERNS.some((pattern) => pattern.test(message))) {
      return 'unknown_model';
    }
    return undefined;
  }

  if (provider === 'openrouter') {
    // `<service> request failed (<status>): …` — see the limit branch below.
    const status = message.match(/\b(?:openrouter|anthropic|openai) request failed \((\d+)\)/i)?.[1];
    if (status === '401' || /\b[A-Z_]+_API_KEY is not set on the server\b/.test(message)) {
      return 'auth_required';
    }
    if (status === '404' || (status === '400' && /\b(?:not a valid model|model_not_found|no endpoints found)\b/i.test(message))) {
      return 'unknown_model';
    }
    return undefined;
  }

  return undefined;
}

/**
 * Detects whether one provider's raw runtime error/event represents a
 * subscription or API rate limit rather than an ordinary failure.
 *
 * Used by the handoff module (`server/modules/handoff/`) to decide whether a
 * failed turn should trigger an automatic switch to a fallback backend, by
 * the orchestrator to tell a limit (pass the subtask on) from a failure no
 * backend can fix (`fatalCause`: mark it failed), by the chat gateway to
 * label such an error for the UI, and by its tests. Each provider's detection logic documents the exact field or
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
  // Fail fast: a missing CLI, a missing/expired sign-in or an unknown model
  // is reported as such even when the text also mentions a limit — moving
  // the session would only spend another backend's limit on a turn that
  // cannot succeed anywhere until the user fixes the setup.
  const fatalCause = detectFatalFailure(provider, signal);
  if (fatalCause) {
    return { detected: false, fatalCause };
  }

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
    // openrouter-runtime.provider.ts reports `<service> request failed (<status>): ...`
    // for any non-ok response, where <service> is the model's service prefix
    // (openrouter, anthropic, openai), so the status code is always in
    // parentheses — no need to guess from the response body's wording.
    const statusMatch = signal.message?.match(/\b(?:openrouter|anthropic|openai) request failed \((\d+)\)/i);
    if (statusMatch && statusMatch[1] === '429') {
      return { detected: true, reason: 'rate_limit' };
    }
    // 402 is "out of credits" (OpenRouter's documented status for a spent
    // balance): the key works but nothing more will be served until it is
    // topped up, which for the conversation is the same as a spent limit.
    if (statusMatch && statusMatch[1] === '402') {
      return { detected: true, reason: 'unknown_limit' };
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
