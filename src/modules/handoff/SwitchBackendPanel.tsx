import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { LLM_PROVIDER_NAMES } from '@/shared/constants';
import type { LLMProvider } from '@/shared/types';

const ALL_PROVIDERS: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode', 'openrouter'];

type SwitchBackendPanelProps = {
  sessionId: string;
  currentProvider: LLMProvider;
  /** Opens the new session once the conversation has been moved there. */
  onOpenSession: (sessionId: string) => void;
};

/**
 * Lets the user move this conversation to a different backend at any time,
 * for any reason — unlike `HandoffSuggestionBanner`, this is not tied to a
 * usage limit. Opens a new session there (every provider here is its own
 * independent CLI/subscription session underneath, so none of them can
 * literally continue on a different one without starting a fresh one — see
 * `handoffSessionOnLimit`'s `manual` mode) with the conversation so far
 * handed to it, and tells the user it is a new, linked session rather than
 * presenting it as the impossible "the same chat, different backend".
 * Rendered by ChatInterface as one of the tools under the composer.
 */
export default function SwitchBackendPanel({ sessionId, currentProvider, onOpenSession }: SwitchBackendPanelProps) {
  const { t } = useTranslation('chat');
  const [targetProvider, setTargetProvider] = useState<LLMProvider | ''>('');
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const otherProviders = ALL_PROVIDERS.filter((candidate) => candidate !== currentProvider);

  const handleSwitch = async () => {
    if (!targetProvider) {
      return;
    }
    setIsSwitching(true);
    setError(null);
    try {
      const response = await api.handoff.trigger({ sessionId, mode: 'manual', fallbackOrder: [targetProvider] });
      const body = await response.json().catch(() => null);
      const toSessionId = body?.data?.result?.toSessionId;
      if (!response.ok || typeof toSessionId !== 'string') {
        setError(body?.error?.message ?? t('backendTools.switchBackend.failed', { defaultValue: 'The switch could not be started.' }));
        return;
      }
      onOpenSession(toSessionId);
    } catch {
      setError(t('backendTools.switchBackend.failed', { defaultValue: 'The switch could not be started.' }));
    } finally {
      setIsSwitching(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <p className="text-sm text-muted-foreground">{t('backendTools.switchBackend.description')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={targetProvider}
          onChange={(event) => setTargetProvider(event.target.value as LLMProvider | '')}
          className="rounded-md border border-input bg-background py-1.5 pl-2 pr-8 text-sm"
        >
          <option value="">{t('backendTools.switchBackend.choose')}</option>
          {otherProviders.map((candidate) => (
            <option key={candidate} value={candidate}>{LLM_PROVIDER_NAMES[candidate]}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void handleSwitch()}
          disabled={!targetProvider || isSwitching}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {isSwitching ? t('backendTools.switchBackend.switching') : t('backendTools.switchBackend.switch')}
        </button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
