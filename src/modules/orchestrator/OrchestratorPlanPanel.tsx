import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isOrchestratorRunActive, useOrchestratorPlan } from '@/modules/orchestrator/hooks/useOrchestratorPlan';
import type { OrchestratorRun, OrchestratorRunMode, OrchestratorSubtaskResult } from '@/modules/orchestrator/hooks/useOrchestratorPlan';
import { LLM_PROVIDER_NAMES } from '@/shared/constants';
import { cn } from '@/shared/utils';

/** Rounds the user may pick per mode, and what is preselected — they match the server's limits and defaults. */
const ROUND_OPTIONS: Record<OrchestratorRunMode, number[]> = { plan: [1, 2, 3, 4], pair: [1, 2, 3, 4, 5] };
const DEFAULT_ROUNDS: Record<OrchestratorRunMode, number> = { plan: 2, pair: 3 };

const SEVERITY_STYLE: Record<'P0' | 'P1' | 'P2', string> = {
  P0: 'bg-red-500/15 text-red-600 dark:text-red-400',
  P1: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  P2: 'bg-muted text-muted-foreground',
};

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
 * closing summary. A run in progress can be stopped (its running turns are
 * stopped too); a run paused on a usage limit shows when it goes on and can
 * be continued at once, as can one that failed or was cut off by a restart.
 * In pair mode the panel shows each round's writer and reviewer turns, the
 * reviewer's verdict and findings, and how the run ended. Rendered by the chat
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
  // Which kind of run the next "Start" begins: a plan split into subtasks, or a writer–reviewer pair.
  const [mode, setMode] = useState<OrchestratorRunMode>('plan');
  const [maxRounds, setMaxRounds] = useState(DEFAULT_ROUNDS.plan);
  const { run, isStarting, error, start, cancel, resume } = useOrchestratorPlan(sessionId);

  const active = isOrchestratorRunActive(run);
  const canStart = task.trim().length > 0 && !isStarting && !active;
  const canResume = run?.phase === 'paused' || run?.phase === 'failed';
  const coordinatorMoved = Boolean(run?.coordinatorSessionId && run.coordinatorSessionId !== run.orchestratorSessionId);
  const rounds = run ? [...new Set(run.subtasks.map((subtask) => subtask.round))] : [];
  const isPairRun = run?.mode === 'pair';
  const phaseKey = isPairRun && (run.phase === 'running' || run.phase === 'reviewing')
    ? `backendTools.orchestrator.pairPhase.${run.phase}`
    : `backendTools.orchestrator.phase.${run?.phase}`;

  return (
    <div className="orchestrator-plan-panel flex flex-col gap-2 rounded-md border border-border p-3">
      <p className="text-sm text-muted-foreground">
        {t(mode === 'pair' ? 'backendTools.orchestrator.pairDescription' : 'backendTools.orchestrator.description')}
      </p>
      <textarea
        value={task}
        onChange={(event) => setTask(event.target.value)}
        placeholder={t('backendTools.orchestrator.placeholder')}
        className="min-h-12 rounded-md border border-input bg-background p-2 text-sm"
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {t('backendTools.orchestrator.mode')}
          <select
            value={mode}
            onChange={(event) => {
              const nextMode = event.target.value as OrchestratorRunMode;
              setMode(nextMode);
              setMaxRounds(DEFAULT_ROUNDS[nextMode]);
            }}
            disabled={active}
            className="rounded-md border border-input bg-background py-1 pl-2 pr-8 text-sm"
          >
            <option value="plan">{t('backendTools.orchestrator.modes.plan')}</option>
            <option value="pair">{t('backendTools.orchestrator.modes.pair')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {t('backendTools.orchestrator.rounds')}
          <select
            value={maxRounds}
            onChange={(event) => setMaxRounds(Number(event.target.value))}
            disabled={active}
            className="rounded-md border border-input bg-background py-1 pl-2 pr-8 text-sm"
          >
            {ROUND_OPTIONS[mode].map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        {canResume ? (
          <button
            type="button"
            onClick={() => void resume()}
            className="rounded-md border border-border px-3 py-1.5 text-sm"
          >
            {t('backendTools.orchestrator.resume')}
          </button>
        ) : null}
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
          onClick={() => void start(task, maxRounds, mode)}
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
            {t(phaseKey, { round: run.round, maxRounds: run.maxRounds })}
          </p>
          {run.phase === 'paused' ? (
            <p className="text-muted-foreground">
              {run.pauseReason === 'limit'
                ? t('backendTools.orchestrator.pausedLimit', {
                  provider: run.waitingFor ? LLM_PROVIDER_NAMES[run.waitingFor] : '',
                  time: run.resumeAt ? new Date(run.resumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
                })
                : run.pauseReason === 'decision'
                  ? t('backendTools.orchestrator.pausedDecision')
                  : t('backendTools.orchestrator.pausedRestart')}
            </p>
          ) : null}
          {coordinatorMoved && run.coordinatorProvider ? (
            <p className="flex items-center justify-between gap-2 text-muted-foreground">
              <span>{t('backendTools.orchestrator.coordinatorMoved', { provider: LLM_PROVIDER_NAMES[run.coordinatorProvider] })}</span>
              <button
                type="button"
                onClick={() => onOpenSubtaskSession(run.coordinatorSessionId!)}
                className="shrink-0 text-primary underline"
              >
                {t('backendTools.open')}
              </button>
            </p>
          ) : null}
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
                        {subtask.pairPart
                          ? t(`backendTools.orchestrator.pair.${subtask.pairPart}`)
                          : t(`backendTools.orchestrator.roles.${subtask.role}`)}
                        {', '}
                        {t(`backendTools.orchestrator.access.${subtask.access}`)}
                        {subtask.provider ? ` · ${LLM_PROVIDER_NAMES[subtask.provider]}` : ''}
                        {' · '}
                        {t(`backendTools.orchestrator.status.${subtask.status}`)}
                        {subtask.movedFrom?.length ? (
                          <span className="text-muted-foreground">
                            {` (${t('backendTools.orchestrator.movedFrom', { providers: subtask.movedFrom.map((provider) => LLM_PROVIDER_NAMES[provider]).join(', ') })})`}
                          </span>
                        ) : null}
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
              {isPairRun ? <PairRoundVerdict round={run.pairRounds?.find((entry) => entry.round === round)} /> : null}
            </div>
          ))}
          {isPairRun && run.phase === 'done' && run.pairOutcome ? (
            <p className="font-medium">
              {t(run.pairOutcome === 'approved' ? 'backendTools.orchestrator.pair.outcomeApproved' : 'backendTools.orchestrator.pair.outcomeRounds')}
            </p>
          ) : null}
          {run.summary ? <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-2">{run.summary}</p> : null}
          {run.error ? <p className="whitespace-pre-wrap text-destructive">{run.error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The writer's word and the reviewer's verdict with its findings, under one round of a pair run. */
function PairRoundVerdict({ round }: { round: NonNullable<OrchestratorRun['pairRounds']>[number] | undefined }) {
  const { t } = useTranslation('chat');
  if (!round || (round.writerDone === undefined && round.verdict === undefined && !round.userContinued)) {
    return null;
  }
  return (
    <div className="ml-4 flex flex-col gap-1 text-muted-foreground">
      <p>
        {[
          round.userContinued ? t('backendTools.orchestrator.pair.continued') : null,
          round.writerDone === undefined ? null : t(round.writerDone ? 'backendTools.orchestrator.pair.writerDone' : 'backendTools.orchestrator.pair.writerNotDone'),
          round.verdict ? t(`backendTools.orchestrator.pair.${round.verdict}`) : null,
          round.verdict && round.findings.length === 0 ? t('backendTools.orchestrator.pair.noFindings') : null,
        ].filter(Boolean).join(' · ')}
      </p>
      {round.findings.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {round.findings.map((finding, index) => (
            <li key={index} className="flex items-start gap-2">
              <span className={cn('shrink-0 rounded px-1 text-xs font-semibold', SEVERITY_STYLE[finding.severity])}>{finding.severity}</span>
              <span className="text-foreground">{finding.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
