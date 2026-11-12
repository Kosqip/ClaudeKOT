import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeLiveOpenRouterCatalog,
  OPENROUTER_PREDEFINED_MODELS,
  OpenRouterProviderModels,
} from '@/modules/providers/list/openrouter/openrouter-models.provider.js';

const LIVE = [
  { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash' },
  { id: 'vendor/new-model:free', name: 'New Model (free)' },
  { id: 'vendor/paid-model', name: 'Paid Model' },
];

test('the live catalog drops OpenRouter entries that no longer exist and moves the default to a live free model', () => {
  const catalog = mergeLiveOpenRouterCatalog(LIVE);
  const values = catalog.OPTIONS.map((option) => option.value);

  // The predefined free models are not in this live list: a session on them would fail.
  assert.equal(values.includes('meta-llama/llama-3.1-8b-instruct:free'), false);
  assert.equal(values.includes('google/gemini-2.0-flash-001'), true);
  assert.equal(values.includes('vendor/new-model:free'), true);
  assert.equal(values.includes('vendor/paid-model'), false);
  // Direct Anthropic/OpenAI entries are not OpenRouter's to confirm and stay.
  assert.equal(values.includes('anthropic:claude-sonnet-5-5'), true);
  assert.equal(catalog.DEFAULT, 'vendor/new-model:free');
});

test('an empty or malformed live list leaves the predefined catalog untouched', () => {
  assert.equal(mergeLiveOpenRouterCatalog([]), OPENROUTER_PREDEFINED_MODELS);
  assert.equal(mergeLiveOpenRouterCatalog({ nope: true }), OPENROUTER_PREDEFINED_MODELS);
});

test('the live list is fetched once per hour, only with a key, and a failure falls back to the predefined catalog', async () => {
  let calls = 0;
  const okFetch = (async () => { calls += 1; return { ok: true, json: async () => ({ data: LIVE }) }; }) as unknown as typeof fetch;

  const withoutKey = new OpenRouterProviderModels(okFetch, () => false);
  assert.equal(await withoutKey.getSupportedModels(), OPENROUTER_PREDEFINED_MODELS);
  assert.equal(calls, 0);

  const withKey = new OpenRouterProviderModels(okFetch, () => true);
  assert.equal((await withKey.getSupportedModels()).DEFAULT, 'vendor/new-model:free');
  await withKey.getSupportedModels();
  assert.equal(calls, 1);
  assert.equal((await withKey.getCurrentActiveModel()).model, 'vendor/new-model:free');

  const failing = new OpenRouterProviderModels((async () => { throw new Error('offline'); }) as unknown as typeof fetch, () => true);
  assert.equal(await failing.getSupportedModels(), OPENROUTER_PREDEFINED_MODELS);
});
