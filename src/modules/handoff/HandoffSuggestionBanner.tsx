import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { LLM_PROVIDER_NAMES } from '@/shared/constants';
import type { HandoffSuggestion } from '@/shared/types';

type HandoffSuggestionBannerProps = {
  suggestion: HandoffSuggestion;
  /** Called with the new session's id once the conversation has been moved. */
  onSwitched: (toSessionId: string) => void;
  onDismiss: () => void;
};

/**
 * The offer shown in a chat whose backend is close to its usage limit:
 * "move this conversation to <fallback>?". Nothing has been started on the
 * fallback yet — accepting opens a session there with the conversation's
 * history and waits for the next instruction; dismissing just hides the
 * offer (the automatic move on an actual refusal still applies). Rendered
 * by ChatInterface for the viewed session's pending `handoff_suggestion`.
 */
export default function HandoffSuggestionBanner({ suggestion, onSwitched, onDismiss }: HandoffSuggestionBannerProps) {
  const { t } = useTranslation('chat');
  const [isSwitching, setIsSwitching] = useState(false);
  const [failed, setFailed] = useState(false);

  const names = {
    from: LLM_PROVIDER_NAMES[suggestion.fromProvider],
    to: LLM_PROVIDER_NAMES[suggestion.toProvider],
  };

  const handleSwitch = async () => {
    setIsSwitching(true);
    setFailed(false);
    try {
      const response = await api.handoff.trigger({
        sessionId: suggestion.sessionId,
        reason: suggestion.reason,
        mode: 'standby',
      });
      const payload = await response.json().catch(() => null);
      const toSessionId = payload?.data?.result?.toSessionId;
      if (!response.ok || typeof toSessionId !== 'string') {
        setFailed(true);
        return;
      }
      onSwitched(toSessionId);
    } catch {
      setFailed(true);
    } finally {
      setIsSwitching(false);
    }
  };

  return (
    <div
      role="status"
      className="mx-4 mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100"
    >
      <span>
        {failed
          ? t('input.handoffSuggestFailed', names)
          : typeof suggestion.utilizationPercent === 'number'
            ? t('input.handoffSuggestPercent', { ...names, percent: suggestion.utilizationPercent })
            : t('input.handoffSuggest', names)}
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <button type="button" className="font-medium underline disabled:opacity-60" disabled={isSwitching} onClick={() => void handleSwitch()}>
          {isSwitching ? t('input.handoffSuggestSwitching') : t('input.handoffSuggestAccept', names)}
        </button>
        <button type="button" className="underline opacity-80" disabled={isSwitching} onClick={onDismiss}>
          {t('input.handoffSuggestDismiss')}
        </button>
      </span>
    </div>
  );
}
