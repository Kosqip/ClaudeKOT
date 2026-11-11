import { readOpenRouterHistory } from '@/modules/providers/list/openrouter/openrouter-history.store.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, readObjectRecord, sliceTailPage } from '@/shared/utils.js';

const PROVIDER = 'openrouter';

export class OpenRouterSessionsProvider implements IProviderSessions {
  /**
   * The OpenRouter runtime emits already-normalized messages directly (it has
   * no provider-native event format to translate), so this only has to cover
   * the rare case of a raw string or passthrough object reaching it.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (raw && typeof raw.kind === 'string') {
      return [raw as NormalizedMessage];
    }

    if (typeof rawMessage === 'string' && rawMessage.trim()) {
      return [createNormalizedMessage({
        kind: 'stream_delta',
        content: rawMessage,
        sessionId,
        provider: PROVIDER,
      })];
    }

    return [];
  }

  /**
   * Reads session history back from the JSONL transcript the runtime adapter
   * writes as it streams (see `openrouter-history.store.ts`).
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;

    const allMessages = await readOpenRouterHistory(providerSessionId);
    const renderableMessages = allMessages.filter((message) => message.kind !== 'complete');
    const total = renderableMessages.length;
    const { page, hasMore } = sliceTailPage(renderableMessages, limit, offset);

    return { messages: page, total, hasMore, offset, limit };
  }
}
