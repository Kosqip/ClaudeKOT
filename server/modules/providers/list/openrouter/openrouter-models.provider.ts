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
      value: 'meta-llama/llama-3.1-8b-instruct:free',
      label: 'Llama 3.1 8B Instruct (free, OpenRouter)',
      description: 'Free-tier OpenRouter model, good for routine/low-stakes tasks.',
    },
    {
      value: 'mistralai/mistral-7b-instruct:free',
      label: 'Mistral 7B Instruct (free, OpenRouter)',
      description: 'Free-tier OpenRouter model.',
    },
    {
      value: 'google/gemini-2.0-flash-001',
      label: 'Gemini 2.0 Flash (OpenRouter)',
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
      value: 'openai:gpt-5.1',
      label: 'GPT-5.1 (direct OpenAI API)',
      description: 'Billed per token on OPENAI_DIRECT_API_KEY.',
    },
    {
      value: 'openai:gpt-5.1-mini',
      label: 'GPT-5.1 mini (direct OpenAI API)',
      description: 'Billed per token on OPENAI_DIRECT_API_KEY, cheaper/faster than the full model.',
    },
  ],
  DEFAULT: 'meta-llama/llama-3.1-8b-instruct:free',
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
    private readonly fetchImpl: typeof fetch = fetch,
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
