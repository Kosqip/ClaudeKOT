import { appConfigDb } from '@/modules/database/index.js';
import type { ApiService } from '@/modules/providers/list/openrouter/openrouter-service-registry.js';
import { listServiceEnvVarNames } from '@/modules/providers/list/openrouter/openrouter-service-registry.js';

/**
 * Where a Custom API service's key is set: typed into Settings (`ui`), the
 * server's `.env` file (`env`), or neither (`none`). Shown in the settings
 * UI and the diagnostics report — never the key value itself.
 */
export type CustomApiKeySource = 'ui' | 'env' | 'none';

function configKey(service: ApiService): string {
  return `custom_api_key:${service}`;
}

/**
 * Reads one service's API key: a key saved through Settings
 * (`writeCustomApiKey`) takes priority, since it is the one the user set
 * most recently and most deliberately; the server's own `.env` is the
 * fallback, kept for installs that configured it that way before this
 * existed. Used by each service's `ChatServiceAdapter.readApiKey` in place
 * of reading `process.env` directly, and by `openrouter-auth.provider.ts`
 * and `openrouter-models.provider.ts` to decide whether a service is usable.
 */
export function readCustomApiKey(service: ApiService): string | null {
  const stored = appConfigDb.get(configKey(service))?.trim();
  if (stored) {
    return stored;
  }
  const envVarName = listServiceEnvVarNames().find((entry) => entry.service === service)?.envVarName;
  const fromEnv = envVarName ? process.env[envVarName]?.trim() : undefined;
  return fromEnv || null;
}

/**
 * Saves or clears one service's API key from Settings. An empty/whitespace
 * value clears the stored key (falling back to `.env`, if any) rather than
 * storing an empty string. Used by `openrouter-keys.routes.ts`.
 */
export function writeCustomApiKey(service: ApiService, value: string | null): void {
  const trimmed = value?.trim();
  if (trimmed) {
    appConfigDb.set(configKey(service), trimmed);
  } else {
    appConfigDb.delete(configKey(service));
  }
}

/** One service's key status for the settings UI and the diagnostics report — never the key itself. */
export type CustomApiKeyStatus = { service: ApiService; envVarName: string; source: CustomApiKeySource };

/** Every service's key status. Used by `openrouter-keys.routes.ts` and the diagnostics report. */
export function listCustomApiKeyStatus(): CustomApiKeyStatus[] {
  return listServiceEnvVarNames().map(({ service, envVarName }) => {
    const stored = appConfigDb.get(configKey(service))?.trim();
    const source: CustomApiKeySource = stored ? 'ui' : process.env[envVarName]?.trim() ? 'env' : 'none';
    return { service, envVarName, source };
  });
}
