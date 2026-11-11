import { sessionsDb } from '@/modules/database/index.js';
import { runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { AnyRecord, LLMProvider, MixDispatchResult, MixTarget } from '@/shared/types.js';

/**
 * Fans one user message out to several already-existing provider sessions in
 * parallel, each kept on the independent dispatch path a single-provider send
 * already uses (`runDetachedChatTurn`), so no provider's runtime, auth, or
 * subprocess handling is touched by this module.
 *
 * Every target is dispatched through its own `runDetachedChatTurn` call, and
 * a target's failure (unknown session, unsupported provider, a run already
 * in progress) is caught and reported in its own result entry — it never
 * rejects the others or the overall promise. Each session continues to
 * broadcast its own `NormalizedMessage`s (already carrying its `provider`)
 * over the existing `chat.subscribe` channel; this service only reports
 * whether each dispatch *started*, not how the turn ends.
 *
 * Consumed by `mix.routes.ts`, the HTTP entry point for a mix send.
 */
export async function dispatchMixTurn(
  input: {
    targets: MixTarget[];
    userId: number;
    content: string;
    options?: AnyRecord;
  },
  runtime: ProviderRuntimeGateway,
): Promise<MixDispatchResult[]> {
  return Promise.all(
    input.targets.map(async (target): Promise<MixDispatchResult> => {
      const session = sessionsDb.getSessionById(target.sessionId);
      const provider = (session?.provider as LLMProvider | undefined) ?? 'claude';

      if (!session) {
        return { sessionId: target.sessionId, provider, started: false, error: 'The session no longer exists.' };
      }

      try {
        const result = await runDetachedChatTurn(
          {
            sessionId: target.sessionId,
            userId: input.userId,
            content: input.content,
            options: input.options,
          },
          { runtime },
        );
        return { sessionId: target.sessionId, provider, started: result.started, error: result.error };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { sessionId: target.sessionId, provider, started: false, error: message };
      }
    }),
  );
}
