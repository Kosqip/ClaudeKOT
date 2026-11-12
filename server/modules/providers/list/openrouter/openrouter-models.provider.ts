import type { IProviderModels } from '@/shared/interfaces.js';
import type { ProviderCurrentActiveModel, ProviderModelsDefinition } from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';

/**
 * Curated catalog shipped as built-in defaults for the
 * `openrouter` provider's three API services.
 *
 * A bare id with no `<service>:` prefix (OpenRouter's own catalog format,
 * e.g. `meta-llama/llama-3.1-8b-instruct:free`) is always read as an
 * OpenRouter model — see `parseModelReference` in
 * `openrouter-service-registry.ts`. `anthropic:`/`openai:` prefixed ids
 * route to the direct Anthropic/OpenAI API services instead of a
 * subscription or OpenRouter. OpenRouter's own catalog
 * (https://openrouter.ai/models) is far larger than any other provider's;
 * this list is only a starting point for all three services — users add any
 * other id, prefixed or not, as a custom model through the same
 * model-library flow every other provider uses.
 */
export const OPENROUTER_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'google/gemma-4-31b-it:free',
      label: 'Gemma 4 31B (free, OpenRouter)',
      description: 'Free-tier OpenRouter model, good for routine/low-stakes tasks.',
    },
    {
      value: 'google/gemma-4-26b-a4b-it:free',
      label: 'Gemma 4 26B (free, OpenRouter)',
      description: 'Free-tier OpenRouter model.',
    },
    {
      value: 'baidu/ernie-5.5-flash-preview:free',
      label: 'ERNIE 5.5 Flash (free, OpenRouter)',
      description: 'Free-tier OpenRouter model.',
    },
    {
      value: 'google/gemini-3.8-flash',
      label: 'Gemini 3.8 Flash (OpenRouter)',
      description: 'Fast, low-cost Google model via OpenRouter.',
    },
    {
      value: 'anthropic:claude-opus-5-5',
      label: 'Claude Opus 5.5 (direct Anthropic API)',
      description: 'Billed per token on ANTHROPIC_DIRECT_API_KEY — not the Claude Code subscription.',
    },
    {
      value: 'anthropic:claude-sonnet-5-5',
      label: 'Claude Sonnet 5.5 (direct Anthropic API)',
      description: 'Billed per token on ANTHROPIC_DIRECT_API_KEY — not the Claude Code subscription.',
    },
    {
      value: 'openai:gpt-5.5',
      label: 'GPT-5.5 (direct OpenAI API)',
      description: 'Billed per token on OPENAI_DIRECT_API_KEY.',
    },
    {
      value: 'openai:gpt-5.4-mini',
      label: 'GPT-5.4 mini (direct OpenAI API)',
      description: 'Billed per token on OPENAI_DIRECT_API_KEY, cheaper/faster than the full model.',
    },
  ],
  DEFAULT: 'google/gemma-4-31b-it:free',
};

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const LIVE_CATALOG_TTL_MS = 60 * 60 * 1000;
const LIVE_CATALOG_RETRY_MS = 5 * 60 * 1000;
const LIVE_CATALOG_TIMEOUT_MS = 4000;
const MAX_LIVE_FREE_MODELS = 20;

/** True for a catalog entry that names a model on OpenRouter itself, not a direct Anthropic/OpenAI one. */
function isOpenRouterEntry(value: string): boolean {
  return !value.startsWith('anthropic:') && !value.startsWith('openai:');
}

/**
 * Builds the catalog from OpenRouter's own current model list (the `data`
 * array of `GET /api/v1/models`): its free models first, then the predefined
 * OpenRouter entries that still exist there, then the direct-API entries
 * untouched. OpenRouter retires and renames free models often, so a fixed
 * list goes stale and a session started on a retired id fails with "model
 * not found"; an entry OpenRouter no longer lists is therefore dropped, and
 * the default moves to the first free model when the predefined one is gone.
 *
 * Exported for this module's tests.
 */
export function mergeLiveOpenRouterCatalog(liveModels: unknown): ProviderModelsDefinition {
  const live = Array.isArray(liveModels)
    ? liveModels.filter((model): model is { id: string; name?: unknown } =>
      Boolean(model) && typeof (model as { id?: unknown }).id === 'string')
    : [];
  if (live.length === 0) {
    return OPENROUTER_PREDEFINED_MODELS;
  }

  const liveIds = new Set(live.map((model) => model.id));
  const kept = OPENROUTER_PREDEFINED_MODELS.OPTIONS.filter((option) =>
    !isOpenRouterEntry(option.value) || liveIds.has(option.value));
  const keptIds = new Set(kept.map((option) => option.value));
  const free = live
    .filter((model) => model.id.endsWith(':free') && !keptIds.has(model.id))
    .slice(0, MAX_LIVE_FREE_MODELS)
    .map((model) => ({
      value: model.id,
      label: `${typeof model.name === 'string' && model.name ? model.name : model.id} (OpenRouter)`,
      description: 'Free-tier OpenRouter model, from OpenRouter\'s current list.',
    }));

  const options = [
    ...kept.filter((option) => isOpenRouterEntry(option.value)),
    ...free,
    ...kept.filter((option) => !isOpenRouterEntry(option.value)),
  ];
  const defaultStillListed = liveIds.has(OPENROUTER_PREDEFINED_MODELS.DEFAULT);
  const firstFree = options.find((option) => option.value.endsWith(':free'));
  return {
    OPTIONS: options,
    DEFAULT: defaultStillListed ? OPENROUTER_PREDEFINED_MODELS.DEFAULT : firstFree?.value ?? OPENROUTER_PREDEFINED_MODELS.DEFAULT,
  };
}

/**
 * Provider registry model adapter for the `openrouter` provider. With an
 * OpenRouter key configured the catalog follows OpenRouter's current model
 * list (public endpoint, refreshed hourly, no key sent); without one, or
 * when the list cannot be fetched, it is the predefined catalog.
 */
export class OpenRouterProviderModels implements IProviderModels {
  private cached: { catalog: ProviderModelsDefinition; until: number } | null = null;

  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
    private readonly hasOpenRouterKey: () => boolean = () => Boolean(process.env.OPENROUTER_API_KEY),
  ) {}

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    if (!this.hasOpenRouterKey()) {
      return OPENROUTER_PREDEFINED_MODELS;
    }
    if (this.cached && this.cached.until > Date.now()) {
      return this.cached.catalog;
    }

    try {
      const response = await this.fetchImpl(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(LIVE_CATALOG_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      const body = await response.json() as { data?: unknown };
      this.cached = { catalog: mergeLiveOpenRouterCatalog(body.data), until: Date.now() + LIVE_CATALOG_TTL_MS };
    } catch {
      // Offline or blocked: keep working from the predefined list and retry later.
      this.cached = { catalog: OPENROUTER_PREDEFINED_MODELS, until: Date.now() + LIVE_CATALOG_RETRY_MS };
    }
    return this.cached.catalog;
  }

  /**
   * None of the three services has a local process or session file to read
   * a running model back from — the app-recorded session model (set when
   * the user picks one) is always authoritative, so this only ever supplies
   * the catalog default.
   */
  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}

/** How many models one free-tier request names: the chosen one plus stand-ins. OpenRouter accepts three. */
const MAX_FREE_MODELS_PER_REQUEST = 3;

/**
 * The models a request for a free OpenRouter model should name: the chosen
 * one first, then other free models from the catalog as stand-ins. Free
 * models are refused upstream all the time ("temporarily rate-limited",
 * "no endpoints available"); given a list, OpenRouter itself moves on to the
 * next one instead of failing the turn. A paid or direct-API model gets no
 * stand-ins — silently answering from a different model there would be wrong.
 */
export function listFreeModelFallbacks(modelId: string, catalog: ProviderModelsDefinition): string[] {
  if (!modelId.endsWith(':free')) {
    return [modelId];
  }
  const others = catalog.OPTIONS
    .map((option) => option.value)
    .filter((value) => value.endsWith(':free') && isOpenRouterEntry(value) && value !== modelId);
  return [modelId, ...others].slice(0, MAX_FREE_MODELS_PER_REQUEST);
}

const PROVIDER_SORTS = ['price', 'throughput', 'latency'] as const;

/**
 * OpenRouter's `provider` request field for the user's routing choice
 * (`openRouterProviderSort` preference). One model is usually sold by
 * several hosting providers at different prices and speeds; left alone,
 * OpenRouter spreads requests across them by its own balance of price,
 * speed and reliability. `price`, `throughput` and `latency` make it try
 * providers strictly in that order instead — cheapest first, fastest output
 * first, or quickest to start answering first — still moving on to the next
 * provider when one fails. Anything else returns `undefined`: OpenRouter's
 * default routing, no field sent.
 */
export function buildOpenRouterProviderRouting(sort: unknown): { sort: string } | undefined {
  return (PROVIDER_SORTS as readonly unknown[]).includes(sort) ? { sort: sort as string } : undefined;
}

/**
 * The one catalog instance shared by the provider's model adapter and its
 * runtime, so a turn started without a model (a session opened by the task
 * router, the orchestrator or a handoff rather than from the model picker)
 * runs on the same default the picker would show.
 */
export const openRouterProviderModels = new OpenRouterProviderModels();
