import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useMixCandidates } from '@/modules/mix/hooks/useMixCandidates';
import { useMixDispatch } from '@/modules/mix/hooks/useMixDispatch';
import { LLM_PROVIDER_NAMES } from '@/shared/constants';

/**
 * Lets the user pick two or more sessions of the current project — each
 * already bound to its own provider (Claude Code, Codex, Custom API, ...) —
 * and send one message to all of them at once.
 *
 * Each target session keeps streaming its reply the normal way; this panel
 * only starts the turns and shows which of them actually started. Rendered
 * by the chat module as one of the tools under the composer.
 */
export function MixSendPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation('chat');
  const { candidates, reload } = useMixCandidates(projectId);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [content, setContent] = useState('');
  const { dispatch, isDispatching, results, error } = useMixDispatch();

  const toggle = (sessionId: string) => {
    setSelectedIds((current) => (
      current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [...current, sessionId]
    ));
  };

  const canSend = selectedIds.length >= 2 && content.trim().length > 0 && !isDispatching;

  const handleSend = async () => {
    if (!canSend) return;
    await dispatch(selectedIds, content).catch(() => undefined);
    setContent('');
  };

  const providerName = (provider: string | undefined) =>
    LLM_PROVIDER_NAMES[provider as keyof typeof LLM_PROVIDER_NAMES] ?? provider ?? '';

  return (
    <div
      className="mix-send-panel flex flex-col gap-2 rounded-md border border-border p-3"
      onMouseEnter={() => void reload()}
      onFocus={() => void reload()}
    >
      <p className="text-sm text-muted-foreground">{t('backendTools.mix.description')}</p>
      <ul className="flex max-h-32 flex-col gap-1 overflow-y-auto">
        {candidates.map((candidate) => (
          <li key={candidate.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`mix-target-${candidate.id}`}
              checked={selectedIds.includes(candidate.id)}
              onChange={() => toggle(candidate.id)}
            />
            <label htmlFor={`mix-target-${candidate.id}`} className="text-sm">
              {candidate.summary || candidate.name || candidate.title || t('backendTools.mix.untitledSession')}
              {' — '}
              {providerName(candidate.provider)}
            </label>
          </li>
        ))}
      </ul>
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder={t('backendTools.mix.placeholder')}
        className="min-h-16 rounded-md border border-input bg-background p-2 text-sm"
      />
      <button
        type="button"
        onClick={() => void handleSend()}
        disabled={!canSend}
        className="self-end rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
      >
        {isDispatching ? t('backendTools.mix.sending') : t('backendTools.mix.send')}
      </button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {results ? (
        <ul className="flex flex-col gap-1 text-sm">
          {results.map((result) => (
            <li key={result.sessionId}>
              {providerName(result.provider)}: {result.started ? t('backendTools.started') : `${t('backendTools.failed')} — ${result.error}`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
