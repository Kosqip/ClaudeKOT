import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useOrchestratorPlan } from '@/modules/orchestrator/hooks/useOrchestratorPlan';
import { LLM_PROVIDER_NAMES } from '@/shared/constants';

/**
 * Lets the user manually split a task into subtasks on the current session
 * (whose provider must already hold the "orchestrator" role) and shows the
 * resulting plan — each subtask names its role, the provider it was sent to
 * (or why it was skipped), and a link to open its brand-new session.
 * Rendered by the chat module as one of the tools under the composer, only
 * when the current session's provider has the orchestrator role.
 */
export function OrchestratorPlanPanel({
  sessionId,
  onOpenSubtaskSession,
}: {
  sessionId: string;
  onOpenSubtaskSession: (sessionId: string) => void;
}) {
  const { t } = useTranslation('chat');
  const [task, setTask] = useState('');
  const { plan, isPlanning, subtasks, error } = useOrchestratorPlan();

  const canSplit = task.trim().length > 0 && !isPlanning;

  const handleSplit = async () => {
    if (!canSplit) return;
    await plan(sessionId, task).catch(() => undefined);
  };

  return (
    <div className="orchestrator-plan-panel flex flex-col gap-2 rounded-md border border-border p-3">
      <p className="text-sm text-muted-foreground">{t('backendTools.orchestrator.description')}</p>
      <textarea
        value={task}
        onChange={(event) => setTask(event.target.value)}
        placeholder={t('backendTools.orchestrator.placeholder')}
        className="min-h-16 rounded-md border border-input bg-background p-2 text-sm"
      />
      <button
        type="button"
        onClick={() => void handleSplit()}
        disabled={!canSplit}
        className="self-end rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
      >
        {isPlanning ? t('backendTools.orchestrator.splitting') : t('backendTools.orchestrator.split')}
      </button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {subtasks ? (
        <ul className="flex flex-col gap-1 text-sm">
          {subtasks.map((subtask, index) => (
            <li key={`${index}-${subtask.title}`} className="flex items-center justify-between gap-2">
              <span>
                <strong>{subtask.title}</strong> — {t(`backendTools.orchestrator.roles.${subtask.role}`)}
                {subtask.provider ? ` (${LLM_PROVIDER_NAMES[subtask.provider]})` : ''}
                {': '}
                {subtask.started ? t('backendTools.started') : subtask.error ?? t('backendTools.orchestrator.skipped')}
              </span>
              {subtask.sessionId && subtask.started ? (
                <button
                  type="button"
                  onClick={() => onOpenSubtaskSession(subtask.sessionId!)}
                  className="text-primary underline"
                >
                  {t('backendTools.open')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
