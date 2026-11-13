import { readCustomApiKey } from '@/modules/providers/list/openrouter/services/custom-api-key-store.service.js';
import type { AnyRecord } from '@/shared/types.js';
import type { ApiService, ChatServiceAdapter, ChatTurn } from '@/modules/providers/list/openrouter/openrouter-service-registry.js';

/**
 * Builds a `ChatServiceAdapter` for an OpenAI-compatible chat-completions
 * endpoint — used for both the `openrouter` and `openai` services, which
 * differ only in base URL and API key, never in wire format.
 *
 * Consumed by `openrouter-service-registry.ts`, which owns the one instance
 * of each.
 */
export function createOpenAiCompatibleChatAdapter(config: { url: string; envVarName: string; service: ApiService }): ChatServiceAdapter {
  // A local function, not a `this`-based method, so `buildRequest` below
  // calling it directly never depends on how the returned adapter object is
  // later invoked or destructured. Checks the key saved through Settings
  // before the env var — see `readCustomApiKey`.
  const readApiKey = (): string | null => readCustomApiKey(config.service);

  return {
    envVarName: config.envVarName,
    readApiKey,

    buildRequest(modelId: string, messages: ChatTurn[]) {
      const apiKey = readApiKey();
      return {
        url: config.url,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: {
          model: modelId,
          stream: true,
          messages,
        },
      };
    },

    readStreamDelta(payload: string): string | undefined {
      if (payload === '[DONE]') {
        return undefined;
      }

      let parsed: AnyRecord;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return undefined;
      }

      const deltaText = parsed?.choices?.[0]?.delta?.content;
      return typeof deltaText === 'string' && deltaText ? deltaText : undefined;
    },

    readStreamError(payload: string): string | undefined {
      if (payload === '[DONE]') {
        return undefined;
      }

      let parsed: AnyRecord;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return undefined;
      }

      // `{"error":{"code":502,"message":"..."}}`, sent in place of a chunk.
      if (!parsed?.error) {
        return undefined;
      }
      return String(parsed.error.message ?? parsed.error.code ?? 'The service reported an error.');
    },
  };
}
