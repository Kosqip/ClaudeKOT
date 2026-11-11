import { randomUUID } from 'node:crypto';

import { readOpenRouterApiKey } from '@/modules/providers/list/openrouter/openrouter-auth.provider.js';
import { appendOpenRouterHistoryRow, readOpenRouterHistory } from '@/modules/providers/list/openrouter/openrouter-history.store.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord, NormalizedMessage, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PROVIDER = 'openrouter';

type OpenRouterChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

/** Live HTTP requests keyed by app session id, so `abort()` can cancel them. */
const activeOpenRouterRequests = new Map<string, AbortController>();

/** Rebuilds the OpenAI-compatible message list OpenRouter expects from recorded turns. */
function buildChatMessages(history: NormalizedMessage[], nextUserText: string): OpenRouterChatMessage[] {
  const turns: OpenRouterChatMessage[] = history
    .filter((message) => message.kind === 'text' && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content ?? '' }));

  turns.push({ role: 'user', content: nextUserText });
  return turns;
}

/**
 * Parses one buffered chunk of an OpenAI-compatible SSE stream into complete
 * `data:` lines, returning the leftover partial line to prepend to the next chunk.
 */
function splitSseLines(buffer: string): { lines: string[]; remainder: string } {
  const parts = buffer.split('\n');
  const remainder = parts.pop() ?? '';
  return { lines: parts, remainder };
}

/**
 * Runs one OpenRouter chat-completions turn over HTTP with SSE streaming.
 *
 * Unlike every other provider, OpenRouter has no local CLI process: requests
 * go straight to `https://openrouter.ai/api/v1/chat/completions` with the key
 * from `OPENROUTER_API_KEY`, and the resulting text deltas are translated
 * into the same `NormalizedMessage` stream (`stream_delta` then `complete`)
 * the rest of the app already renders uniformly for every provider.
 */
async function runOpenRouter(
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const isNewSession = !options.sessionId;
  const sessionId: string = options.sessionId || randomUUID();
  const model = await context.resolveResumeModel(options.sessionId, options.model);

  if (isNewSession) {
    writer.setSessionId?.(sessionId);
    writer.send(createNormalizedMessage({
      kind: 'session_created',
      newSessionId: sessionId,
      sessionId,
      provider: PROVIDER,
      model,
    }));
  }

  const apiKey = readOpenRouterApiKey();
  if (!apiKey) {
    const errorMessage = createNormalizedMessage({
      kind: 'error',
      content: 'OPENROUTER_API_KEY is not set on the server.',
      sessionId,
      provider: PROVIDER,
    });
    writer.send(errorMessage);
    writer.send(createCompleteMessage({ provider: PROVIDER, sessionId, exitCode: 1 }));
    return;
  }

  const priorHistory = await readOpenRouterHistory(sessionId);
  const userTurn = createNormalizedMessage({
    kind: 'text',
    role: 'user',
    content: command,
    sessionId,
    provider: PROVIDER,
  });
  await appendOpenRouterHistoryRow(userTurn);

  const abortController = new AbortController();
  activeOpenRouterRequests.set(sessionId, abortController);

  let assembledText = '';
  let aborted = false;

  try {
    const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      signal: abortController.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: buildChatMessages(priorHistory, command),
      }),
    });

    if (!response.ok || !response.body) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`OpenRouter request failed (${response.status}): ${bodyText || response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const { lines, remainder } = splitSseLines(buffer);
      buffer = remainder;

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) {
          continue;
        }

        const payload = line.slice('data:'.length).trim();
        if (payload === '[DONE]') {
          continue;
        }

        let parsedChunk: AnyRecord;
        try {
          parsedChunk = JSON.parse(payload);
        } catch {
          continue;
        }

        const deltaText = parsedChunk?.choices?.[0]?.delta?.content;
        if (typeof deltaText === 'string' && deltaText) {
          assembledText += deltaText;
          writer.send(createNormalizedMessage({
            kind: 'stream_delta',
            content: deltaText,
            sessionId,
            provider: PROVIDER,
            model,
          }));
        }
      }
    }
  } catch (error) {
    aborted = abortController.signal.aborted;
    if (!aborted) {
      writer.send(createNormalizedMessage({
        kind: 'error',
        content: error instanceof Error ? error.message : String(error),
        sessionId,
        provider: PROVIDER,
      }));
    }
  } finally {
    activeOpenRouterRequests.delete(sessionId);
  }

  if (assembledText) {
    await appendOpenRouterHistoryRow(createNormalizedMessage({
      kind: 'text',
      role: 'assistant',
      content: assembledText,
      sessionId,
      provider: PROVIDER,
      model,
    }));
  }

  writer.send(createCompleteMessage({
    provider: PROVIDER,
    sessionId,
    exitCode: aborted ? 1 : 0,
    aborted,
  }));
}

/** Cancels the in-flight OpenRouter HTTP request for a session, if any. */
function abortOpenRouterSession(sessionId: string): boolean {
  const abortController = activeOpenRouterRequests.get(sessionId);
  if (!abortController) {
    return false;
  }

  abortController.abort();
  activeOpenRouterRequests.delete(sessionId);
  return true;
}

export const openRouterRuntime: IProviderRuntime = {
  run: runOpenRouter,
  abort: abortOpenRouterSession,
};
