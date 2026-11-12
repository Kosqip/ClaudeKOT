import { useState } from 'react';

import { useOrchestratorPlan } from '@/modules/orchestrator/hooks/useOrchestratorPlan.js';

const ROLE_LABEL: Record<'hands' | 'routine', string> = {
  hands: 'hands',
  routine: 'routine',
};

/**
 * Lets the user manually split a task into subtasks on the current session
 * (whose provider must already hold the "orchestrator" role) and shows the
 * resulting plan — each subtask names its role, the provider it was sent to
 * (or why it was skipped), and a link to open its brand-new session.
 * Rendered by the chat module next to `MixSendPanel`, only when the current
 * session's provider has the orchestrator role.
 */
export function OrchestratorPlanPanel({
  sessionId,
  onOpenSubtaskSession,
}: {
  sessionId: string;
  onOpenSubtaskSession: (sessionId: string) => void;
}) {
  const [task, setTask] = useState('');
  const { plan, isPlanning, subtasks, error } = useOrchestratorPlan();

  const canSplit = task.trim().length > 0 && !isPlanning;

  const handleSplit = async () => {
    if (!canSplit) return;
    await plan(sessionId, task).catch(() => undefined);
  };

  return (
    <div className="orchestrator-plan-panel flex flex-col gap-2 rounded-md border border-border p-3">
      <p className="text-sm text-muted-foreground">
        Split a task into subtasks and dispatch each to whichever backend holds its role.
      </p>
      <textarea
        value={task}
        onChange={(event) => setTask(event.target.value)}
        placeholder="Task to split into subtasks"
        className="min-h-20 rounded-md border border-input bg-background p-2 text-sm"
      />
      <button
        type="button"
        onClick={() => void handleSplit()}
        disabled={!canSplit}
        className="self-end rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
      >
        {isPlanning ? 'Splitting…' : 'Split into subtasks'}
      </button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {subtasks ? (
        <ul className="flex flex-col gap-1 text-sm">
          {subtasks.map((subtask) => (
            <li key={subtask.title} className="flex items-center justify-between gap-2">
              <span>
                <strong>{subtask.title}</strong> — {ROLE_LABEL[subtask.role]}
                {subtask.provider ? ` (${subtask.provider})` : ''}
                {': '}
                {subtask.started ? 'started' : subtask.error ?? 'skipped'}
              </span>
              {subtask.sessionId && subtask.started ? (
                <button
                  type="button"
                  onClick={() => onOpenSubtaskSession(subtask.sessionId!)}
                  className="text-primary underline"
                >
                  Open
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
