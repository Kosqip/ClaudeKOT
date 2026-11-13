import { createAnthropicMessagesAdapter } from '@/modules/providers/list/openrouter/services/anthropic-messages.service.js';
import { createOpenAiCompatibleChatAdapter } from '@/modules/providers/list/openrouter/services/openai-compatible-chat.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * The real HTTP API one `openrouter`-provider turn is sent to. The provider's
 * `LLMProvider` id stays `'openrouter'` everywhere else in the app (sessions,
 * the handoff fallback order, the model library) — this is purely an
 * internal dispatch detail of its runtime, picked per turn from the model
 * string's prefix (see `parseModelReference`).
 */
export type ApiService = 'openrouter' | 'anthropic' | 'openai';

export type ParsedModelReference = {
  service: ApiService;
  /** The model id with any `<service>:` prefix stripped. */
  modelId: string;
};

/** One OpenAI/Anthropic-style chat turn, the shape every adapter's request builder consumes. */
export type ChatTurn = {
  role: 'user' | 'assistant';
  content: string;
};

/**
 * One HTTP API a model string's service prefix can select, abstracting over
 * each service's endpoint, auth header, request shape and SSE payload
 * format so `openrouter-runtime.provider.ts` can drive all three with one
 * loop. Implemented by `openai-compatible-chat.service.ts` (OpenRouter and
 * OpenAI both use OpenAI's chat-completions wire format) and
 * `anthropic-messages.service.ts` (Anthropic's own Messages API format).
 */
export type ChatServiceAdapter = {
  /** The environment variable this service's API key is read from, for error messages. */
  readonly envVarName: string;
  /** Null when the key is not configured; never throws. */
  readApiKey(): string | null;
  /** The request this service expects for one turn. */
  buildRequest(modelId: string, messages: ChatTurn[]): { url: string; headers: Record<string, string>; body: unknown };
  /**
   * Extracts the assistant text delta from one decoded SSE `data:` payload
   * (already stripped of the `data:` prefix and trimmed), or undefined when
   * the payload carries no text (a stop sentinel, a non-text event, etc.).
   */
  readStreamDelta(payload: string): string | undefined;
  /**
   * The error message when the same kind of payload reports a failure the
   * service raised after the response had already started streaming (an
   * overloaded backend, a provider dropping out), or undefined. The HTTP
   * status was already 200 by then, so this is the only place it shows up.
   */
  readStreamError(payload: string): string | undefined;
};

const adapters: Record<ApiService, ChatServiceAdapter> = {
  openrouter: createOpenAiCompatibleChatAdapter({
    url: 'https://openrouter.ai/api/v1/chat/completions',
    envVarName: 'OPENROUTER_API_KEY',
    service: 'openrouter',
  }),
  openai: createOpenAiCompatibleChatAdapter({
    url: 'https://api.openai.com/v1/chat/completions',
    envVarName: 'OPENAI_DIRECT_API_KEY',
    service: 'openai',
  }),
  anthropic: createAnthropicMessagesAdapter(),
};

const KNOWN_SERVICES: ApiService[] = ['openrouter', 'openai', 'anthropic'];

/**
 * Splits a model string into its service and bare model id.
 *
 * A model string predates the multi-service split and was always a bare
 * OpenRouter model id (e.g. `meta-llama/llama-3.1-8b-instruct:free`, itself
 * containing a colon) with no service prefix. So only a prefix that exactly
 * matches a known service name before the *first* colon is treated as one —
 * every other string, prefix-shaped or not, is the whole OpenRouter model id
 * unchanged. This is what keeps every session and catalog entry created
 * before this module existed working without migration.
 */
export function parseModelReference(model: string): ParsedModelReference {
  const separatorIndex = model.indexOf(':');
  if (separatorIndex > 0) {
    const prefix = model.slice(0, separatorIndex);
    if ((KNOWN_SERVICES as string[]).includes(prefix)) {
      return { service: prefix as ApiService, modelId: model.slice(separatorIndex + 1) };
    }
  }
  return { service: 'openrouter', modelId: model };
}

/** Used by the runtime, the auth adapter, and the models adapter to drive one service generically. */
export function getServiceAdapter(service: ApiService): ChatServiceAdapter {
  return adapters[service];
}

/** Every service's env var name, for the auth adapter's per-service status. */
export function listServiceEnvVarNames(): Array<{ service: ApiService; envVarName: string }> {
  return KNOWN_SERVICES.map((service) => ({ service, envVarName: adapters[service].envVarName }));
}

/**
 * Parses one buffered chunk of any of these services' SSE stream into
 * complete lines, returning the leftover partial line to prepend to the
 * next chunk. Both services' streams use the same `\n`-terminated `data:
 * {...}` line framing, only the JSON payload shape differs per adapter.
 */
export function splitSseLines(buffer: string): { lines: string[]; remainder: string } {
  const parts = buffer.split('\n');
  const remainder = parts.pop() ?? '';
  return { lines: parts, remainder };
}

/** Rebuilds the chat turn list every adapter's request builder expects from recorded history. */
export function buildChatTurns(history: NormalizedMessage[], nextUserText: string): ChatTurn[] {
  const turns: ChatTurn[] = history
    .filter((message) => message.kind === 'text' && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content ?? '' }));

  turns.push({ role: 'user', content: nextUserText });
  return turns;
}

