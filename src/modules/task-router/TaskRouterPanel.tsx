import { useState } from 'react';

import { useTaskRouter, type TaskTag } from '@/modules/task-router/hooks/useTaskRouter.js';

const TAG_OPTIONS: Array<{ value: TaskTag | 'auto'; label: string }> = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'routine', label: 'Routine' },
  { value: 'coding', label: 'Coding' },
  { value: 'second_opinion', label: 'Second opinion' },
  { value: 'complex', label: 'Complex decision' },
];

const TAG_LABEL: Record<TaskTag, string> = {
  routine: 'Routine',
  coding: 'Coding',
  second_opinion: 'Second opinion',
  complex: 'Complex decision',
};

/**
 * Lets the user pick a task tag (or "Auto-detect", which lets the server's
 * keyword config in `task-router.config.json` decide) and routes the task
 * per the tag's fixed rule — routine to a free OpenRouter model, coding to
 * Claude, second_opinion to Claude and Codex together, complex to nothing
 * (the user is told to pick a backend manually instead). Rendered by the
 * chat module next to `MixSendPanel`/`OrchestratorPlanPanel`, always
 * visible — unlike the orchestrator panel, this one is not gated on any
 * provider role.
 */
export function TaskRouterPanel({
  projectPath,
  onOpenSession,
}: {
  projectPath: string;
  onOpenSession: (sessionId: string) => void;
}) {
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
      <p className="text-sm text-muted-foreground">
        Route one task by tag — routine to a free model, coding to Claude, second opinion to Claude and Codex together.
      </p>
      <select
        value={selectedTag}
        onChange={(event) => setSelectedTag(event.target.value as TaskTag | 'auto')}
        className="rounded-md border border-input bg-background p-2 text-sm"
      >
        {TAG_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder="Task to route"
        className="min-h-20 rounded-md border border-input bg-background p-2 text-sm"
      />
      <button
        type="button"
        onClick={() => void handleDispatch()}
        disabled={!canDispatch}
        className="self-end rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
      >
        {isDispatching ? 'Routing…' : 'Route task'}
      </button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {result ? (
        <div className="text-sm">
          <p className="font-medium">
            Tag: {TAG_LABEL[result.tag]} {result.autoDetected ? '(auto-detected)' : '(chosen manually)'}
          </p>
          {result.manualSelectionRequired ? (
            <p className="text-muted-foreground">
              This is a complex decision — pick a backend yourself instead of auto-routing.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {result.sessions.map((session) => (
                <li key={session.sessionId} className="flex items-center justify-between gap-2">
                  <span>
                    {session.provider}: {session.started ? 'started' : session.error ?? 'failed'}
                  </span>
                  {session.started ? (
                    <button
                      type="button"
                      onClick={() => onOpenSession(session.sessionId)}
                      className="text-primary underline"
                    >
                      Open
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
