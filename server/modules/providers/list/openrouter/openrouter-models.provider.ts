import type { IProviderModels } from '@/shared/interfaces.js';
import type { ProviderCurrentActiveModel, ProviderModelsDefinition } from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';

/**
 * Curated OpenRouter catalog shipped as immutable CloudCLI defaults.
 *
 * OpenRouter's own catalog (https://openrouter.ai/models) is far larger than
 * any other provider's; this list is only a starting point so the model
 * picker is never empty. Users add any other `<vendor>/<model>` id from the
 * OpenRouter catalog, including free-tier models, as a custom model through
 * the same model-library flow every other provider uses.
 */
export const OPENROUTER_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'meta-llama/llama-3.1-8b-instruct:free',
      label: 'Llama 3.1 8B Instruct (free)',
      description: 'Free-tier OpenRouter model, good for routine/low-stakes tasks.',
    },
    {
      value: 'mistralai/mistral-7b-instruct:free',
      label: 'Mistral 7B Instruct (free)',
      description: 'Free-tier OpenRouter model.',
    },
    {
      value: 'google/gemini-2.0-flash-001',
      label: 'Gemini 2.0 Flash',
      description: 'Fast, low-cost Google model via OpenRouter.',
    },
    {
      value: 'anthropic/claude-sonnet-5',
      label: 'Claude Sonnet 5 (OpenRouter)',
      description: 'Anthropic model billed through an OpenRouter API key instead of a subscription.',
    },
    {
      value: 'openai/gpt-5.5',
      label: 'GPT-5.5 (OpenRouter)',
      description: 'OpenAI model billed through an OpenRouter API key.',
    },
  ],
  DEFAULT: 'meta-llama/llama-3.1-8b-instruct:free',
};

/** Provider registry model adapter for OpenRouter's predefined catalog. */
export class OpenRouterProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return OPENROUTER_PREDEFINED_MODELS;
  }

  /**
   * OpenRouter has no local process or session file to read a running model
   * back from — the app-recorded session model (set when the user picks one)
   * is always authoritative, so this only ever supplies the catalog default.
   */
  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(OPENROUTER_PREDEFINED_MODELS);
  }
}
