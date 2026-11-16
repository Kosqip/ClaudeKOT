import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyProviderTurnOutcome } from '@/modules/providers/services/provider-limit-detection.service.js';

test('claude: a rejected rate-limit window is detected with its specific reason', () => {
  const result = classifyProviderTurnOutcome('claude', {
    claudeRateLimitInfo: { status: 'rejected', rateLimitType: 'five_hour' },
  });
  assert.deepEqual(result, { kind: 'limit', reason: 'five_hour', resetsAt: undefined });
});

test('claude: a rejected window reports resetsAt as an ISO string when given', () => {
  const resetsAt = Date.UTC(2026, 0, 1, 12, 0, 0);
  const result = classifyProviderTurnOutcome('claude', {
    claudeRateLimitInfo: { status: 'rejected', rateLimitType: 'seven_day', resetsAt },
  });
  assert.deepEqual(result, { kind: 'limit', reason: 'seven_day', resetsAt: new Date(resetsAt).toISOString() });
});

test('claude: an allowed or warning rate-limit status is not a limit hit', () => {
  assert.deepEqual(classifyProviderTurnOutcome('claude', { claudeRateLimitInfo: { status: 'allowed' } }), { kind: 'none' });
  assert.deepEqual(classifyProviderTurnOutcome('claude', { claudeRateLimitInfo: { status: 'allowed_warning' } }), { kind: 'none' });
});

test('claude: the rate_limit assistant-message error literal is detected without a window', () => {
  assert.deepEqual(classifyProviderTurnOutcome('claude', { claudeSdkError: 'rate_limit' }), { kind: 'limit', reason: 'rate_limit' });
});

test('claude: an unrelated assistant-message error is not a limit hit', () => {
  assert.deepEqual(classifyProviderTurnOutcome('claude', { claudeSdkError: 'server_error' }), { kind: 'transient' });
  // Not a limit either — but fatal, so reported with its cause (see the fail-fast tests below).
  assert.deepEqual(classifyProviderTurnOutcome('claude', { claudeSdkError: 'authentication_failed' }), { kind: 'fatal', cause: 'auth_required' });
  assert.deepEqual(classifyProviderTurnOutcome('claude', {}), { kind: 'none' });
});

test('claude: an unrecognized rate-limit window falls back to the generic reason', () => {
  const result = classifyProviderTurnOutcome('claude', {
    claudeRateLimitInfo: { status: 'rejected', rateLimitType: 'overage' },
  });
  assert.deepEqual(result, { kind: 'limit', reason: 'rate_limit', resetsAt: undefined });
});

test('codex: usage/rate-limit phrasing in the free-text error message is detected', () => {
  assert.deepEqual(classifyProviderTurnOutcome('codex', { message: 'Rate limit exceeded, please retry later' }), { kind: 'limit', reason: 'unknown_limit' });
  assert.deepEqual(classifyProviderTurnOutcome('codex', { message: 'You have hit your usage limit for this plan' }), { kind: 'limit', reason: 'unknown_limit' });
  assert.deepEqual(classifyProviderTurnOutcome('codex', { message: 'Request failed with status 429' }), { kind: 'limit', reason: 'unknown_limit' });
});

test('codex: an unrelated error message is not a limit hit', () => {
  assert.deepEqual(classifyProviderTurnOutcome('codex', { message: 'Codex Exec exited with code 1: invalid model name' }), { kind: 'none' });
  assert.deepEqual(classifyProviderTurnOutcome('codex', {}), { kind: 'none' });
});

test('openrouter: a 429 status embedded in the thrown error message is detected', () => {
  const result = classifyProviderTurnOutcome('openrouter', {
    message: 'OpenRouter request failed (429): {"error":{"code":429,"message":"Rate limited"}}',
  });
  assert.deepEqual(result, { kind: 'limit', reason: 'rate_limit' });
});

test('openrouter: a non-429 status is not a limit hit', () => {
  assert.deepEqual(classifyProviderTurnOutcome('openrouter', { message: 'OpenRouter request failed (500): internal error' }), { kind: 'transient' });
  assert.deepEqual(classifyProviderTurnOutcome('openrouter', { message: 'OpenRouter request failed (401): invalid key' }), { kind: 'fatal', cause: 'auth_required' });
});

test('cursor and opencode have no known limit signal and always report not detected', () => {
  assert.deepEqual(classifyProviderTurnOutcome('cursor', { message: 'rate limit quota 429' }), { kind: 'none' });
  assert.deepEqual(classifyProviderTurnOutcome('opencode', { message: 'rate limit quota 429' }), { kind: 'none' });
});

test('the API provider limit is recognised for each service the runtime actually names', () => {
  // The runtime builds this text from the model's service prefix, lowercase.
  for (const service of ['openrouter', 'anthropic', 'openai']) {
    assert.deepEqual(
      classifyProviderTurnOutcome('openrouter', { message: `${service} request failed (429): slow down` }),
      { kind: 'limit', reason: 'rate_limit' },
      service,
    );
    assert.deepEqual(
      classifyProviderTurnOutcome('openrouter', { message: `${service} request failed (500): boom` }),
      { kind: 'transient' },
      service,
    );
  }
});

test('codex: text that merely mentions a quota or the number 429 is not a limit', () => {
  assert.deepEqual(classifyProviderTurnOutcome('codex', { message: 'ENOENT: no such file src/quota/429.ts' }), { kind: 'none' });
  assert.deepEqual(classifyProviderTurnOutcome('codex', { message: 'Test failed at line 429' }), { kind: 'none' });
});

test('codex: its own limit wordings are detected', () => {
  for (const message of ['usageLimitExceeded', 'Too Many Requests', 'insufficient_quota', 'Quota exceeded for this workspace']) {
    assert.deepEqual(classifyProviderTurnOutcome('codex', { message }), { kind: 'limit', reason: 'unknown_limit' }, message);
  }
});

test('openrouter: a 402 (balance spent) is treated as a limit', () => {
  assert.deepEqual(
    classifyProviderTurnOutcome('openrouter', { message: 'openrouter request failed (402): Insufficient credits' }),
    { kind: 'limit', reason: 'unknown_limit' },
  );
});

// ---- Fail fast: failures no retry or other backend can fix ----

test('claude: structured sign-in and unknown-model errors are fatal, not limits', () => {
  assert.deepEqual(classifyProviderTurnOutcome('claude', { claudeSdkError: 'authentication_failed' }), { kind: 'fatal', cause: 'auth_required' });
  assert.deepEqual(classifyProviderTurnOutcome('claude', { claudeSdkError: 'oauth_org_not_allowed' }), { kind: 'fatal', cause: 'auth_required' });
  assert.deepEqual(classifyProviderTurnOutcome('claude', { claudeSdkError: 'model_not_found' }), { kind: 'fatal', cause: 'unknown_model' });
});

test('claude: overloaded and server errors are transient; account errors are neither a limit nor fatal', () => {
  for (const code of ['overloaded', 'server_error']) {
    assert.deepEqual(classifyProviderTurnOutcome('claude', { claudeSdkError: code }), { kind: 'transient' });
  }
  for (const code of ['billing_error', 'unknown']) {
    assert.deepEqual(classifyProviderTurnOutcome('claude', { claudeSdkError: code }), { kind: 'none' });
  }
});

test('a dropped connection is transient for any provider, and a fatal or limit signal still wins', () => {
  assert.deepEqual(classifyProviderTurnOutcome('codex', { message: 'stream error: read ECONNRESET' }), { kind: 'transient' });
  assert.deepEqual(classifyProviderTurnOutcome('cursor', { message: 'socket hang up' }), { kind: 'transient' });
  assert.deepEqual(classifyProviderTurnOutcome('openrouter', { message: 'openrouter request failed (408): timeout' }), { kind: 'transient' });
  assert.deepEqual(classifyProviderTurnOutcome('codex', { message: 'usage limit reached (ECONNRESET on retry)' }), { kind: 'limit', reason: 'unknown_limit' });
  assert.deepEqual(classifyProviderTurnOutcome('codex', { message: 'Not logged in (ETIMEDOUT)' }), { kind: 'fatal', cause: 'auth_required' });
});

test('claude: the sign-in wording alone is not read when the structured code is absent', () => {
  assert.deepEqual(classifyProviderTurnOutcome('claude', { message: 'Invalid API key · Please run /login' }), { kind: 'none' });
});

test('a missing CLI binary is fatal for every provider', () => {
  assert.deepEqual(
    classifyProviderTurnOutcome('claude', { message: 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code' }),
    { kind: 'fatal', cause: 'cli_missing' },
  );
  assert.deepEqual(
    classifyProviderTurnOutcome('claude', { message: 'Claude Code executable not found at /usr/bin/claude. Is options.pathToClaudeCodeExecutable set?' }),
    { kind: 'fatal', cause: 'cli_missing' },
  );
  assert.deepEqual(classifyProviderTurnOutcome('codex', { message: 'spawn codex ENOENT' }), { kind: 'fatal', cause: 'cli_missing' });
  assert.deepEqual(classifyProviderTurnOutcome('codex', { message: 'Codex CLI is not installed. Install it first: npm install -g @openai/codex' }), { kind: 'fatal', cause: 'cli_missing' });
  assert.deepEqual(classifyProviderTurnOutcome('opencode', { message: 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/' }), { kind: 'fatal', cause: 'cli_missing' });
});

test('codex: an expired or missing sign-in is fatal even when the text also mentions a limit', () => {
  assert.deepEqual(
    classifyProviderTurnOutcome('codex', { message: 'Your refresh token has expired. Please log in again.' }),
    { kind: 'fatal', cause: 'auth_required' },
  );
  assert.deepEqual(
    classifyProviderTurnOutcome('codex', { message: 'unexpected status 401 Unauthorized (rate limit headers missing)' }),
    { kind: 'fatal', cause: 'auth_required' },
  );
});

test('codex: an unknown model is fatal', () => {
  assert.deepEqual(
    classifyProviderTurnOutcome('codex', { message: 'The model `gpt-9` does not exist or you do not have access to it.' }),
    { kind: 'fatal', cause: 'unknown_model' },
  );
});

test('codex: a real usage limit is still a limit', () => {
  assert.deepEqual(
    classifyProviderTurnOutcome('codex', { message: "You've hit your usage limit. Try again in 3 hours." }),
    { kind: 'limit', reason: 'unknown_limit' },
  );
});

test('openrouter: a rejected key or an unknown model is fatal, a 429 is a limit', () => {
  assert.deepEqual(classifyProviderTurnOutcome('openrouter', { message: 'openrouter request failed (401): No auth credentials found' }), { kind: 'fatal', cause: 'auth_required' });
  assert.deepEqual(classifyProviderTurnOutcome('openrouter', { message: 'OPENROUTER_API_KEY is not set on the server.' }), { kind: 'fatal', cause: 'auth_required' });
  assert.deepEqual(classifyProviderTurnOutcome('openrouter', { message: 'openrouter request failed (400): foo/bar is not a valid model ID' }), { kind: 'fatal', cause: 'unknown_model' });
  assert.deepEqual(classifyProviderTurnOutcome('openrouter', { message: 'openrouter request failed (429): slow down' }), { kind: 'limit', reason: 'rate_limit' });
});
