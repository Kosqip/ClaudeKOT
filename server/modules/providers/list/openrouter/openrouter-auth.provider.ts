import type { IProviderAuth } from '@/shared/interfaces.js';
import type { CliVersionProbe, ProviderAuthStatus } from '@/shared/types.js';

/** Name of the environment variable that carries the OpenRouter API key. */
export const OPENROUTER_API_KEY_ENV_VAR = 'OPENROUTER_API_KEY';

/** Reads the configured OpenRouter API key, or null when none is set. */
export function readOpenRouterApiKey(): string | null {
  const value = process.env[OPENROUTER_API_KEY_ENV_VAR];
  return value && value.trim() ? value.trim() : null;
}

/**
 * Auth adapter for OpenRouter.
 *
 * OpenRouter is a plain HTTP API, not a local CLI: there is nothing to
 * install and no login flow, so "installed" is always true and
 * "authenticated" reflects only whether `OPENROUTER_API_KEY` is configured.
 */
export class OpenRouterProviderAuth implements IProviderAuth {
  checkInstalled(): CliVersionProbe {
    return { installed: true, exitCode: 0, version: null };
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const apiKey = readOpenRouterApiKey();

    return {
      installed: true,
      provider: 'openrouter',
      installedVersion: null,
      authenticated: Boolean(apiKey),
      email: null,
      method: apiKey ? 'api_key' : null,
      error: apiKey ? undefined : `${OPENROUTER_API_KEY_ENV_VAR} is not set.`,
    };
  }
}
