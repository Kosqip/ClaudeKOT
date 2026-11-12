import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isOrchestratorRunActive, useOrchestratorPlan } from '@/modules/orchestrator/hooks/useOrchestratorPlan';
import type { OrchestratorSubtaskResult } from '@/modules/orchestrator/hooks/useOrchestratorPlan';
import { LLM_PROVIDER_NAMES } from '@/shared/constants';
import { cn } from '@/shared/utils';

const ROUND_OPTIONS = [1, 2, 3, 4];

const STATUS_DOT: Record<OrchestratorSubtaskResult['status'], string> = {
  pending: 'bg-muted-foreground/40',
  running: 'animate-pulse bg-amber-500',
  done: 'bg-emerald-500',
  failed: 'bg-red-500',
  skipped: 'bg-muted-foreground/40',
};

/**
 * Lets the user hand a task to the current session (whose provider must
 * hold the "orchestrator" role) to coordinate, and follows the run: the
 * plan's subtasks round by round — each with its role, access, backend and
 * live status, and a link to its own session — then the orchestrator's
 * closing summary. A run in progress can be cancelled. Rendered by the chat
 * module as one of the tools under the composer, only when the current
 * session's provider has the orchestrator role.
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
  const [maxRounds, setMaxRounds] = useState(2);
  const { run, isStarting, error, start, cancel } = useOrchestratorPlan(sessionId);

  const active = isOrchestratorRunActive(run);
  const canStart = task.trim().length > 0 && !isStarting && !active;
  const rounds = run ? [...new Set(run.subtasks.map((subtask) => subtask.round))] : [];

  return (
    <div className="orchestrator-plan-panel flex flex-col gap-2 rounded-md border border-border p-3">
      <p className="text-sm text-muted-foreground">{t('backendTools.orchestrator.description')}</p>
      <textarea
        value={task}
        onChange={(event) => setTask(event.target.value)}
        placeholder={t('backendTools.orchestrator.placeholder')}
        className="min-h-12 rounded-md border border-input bg-background p-2 text-sm"
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {t('backendTools.orchestrator.rounds')}
          <select
            value={maxRounds}
            onChange={(event) => setMaxRounds(Number(event.target.value))}
            disabled={active}
            className="rounded-md border border-input bg-background py-1 pl-2 pr-8 text-sm"
          >
            {ROUND_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        {active ? (
          <button
            type="button"
            onClick={() => void cancel()}
            className="rounded-md border border-border px-3 py-1.5 text-sm"
          >
            {t('backendTools.orchestrator.cancel')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void start(task, maxRounds)}
          disabled={!canStart}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {isStarting ? t('backendTools.orchestrator.splitting') : t('backendTools.orchestrator.split')}
        </button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {run ? (
        <div className="flex max-h-44 flex-col gap-2 overflow-y-auto border-t border-border pt-2 text-sm">
          <p className="font-medium" role="status">
            {t(`backendTools.orchestrator.phase.${run.phase}`, { round: run.round, maxRounds: run.maxRounds })}
          </p>
          {rounds.map((round) => (
            <div key={round} className="flex flex-col gap-1">
              {run.maxRounds > 1 ? (
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t('backendTools.orchestrator.round', { round })}
                </p>
              ) : null}
              <ul className="flex flex-col gap-1">
                {run.subtasks.filter((subtask) => subtask.round === round).map((subtask, index) => (
                  <li key={`${round}-${index}`} className="flex items-start justify-between gap-2">
                    <span className="flex items-start gap-2">
                      <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', STATUS_DOT[subtask.status])} />
                      <span>
                        <strong>{subtask.title}</strong>
                        {' — '}
                        {t(`backendTools.orchestrator.roles.${subtask.role}`)}
                        {', '}
                        {t(`backendTools.orchestrator.access.${subtask.access}`)}
                        {subtask.provider ? ` · ${LLM_PROVIDER_NAMES[subtask.provider]}` : ''}
                        {' · '}
                        {t(`backendTools.orchestrator.status.${subtask.status}`)}
                        {subtask.error ? <span className="text-muted-foreground">{` (${subtask.error})`}</span> : null}
                      </span>
                    </span>
                    {subtask.sessionId ? (
                      <button
                        type="button"
                        onClick={() => onOpenSubtaskSession(subtask.sessionId!)}
                        className="shrink-0 text-primary underline"
                      >
                        {t('backendTools.open')}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {run.summary ? <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-2">{run.summary}</p> : null}
          {run.error ? <p className="whitespace-pre-wrap text-destructive">{run.error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
