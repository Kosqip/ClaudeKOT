import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { ProjectSession } from '@/shared/types';

/** How many of the project's most recent sessions are offered as targets. */
const CANDIDATE_LIMIT = 50;

/** A reload asked for sooner than this after the last one is skipped. */
const RELOAD_THROTTLE_MS = 5000;

/** The project's recent sessions, or null when they could not be read. */
async function fetchCandidates(projectId: string): Promise<ProjectSession[] | null> {
  try {
    const response = await api.projectSessions(projectId, { limit: CANDIDATE_LIMIT });
    if (!response.ok) {
      return null;
    }
    const data = await response.json() as { sessions?: ProjectSession[] };
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch {
    return null;
  }
}

/**
 * The sessions of one project a mix message can be sent to, read from the
 * server rather than from the chat view's own copy of the project: that copy
 * is a snapshot which is not kept in step with the session list (and holds
 * no sessions at all when the chat was opened by a direct link), so sessions
 * created since — by a handoff or the task router, say — would be missing.
 *
 * `reload` is cheap to call often; `MixSendPanel` calls it whenever the user
 * moves into the panel. A failed read keeps the list already shown.
 */
export function useMixCandidates(projectId: string) {
  const [candidates, setCandidates] = useState<ProjectSession[]>([]);
  const lastLoadedAtRef = useRef(0);

  useEffect(() => {
    if (!projectId) {
      return undefined;
    }
    let isCurrent = true;
    lastLoadedAtRef.current = Date.now();
    void fetchCandidates(projectId).then((loaded) => {
      if (isCurrent && loaded) {
        setCandidates(loaded);
      }
    });
    return () => {
      isCurrent = false;
    };
  }, [projectId]);

  const reload = useCallback(async () => {
    if (!projectId || Date.now() - lastLoadedAtRef.current < RELOAD_THROTTLE_MS) {
      return;
    }
    lastLoadedAtRef.current = Date.now();
    const loaded = await fetchCandidates(projectId);
    if (loaded) {
      setCandidates(loaded);
    }
  }, [projectId]);

  return { candidates, reload };
}
