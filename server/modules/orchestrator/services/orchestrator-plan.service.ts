import type { LLMProvider, OrchestratorSubtask, ProviderRole } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Canonical provider order `resolveSubtaskProvider` picks the first match
 * from when more than one provider shares a role. Matches `LLMProvider`'s own
 * declaration order (`server/shared/types.ts`) rather than an arbitrary list,
 * so the tie-break never drifts out of sync with that union.
 */
const PROVIDER_RESOLUTION_ORDER: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode', 'openrouter'];

/**
 * Builds the message sent to the orchestrator's own session asking it to
 * split `task` into subtasks, each tagged with an abstract role
 * (`hands`/`routine`) rather than a concrete provider — the caller resolves
 * the role to whichever provider the user has actually assigned it to
 * (`resolveSubtaskProvider`), so this prompt never needs to know what
 * backends exist.
 *
 * Demands a single fenced JSON block and nothing else, because
 * `parseOrchestratorPlan` does not attempt to repair or guess at a
 * malformed response — a model that ignores the format fails the whole
 * plan with the raw text surfaced for the user to see why.
 */
export function buildPlanRequestPrompt(task: string): string {
  return [
    'You are planning how to split a task across other AI backends, each already running independently with no shared context with you or each other.',
    'Break the task below into one or more subtasks. Assign each subtask exactly one role:',
    '- "hands": real execution work (coding, building, fixing, anything that needs judgment)',
    '- "routine": simple, low-stakes, repetitive work',
    '',
    `Task:\n${task}`,
    '',
    'Respond with ONLY a single fenced JSON code block and nothing else before or after it — no prose, no explanation — in exactly this shape:',
    '```json',
    '{"subtasks": [{"title": "short title", "description": "a complete, self-contained instruction — the backend that receives it has no other context from this conversation", "role": "hands"}]}',
    '```',
  ].join('\n');
}

/**
 * Parses the orchestrator's response into a validated subtask list.
 *
 * Looks for a fenced ```json block first (what the prompt asks for) and
 * falls back to parsing the whole trimmed response as JSON, in case a model
 * dropped the fence but still returned otherwise-valid JSON. Throws
 * `AppError` with the raw response text included on any other shape —
 * deliberately not an attempt to coerce a near-miss into something usable,
 * since a silently "fixed" plan could misroute real work to the wrong
 * backend.
 */
export function parseOrchestratorPlan(responseText: string): OrchestratorSubtask[] {
  const fencedMatch = responseText.match(/```json\s*([\s\S]*?)```/i);
  const jsonText = fencedMatch ? fencedMatch[1] : responseText.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new AppError(
      `The orchestrator's response was not valid JSON. Raw response:\n\n${responseText}`,
      { code: 'ORCHESTRATOR_PLAN_PARSE_FAILED', statusCode: 502 },
    );
  }

  const subtasksRaw = (parsed as Record<string, unknown> | null)?.subtasks;
  if (!Array.isArray(subtasksRaw) || subtasksRaw.length === 0) {
    throw new AppError(
      `The orchestrator's response had no "subtasks" array. Raw response:\n\n${responseText}`,
      { code: 'ORCHESTRATOR_PLAN_PARSE_FAILED', statusCode: 502 },
    );
  }

  return subtasksRaw.map((entry, index) => {
    const record = entry as Record<string, unknown>;
    if (
      typeof record?.title !== 'string' || !record.title.trim()
      || typeof record?.description !== 'string' || !record.description.trim()
      || (record?.role !== 'hands' && record?.role !== 'routine')
    ) {
      throw new AppError(
        `Subtask ${index} is missing a valid "title", "description", or "role" ("hands"/"routine"). Raw response:\n\n${responseText}`,
        { code: 'ORCHESTRATOR_PLAN_PARSE_FAILED', statusCode: 502 },
      );
    }
    return { title: record.title, description: record.description, role: record.role };
  });
}

/**
 * Finds the first provider the user has assigned `role` to, in
 * `PROVIDER_RESOLUTION_ORDER`. Returns `null` when no provider holds that
 * role — the caller reports that subtask as skipped rather than guessing at
 * a substitute, since a user who assigned no "routine" provider, say, has
 * not opted into one existing by default.
 */
export function resolveSubtaskProvider(
  role: ProviderRole,
  providerRoles: Partial<Record<LLMProvider, ProviderRole>>,
): LLMProvider | null {
  return PROVIDER_RESOLUTION_ORDER.find((provider) => providerRoles[provider] === role) ?? null;
}
