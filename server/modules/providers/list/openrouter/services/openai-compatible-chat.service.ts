import type { AnyRecord } from '@/shared/types.js';
import type { ChatServiceAdapter, ChatTurn } from '@/modules/providers/list/openrouter/openrouter-service-registry.js';

/**
 * Builds a `ChatServiceAdapter` for an OpenAI-compatible chat-completions
 * endpoint — used for both the `openrouter` and `openai` services, which
 * differ only in base URL and API key, never in wire format.
 *
 * Consumed by `openrouter-service-registry.ts`, which owns the one instance
 * of each.
 */
export function createOpenAiCompatibleChatAdapter(config: { url: string; envVarName: string }): ChatServiceAdapter {
  // A local function, not a `this`-based method, so `buildRequest` below
  // calling it directly never depends on how the returned adapter object is
  // later invoked or destructured.
  const readApiKey = (): string | null => {
    const value = process.env[config.envVarName];
    return value && value.trim() ? value.trim() : null;
  };

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
  };
}
