import type { IProviderModels } from '@/shared/interfaces.js';
import type { ProviderCurrentActiveModel, ProviderModelsDefinition } from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';

/**
 * Curated catalog shipped as immutable CloudCLI defaults for the
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

/** Provider registry model adapter for the `openrouter` provider's predefined catalog. */
export class OpenRouterProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return OPENROUTER_PREDEFINED_MODELS;
  }

  /**
   * None of the three services has a local process or session file to read
   * a running model back from — the app-recorded session model (set when
   * the user picks one) is always authoritative, so this only ever supplies
   * the catalog default.
   */
  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(OPENROUTER_PREDEFINED_MODELS);
  }
}
