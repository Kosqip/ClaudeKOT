import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpenRouterProviderRouting,
  listFreeModelFallbacks,
  mergeLiveOpenRouterCatalog,
  OPENROUTER_PREDEFINED_MODELS,
  OpenRouterProviderModels,
} from '@/modules/providers/list/openrouter/openrouter-models.provider.js';
import type { ProviderModelsDefinition } from '@/shared/types.js';

const LIVE = [
  { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'vendor/new-model:free', name: 'New Model (free)' },
  { id: 'vendor/paid-model', name: 'Paid Model' },
];

test('the live catalog drops OpenRouter entries that no longer exist and moves the default to a live free model', () => {
  const catalog = mergeLiveOpenRouterCatalog(LIVE);
  const values = catalog.OPTIONS.map((option) => option.value);

  // The predefined free models are not in this live list: a session on them would fail.
  assert.equal(values.includes('google/gemma-4-31b-it:free'), false);
  assert.equal(values.includes('google/gemini-3.8-flash'), true);
  assert.equal(values.includes('vendor/new-model:free'), true);
  // Paid models are listed too, after the free ones.
  assert.equal(values.includes('vendor/paid-model'), true);
  assert.ok(values.indexOf('vendor/new-model:free') < values.indexOf('vendor/paid-model'));
  // The predefined Claude/GPT entries are plain OpenRouter ids (vendor/model,
  // no service prefix) like any other paid one here, so they are confirmed
  // against the live list the same way and dropped when it does not have them.
  assert.equal(values.includes('anthropic/claude-sonnet-5.5'), false);
  assert.equal(catalog.DEFAULT, 'vendor/new-model:free');
});

test('a predefined Claude/GPT entry (an OpenRouter id, not a direct-API one) survives when the live list still has it', () => {
  const catalog = mergeLiveOpenRouterCatalog([
    ...LIVE,
    { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5' },
  ]);
  const values = catalog.OPTIONS.map((option) => option.value);
  assert.equal(values.includes('anthropic/claude-opus-5.5'), true);
});

test('an empty or malformed live list leaves the predefined catalog untouched', () => {
  assert.equal(mergeLiveOpenRouterCatalog([]), OPENROUTER_PREDEFINED_MODELS);
  assert.equal(mergeLiveOpenRouterCatalog({ nope: true }), OPENROUTER_PREDEFINED_MODELS);
});

test('the live list is fetched once per hour, only with a key, and a failure falls back to the predefined catalog', async () => {
  let calls = 0;
  const okFetch = (async () => { calls += 1; return { ok: true, json: async () => ({ data: LIVE }) }; }) as unknown as typeof fetch;

  const withoutKey = new OpenRouterProviderModels(okFetch, () => false, () => true);
  assert.equal(await withoutKey.getSupportedModels(), OPENROUTER_PREDEFINED_MODELS);
  assert.equal(calls, 0);

  const withKey = new OpenRouterProviderModels(okFetch, () => true, () => true);
  assert.equal((await withKey.getSupportedModels()).DEFAULT, 'vendor/new-model:free');
  await withKey.getSupportedModels();
  assert.equal(calls, 1);
  assert.equal((await withKey.getCurrentActiveModel()).model, 'vendor/new-model:free');

  const failing = new OpenRouterProviderModels((async () => { throw new Error('offline'); }) as unknown as typeof fetch, () => true, () => true);
  assert.equal(await failing.getSupportedModels(), OPENROUTER_PREDEFINED_MODELS);
});

test('getSupportedModels hides any direct Anthropic/OpenAI entry its catalog contains until that service has a key', async () => {
  // None of the predefined entries use the "anthropic:"/"openai:" direct-API
  // prefix any more (see this module's doc comment), so this plants one
  // straight into OPENROUTER_PREDEFINED_MODELS' own shape via a live catalog
  // that mergeLiveOpenRouterCatalog leaves such an id in regardless of
  // content (direct ids are never checked against OpenRouter's own list —
  // see isOpenRouterEntry) — exercising the filter on the shape it is meant
  // to catch, independent of what ships by default today.
  const catalogWithDirectEntries: ProviderModelsDefinition = {
    OPTIONS: [...OPENROUTER_PREDEFINED_MODELS.OPTIONS, { value: 'anthropic:claude-opus-5-5', label: 'Direct Claude' }, { value: 'openai:gpt-5.5', label: 'Direct GPT' }],
    DEFAULT: OPENROUTER_PREDEFINED_MODELS.DEFAULT,
  };
  assert.deepEqual(mergeLiveOpenRouterCatalog([]), OPENROUTER_PREDEFINED_MODELS); // sanity: untouched by an empty live list

  const noFetch = (async () => { throw new Error('unused'); }) as unknown as typeof fetch;
  const withCatalog = (hasOpenRouterKey: boolean, hasDirect: (service: string) => boolean) => {
    const instance = new OpenRouterProviderModels(noFetch, () => hasOpenRouterKey, hasDirect);
    (instance as unknown as { cached: { catalog: ProviderModelsDefinition; until: number } }).cached = {
      catalog: catalogWithDirectEntries,
      until: Date.now() + 60_000,
    };
    return instance;
  };
  const values = async (hasDirect: (service: string) => boolean) =>
    (await withCatalog(true, hasDirect).getSupportedModels()).OPTIONS.map((option) => option.value);

  assert.equal((await values(() => false)).some((value) => value.startsWith('anthropic:') || value.startsWith('openai:')), false);
  const onlyOpenAi = await values((service) => service === 'openai');
  assert.equal(onlyOpenAi.includes('openai:gpt-5.5'), true);
  assert.equal(onlyOpenAi.some((value) => value.startsWith('anthropic:')), false);
});

test('the routing choice becomes OpenRouter\'s provider sort, and anything else leaves its default routing alone', () => {
  assert.deepEqual(buildOpenRouterProviderRouting('price'), { sort: 'price' });
  assert.deepEqual(buildOpenRouterProviderRouting('throughput'), { sort: 'throughput' });
  assert.deepEqual(buildOpenRouterProviderRouting('latency'), { sort: 'latency' });
  assert.equal(buildOpenRouterProviderRouting('default'), undefined);
  assert.equal(buildOpenRouterProviderRouting(undefined), undefined);
  assert.equal(buildOpenRouterProviderRouting({ sort: 'price' }), undefined);
});

test('only a free model gets free stand-ins', () => {
  const free = listFreeModelFallbacks(OPENROUTER_PREDEFINED_MODELS.DEFAULT, OPENROUTER_PREDEFINED_MODELS);
  assert.equal(free[0], OPENROUTER_PREDEFINED_MODELS.DEFAULT);
  assert.ok(free.length > 1 && free.every((model) => model.endsWith(':free')));
  assert.deepEqual(listFreeModelFallbacks('google/gemini-3.8-flash', OPENROUTER_PREDEFINED_MODELS), ['google/gemini-3.8-flash']);
});
