import assert from 'node:assert/strict';
import test from 'node:test';

import { detectProviderLimit } from '@/modules/providers/services/provider-limit-detection.service.js';

test('claude: a rejected rate-limit window is detected with its specific reason', () => {
  const result = detectProviderLimit('claude', {
    claudeRateLimitInfo: { status: 'rejected', rateLimitType: 'five_hour' },
  });
  assert.deepEqual(result, { detected: true, reason: 'five_hour', resetsAt: undefined });
});

test('claude: a rejected window reports resetsAt as an ISO string when given', () => {
  const resetsAt = Date.UTC(2026, 0, 1, 12, 0, 0);
  const result = detectProviderLimit('claude', {
    claudeRateLimitInfo: { status: 'rejected', rateLimitType: 'seven_day', resetsAt },
  });
  assert.deepEqual(result, { detected: true, reason: 'seven_day', resetsAt: new Date(resetsAt).toISOString() });
});

test('claude: an allowed or warning rate-limit status is not a limit hit', () => {
  assert.deepEqual(detectProviderLimit('claude', { claudeRateLimitInfo: { status: 'allowed' } }), { detected: false });
  assert.deepEqual(detectProviderLimit('claude', { claudeRateLimitInfo: { status: 'allowed_warning' } }), { detected: false });
});

test('claude: the rate_limit assistant-message error literal is detected without a window', () => {
  assert.deepEqual(detectProviderLimit('claude', { claudeSdkError: 'rate_limit' }), { detected: true, reason: 'rate_limit' });
});

test('claude: an unrelated assistant-message error is not a limit hit', () => {
  assert.deepEqual(detectProviderLimit('claude', { claudeSdkError: 'server_error' }), { detected: false });
  assert.deepEqual(detectProviderLimit('claude', { claudeSdkError: 'authentication_failed' }), { detected: false });
  assert.deepEqual(detectProviderLimit('claude', {}), { detected: false });
});

test('claude: an unrecognized rate-limit window falls back to the generic reason', () => {
  const result = detectProviderLimit('claude', {
    claudeRateLimitInfo: { status: 'rejected', rateLimitType: 'overage' },
  });
  assert.deepEqual(result, { detected: true, reason: 'rate_limit', resetsAt: undefined });
});

test('codex: usage/rate-limit phrasing in the free-text error message is detected', () => {
  assert.deepEqual(detectProviderLimit('codex', { message: 'Rate limit exceeded, please retry later' }), { detected: true, reason: 'unknown_limit' });
  assert.deepEqual(detectProviderLimit('codex', { message: 'You have hit your usage limit for this plan' }), { detected: true, reason: 'unknown_limit' });
  assert.deepEqual(detectProviderLimit('codex', { message: 'Request failed with status 429' }), { detected: true, reason: 'unknown_limit' });
});

test('codex: an unrelated error message is not a limit hit', () => {
  assert.deepEqual(detectProviderLimit('codex', { message: 'Codex Exec exited with code 1: invalid model name' }), { detected: false });
  assert.deepEqual(detectProviderLimit('codex', {}), { detected: false });
});

test('openrouter: a 429 status embedded in the thrown error message is detected', () => {
  const result = detectProviderLimit('openrouter', {
    message: 'OpenRouter request failed (429): {"error":{"code":429,"message":"Rate limited"}}',
  });
  assert.deepEqual(result, { detected: true, reason: 'rate_limit' });
});

test('openrouter: a non-429 status is not a limit hit', () => {
  assert.deepEqual(detectProviderLimit('openrouter', { message: 'OpenRouter request failed (500): internal error' }), { detected: false });
  assert.deepEqual(detectProviderLimit('openrouter', { message: 'OpenRouter request failed (401): invalid key' }), { detected: false });
});

test('cursor and opencode have no known limit signal and always report not detected', () => {
  assert.deepEqual(detectProviderLimit('cursor', { message: 'rate limit quota 429' }), { detected: false });
  assert.deepEqual(detectProviderLimit('opencode', { message: 'rate limit quota 429' }), { detected: false });
});

test('the API provider limit is recognised for each service the runtime actually names', () => {
  // The runtime builds this text from the model's service prefix, lowercase.
  for (const service of ['openrouter', 'anthropic', 'openai']) {
    assert.deepEqual(
      detectProviderLimit('openrouter', { message: `${service} request failed (429): slow down` }),
      { detected: true, reason: 'rate_limit' },
      service,
    );
    assert.deepEqual(
      detectProviderLimit('openrouter', { message: `${service} request failed (500): boom` }),
      { detected: false },
      service,
    );
  }
});
