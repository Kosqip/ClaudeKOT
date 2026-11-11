import { useState } from 'react';

import { useMixDispatch } from '@/modules/mix/hooks/useMixDispatch.js';
import type { ProjectSession } from '@/shared/types.js';

type MixCandidate = Pick<ProjectSession, 'id' | 'provider' | 'title' | 'name'>;

/**
 * Lets the user pick two or more sessions of the current project — each
 * already bound to its own provider (Claude Code, Codex, OpenRouter, ...) —
 * and send one message to all of them at once.
 *
 * Each target session keeps streaming its reply the normal way (its own
 * `chat.subscribe` channel already labels every message with its
 * `provider`); this panel only starts the turns and shows which of them
 * actually started. Rendered by the chat module next to the regular
 * single-session composer.
 */
export function MixSendPanel({ candidates }: { candidates: MixCandidate[] }) {
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

  return (
    <div className="mix-send-panel flex flex-col gap-2 rounded-md border border-border p-3">
      <p className="text-sm text-muted-foreground">
        Send one message to several sessions at once — pick two or more below.
      </p>
      <ul className="flex flex-col gap-1">
        {candidates.map((candidate) => (
          <li key={candidate.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`mix-target-${candidate.id}`}
              checked={selectedIds.includes(candidate.id)}
              onChange={() => toggle(candidate.id)}
            />
            <label htmlFor={`mix-target-${candidate.id}`} className="text-sm">
              {candidate.title ?? candidate.name ?? candidate.id} — {candidate.provider ?? 'unknown'}
            </label>
          </li>
        ))}
      </ul>
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder="Message to send to every selected session"
        className="min-h-20 rounded-md border border-input bg-background p-2 text-sm"
      />
      <button
        type="button"
        onClick={handleSend}
        disabled={!canSend}
        className="self-end rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
      >
        {isDispatching ? 'Sending…' : 'Send to selected'}
      </button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {results ? (
        <ul className="flex flex-col gap-1 text-sm">
          {results.map((result) => (
            <li key={result.sessionId}>
              {result.provider}: {result.started ? 'started' : `failed — ${result.error}`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
