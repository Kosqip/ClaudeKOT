import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useTaskRouter, type TaskTag } from '@/modules/task-router/hooks/useTaskRouter';
import { LLM_PROVIDER_NAMES } from '@/shared/constants';

const TAG_CHOICES: Array<TaskTag | 'auto'> = ['auto', 'routine', 'coding', 'second_opinion', 'complex'];

/**
 * Lets the user pick a task type (or "detect automatically", which lets the
 * server's keyword config in `task-router.config.json` decide) and routes
 * the task per the type's fixed rule — routine to a free model, coding to
 * Claude, second opinion to Claude and Codex together, complex to nothing
 * (the user is told to pick a backend manually instead). Rendered by the
 * chat module as one of the tools under the composer; unlike the
 * orchestrator panel, it is not gated on any provider role.
 */
export function TaskRouterPanel({
  projectPath,
  onOpenSession,
}: {
  projectPath: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useTranslation('chat');
  const [content, setContent] = useState('');
  const [selectedTag, setSelectedTag] = useState<TaskTag | 'auto'>('auto');
  const { dispatch, isDispatching, result, error } = useTaskRouter();

  const canDispatch = content.trim().length > 0 && !isDispatching;

  const handleDispatch = async () => {
    if (!canDispatch) return;
    const explicitTag = selectedTag === 'auto' ? undefined : selectedTag;
    await dispatch(projectPath, content, explicitTag).catch(() => undefined);
  };

  return (
    <div className="task-router-panel flex flex-col gap-2 rounded-md border border-border p-3">
      <p className="text-sm text-muted-foreground">{t('backendTools.router.description')}</p>
      <select
        value={selectedTag}
        onChange={(event) => setSelectedTag(event.target.value as TaskTag | 'auto')}
        className="rounded-md border border-input bg-background p-2 text-sm"
      >
        {TAG_CHOICES.map((choice) => (
          <option key={choice} value={choice}>{t(`backendTools.router.tags.${choice}`)}</option>
        ))}
      </select>
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder={t('backendTools.router.placeholder')}
        className="min-h-16 rounded-md border border-input bg-background p-2 text-sm"
      />
      <button
        type="button"
        onClick={() => void handleDispatch()}
        disabled={!canDispatch}
        className="self-end rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
      >
        {isDispatching ? t('backendTools.router.routing') : t('backendTools.router.route')}
      </button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {result ? (
        <div className="text-sm">
          {result.tag ? (
            <p className="font-medium">
              {t(result.autoDetected ? 'backendTools.router.tagDetected' : 'backendTools.router.tagChosen', {
                tag: t(`backendTools.router.tags.${result.tag}`),
              })}
            </p>
          ) : null}
          {result.tag === null ? (
            <p className="text-muted-foreground">{t('backendTools.router.noTag')}</p>
          ) : result.manualSelectionRequired ? (
            <p className="text-muted-foreground">{t('backendTools.router.complexHint')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {result.sessions.map((session) => (
                <li key={session.sessionId} className="flex items-center justify-between gap-2">
                  <span>
                    {LLM_PROVIDER_NAMES[session.provider]}: {session.started ? t('backendTools.started') : session.error ?? t('backendTools.failed')}
                  </span>
                  {session.started ? (
                    <button
                      type="button"
                      onClick={() => onOpenSession(session.sessionId)}
                      className="text-primary underline"
                    >
                      {t('backendTools.open')}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
