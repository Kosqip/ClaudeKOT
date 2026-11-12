import { randomUUID } from 'node:crypto';

import { listFreeModelFallbacks, openRouterProviderModels } from '@/modules/providers/list/openrouter/openrouter-models.provider.js';
import { appendOpenRouterHistoryRow, readOpenRouterHistory } from '@/modules/providers/list/openrouter/openrouter-history.store.js';
import {
  buildChatTurns,
  getServiceAdapter,
  parseModelReference,
  splitSseLines,
} from '@/modules/providers/list/openrouter/openrouter-service-registry.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

const PROVIDER = 'openrouter';

/** Live HTTP requests keyed by app session id, so `abort()` can cancel them. */
const activeApiRequests = new Map<string, AbortController>();

/**
 * Runs one turn over HTTP with SSE streaming against whichever API service
 * the session's model string selects (OpenRouter by default, or `anthropic:`
 * / `openai:` for a direct API key — see `parseModelReference`).
 *
 * Unlike every other provider, this one has no local CLI process: requests
 * go straight to the selected service's endpoint, and the resulting text
 * deltas are translated into the same `NormalizedMessage` stream
 * (`stream_delta` then `complete`) the rest of the app already renders
 * uniformly for every provider, regardless of which service answered.
 */
async function runOpenRouter(
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const isNewSession = !options.sessionId;
  const sessionId: string = options.sessionId || randomUUID();
  // A session nobody picked a model for (opened by the task router, the
  // orchestrator or a handoff) runs on the catalog default; without it the
  // request went out with an empty model and the service refused it.
  const model = await context.resolveResumeModel(options.sessionId, options.model)
    || (await openRouterProviderModels.getSupportedModels()).DEFAULT;
  const { service, modelId } = parseModelReference(model);
  const adapter = getServiceAdapter(service);

  // The chat gateway always passes its own app session id, so `isNewSession`
  // is false there — but the session still has no provider id recorded until
  // this runtime names one, and without it the app treats the session as
  // having no transcript: reopening it shows an empty history. This runtime
  // has no id of its own, so the app session id doubles as the provider id.
  if (isNewSession || !context.resolveProviderSessionId(sessionId)) {
    writer.setSessionId?.(sessionId);
  }

  if (isNewSession) {
    writer.send(createNormalizedMessage({
      kind: 'session_created',
      newSessionId: sessionId,
      sessionId,
      provider: PROVIDER,
      model,
    }));
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

  // A failure is written to the transcript as well as streamed: a session
  // reopened later would otherwise show the question with nothing after it
  // and no hint of what went wrong.
  const reportError = async (content: string): Promise<void> => {
    const errorMessage = createNormalizedMessage({ kind: 'error', content, sessionId, provider: PROVIDER });
    writer.send(errorMessage);
    await appendOpenRouterHistoryRow(errorMessage);
  };

  const apiKey = adapter.readApiKey();
  if (!apiKey) {
    await reportError(`${adapter.envVarName} is not set on the server.`);
    writer.send(createCompleteMessage({ provider: PROVIDER, sessionId, exitCode: 1 }));
    return;
  }

  const abortController = new AbortController();
  activeApiRequests.set(sessionId, abortController);

  let assembledText = '';
  let aborted = false;

  try {
    const request = adapter.buildRequest(modelId, buildChatTurns(priorHistory, command));
    if (service === 'openrouter') {
      // A free model that is refused upstream is replaced by the next free one by OpenRouter itself.
      const models = listFreeModelFallbacks(modelId, await openRouterProviderModels.getSupportedModels());
      if (models.length > 1) {
        const body = request.body as AnyRecord;
        delete body.model;
        body.models = models;
      }
    }
    const response = await fetch(request.url, {
      method: 'POST',
      signal: abortController.signal,
      headers: request.headers,
      body: JSON.stringify(request.body),
    });

    if (!response.ok || !response.body) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`${service} request failed (${response.status}): ${bodyText || response.statusText}`);
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
        const streamError = adapter.readStreamError(payload);
        if (streamError) {
          throw new Error(`${service} stream failed: ${streamError}`);
        }
        const deltaText = adapter.readStreamDelta(payload);
        if (deltaText) {
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
      await reportError(error instanceof Error ? error.message : String(error));
    }
  } finally {
    activeApiRequests.delete(sessionId);
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

/** Cancels the in-flight HTTP request for a session, if any. */
function abortOpenRouterSession(sessionId: string): boolean {
  const abortController = activeApiRequests.get(sessionId);
  if (!abortController) {
    return false;
  }

  abortController.abort();
  activeApiRequests.delete(sessionId);
  return true;
}

export const openRouterRuntime: IProviderRuntime = {
  run: runOpenRouter,
  abort: abortOpenRouterSession,
};
