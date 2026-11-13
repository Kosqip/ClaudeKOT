import { listServiceEnvVarNames } from '@/modules/providers/list/openrouter/openrouter-service-registry.js';
import { readCustomApiKey } from '@/modules/providers/list/openrouter/services/custom-api-key-store.service.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { CliVersionProbe, ProviderAuthStatus } from '@/shared/types.js';

const SERVICE_DISPLAY_NAME: Record<string, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic (direct)',
  openai: 'OpenAI (direct)',
};

/**
 * Auth adapter for the `openrouter` provider's now-generalized HTTP backend.
 *
 * It is a plain HTTP API, not a local CLI: there is nothing to install and
 * no login flow, so "installed" is always true. "authenticated" is true as
 * soon as any one of the three services' API keys
 * (`OPENROUTER_API_KEY`/`ANTHROPIC_DIRECT_API_KEY`/`OPENAI_DIRECT_API_KEY`)
 * is configured — a session only needs the one key for whichever service its
 * model string selects, not all three. `getStatus()` reports which services
 * are actually configured through `email` (reusing the field the UI already
 * renders as "Logged in as ...") so a user with, say, only an Anthropic key
 * can tell at a glance that OpenAI-service models will not work yet, without
 * the `error` field (rendered as a hard failure) firing while at least one
 * service does work.
 */
export class OpenRouterProviderAuth implements IProviderAuth {
  checkInstalled(): CliVersionProbe {
    return { installed: true, exitCode: 0, version: null };
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const services = listServiceEnvVarNames().map(({ service, envVarName }) => ({
      service,
      envVarName,
      configured: Boolean(readCustomApiKey(service)),
    }));
    const configuredServices = services.filter((entry) => entry.configured);

    if (configuredServices.length === 0) {
      return {
        installed: true,
        provider: 'openrouter',
        installedVersion: null,
        authenticated: false,
        email: null,
        method: null,
        error: `None of ${services.map((entry) => entry.envVarName).join(', ')} are set.`,
      };
    }

    return {
      installed: true,
      provider: 'openrouter',
      installedVersion: null,
      authenticated: true,
      email: configuredServices.map((entry) => SERVICE_DISPLAY_NAME[entry.service]).join(', '),
      method: 'api_key',
    };
  }
}
