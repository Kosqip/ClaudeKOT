import type { AnyRecord } from '@/shared/types.js';
import type { ChatServiceAdapter, ChatTurn } from '@/modules/providers/list/openrouter/openrouter-service-registry.js';

/** Env var for a pay-per-token Anthropic API key — entirely separate from the Claude Code CLI's OAuth subscription login (`~/.claude`), never read or written by this adapter. */
const ANTHROPIC_DIRECT_API_KEY_ENV_VAR = 'ANTHROPIC_DIRECT_API_KEY';

/**
 * Anthropic's current Messages API version, as of writing (source: Anthropic's
 * streaming-messages documentation, `anthropic-version` header example).
 * Bump this if Anthropic ships a breaking version and direct-API calls start
 * failing with a version-mismatch error.
 */
const ANTHROPIC_VERSION = '2026-10-21';

/** Anthropic requires `max_tokens`; this app has no per-turn budget UI yet, so every direct-API turn asks for the same generous ceiling other providers leave uncapped. */
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Builds the `ChatServiceAdapter` for Anthropic's own Messages API
 * (`https://api.anthropic.com/v1/messages`) — a pay-per-token direct API key,
 * distinct from both the OpenAI-compatible services and the Claude Code CLI's
 * subscription login. Its request and SSE payload shapes are Anthropic's own,
 * not OpenAI's, so this does not share logic with
 * `openai-compatible-chat.service.ts` beyond the common adapter contract.
 *
 * Consumed by `openrouter-service-registry.ts`, which owns the one instance.
 */
export function createAnthropicMessagesAdapter(): ChatServiceAdapter {
  const readApiKey = (): string | null => {
    const value = process.env[ANTHROPIC_DIRECT_API_KEY_ENV_VAR];
    return value && value.trim() ? value.trim() : null;
  };

  return {
    envVarName: ANTHROPIC_DIRECT_API_KEY_ENV_VAR,
    readApiKey,

    buildRequest(modelId: string, messages: ChatTurn[]) {
      const apiKey = readApiKey();
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'x-api-key': apiKey ?? '',
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: {
          model: modelId,
          max_tokens: DEFAULT_MAX_TOKENS,
          stream: true,
          messages,
        },
      };
    },

    readStreamDelta(payload: string): string | undefined {
      let parsed: AnyRecord;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return undefined;
      }

      // Anthropic names the event on its `event:` line too, but every event's
      // own `type` field repeats it, so reading only the `data:` payload
      // (the only line this adapter's caller hands it) is enough — no need
      // to track the separate `event:` line.
      if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
        const text = parsed.delta.text;
        return typeof text === 'string' && text ? text : undefined;
      }

      return undefined;
    },
  };
}
