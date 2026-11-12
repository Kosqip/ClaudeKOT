import type { LLMProvider, OrchestratorSubtask, OrchestratorSubtaskAccess, ProviderRole } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Canonical provider order `resolveSubtaskProvider` picks the first match
 * from when more than one provider shares a role. Matches `LLMProvider`'s own
 * declaration order (`server/shared/types.ts`) rather than an arbitrary list,
 * so the tie-break never drifts out of sync with that union.
 */
const PROVIDER_RESOLUTION_ORDER: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode', 'openrouter'];

/**
 * Backends that only exchange text: no file access, no commands. The API
 * provider is one — it is a chat completion, not an agent. Work that needs
 * the project folder must not be planned for them, and they must be told so,
 * or they spend their turn explaining that they cannot open a file.
 */
const TEXT_ONLY_PROVIDERS: LLMProvider[] = ['openrouter'];

/** True when `provider` can only work from the text it is given. Used by the run to shape plans and subtask prompts. */
export function isTextOnlyProvider(provider: LLMProvider | null): boolean {
  return provider !== null && TEXT_ONLY_PROVIDERS.includes(provider);
}

const SUBTASK_SHAPE = '{"title": "short title", "description": "a complete, self-contained instruction — the backend that receives it has no other context from this conversation", "role": "hands", "access": "write"}';

const ROLE_AND_ACCESS_RULES = [
  'Assign each subtask exactly one role:',
  '- "hands": real execution work (coding, building, fixing, anything that needs judgment)',
  '- "routine": simple, low-stakes, repetitive work',
  'and exactly one access level:',
  '- "read": the backend only looks, analyses, reviews or answers — it cannot change files',
  '- "write": the backend changes files in the project folder',
  'All backends work in the same project folder. "write" subtasks run one after another in the order you list them, and each is told what the earlier ones reported; "read" subtasks listed next to each other run at the same time. Prefer few, substantial subtasks over many small ones.',
];

/**
 * Builds the message sent to the orchestrator's own session asking it to
 * split `task` into subtasks, each tagged with an abstract role
 * (`hands`/`routine`) rather than a concrete provider — the caller resolves
 * the role to whichever provider the user has actually assigned it to
 * (`resolveSubtaskProvider`), so this prompt never needs to know what
 * backends exist — and with the access it needs (`read`/`write`).
 *
 * Demands a single fenced JSON block and nothing else: `parseOrchestratorPlan`
 * does not repair a malformed response, the caller asks once more instead
 * (`buildPlanRetryPrompt`).
 */
export function buildPlanRequestPrompt(
  task: string,
  /** Roles whose backend can only work from text (see `isTextOnlyProvider`); the plan must not give them file work. */
  textOnlyRoles: Array<'hands' | 'routine'> = [],
): string {
  return [
    'You are planning how to split a task across other AI backends, each already running independently with no shared context with you or each other.',
    'Break the task below into one or more subtasks.',
    ...ROLE_AND_ACCESS_RULES,
    ...buildTextOnlyRule(textOnlyRoles),
    '',
    `Task:\n${task}`,
    '',
    'Respond with ONLY a single fenced JSON code block and nothing else before or after it — no prose, no explanation — in exactly this shape:',
    '```json',
    `{"subtasks": [${SUBTASK_SHAPE}]}`,
    '```',
  ].join('\n');
}

function buildTextOnlyRule(textOnlyRoles: Array<'hands' | 'routine'>): string[] {
  if (textOnlyRoles.length === 0) {
    return [];
  }
  const names = textOnlyRoles.map((role) => `"${role}"`).join(' and ');
  return [
    `Important: the ${names} backend here is a plain text model. It cannot open files, look at the project folder or run commands. Give it only work it can do from text alone — drafting, summarising, reviewing or answering — and put everything it needs to read into the description itself.`,
  ];
}

/** The one follow-up sent when a plan or review reply could not be parsed: names the problem and repeats the required shape. */
export function buildPlanRetryPrompt(problem: string, shape: 'plan' | 'review'): string {
  return [
    `Your last reply could not be used: ${problem}`,
    'Reply again with ONLY a single fenced JSON code block and nothing else, in exactly this shape:',
    '```json',
    shape === 'plan'
      ? `{"subtasks": [${SUBTASK_SHAPE}]}`
      : `{"status": "done", "summary": "what was achieved, for the user"}  or  {"status": "continue", "subtasks": [${SUBTASK_SHAPE}]}`,
    '```',
  ].join('\n');
}

/** Longest stretch of one subtask's reply that is passed on to later subtasks and back to the orchestrator. */
const MAX_REPORTED_RESULT_CHARS = 6000;

/** One finished subtask as it is described to another backend. */
export type SubtaskReport = { title: string; status: 'done' | 'failed' | 'skipped'; result: string };

function renderReports(reports: SubtaskReport[]): string {
  return reports.map((report, index) => {
    const body = report.result.length > MAX_REPORTED_RESULT_CHARS
      ? `${report.result.slice(0, MAX_REPORTED_RESULT_CHARS)}\n[…cut]`
      : report.result;
    return `### ${index + 1}. ${report.title} — ${report.status}\n${body || '(no reply)'}`;
  }).join('\n\n');
}

/**
 * The first message of a subtask's own session: the orchestrator's
 * instruction, what the subtasks before it reported (so work builds on work
 * instead of repeating it), and — for a `read` subtask — the plain statement
 * that it must not change anything, since not every backend can be held to
 * that by its tools alone.
 */
export function buildSubtaskPrompt(
  subtask: OrchestratorSubtask,
  earlier: SubtaskReport[],
  /** The receiving backend can only work from text (see `isTextOnlyProvider`). */
  textOnly = false,
): string {
  return [
    subtask.description,
    ...(textOnly
      ? ['', 'You have no access to files or commands here: work from the text in this message alone and give your result as text. If something essential is missing, do the part you can and say exactly what is missing.']
      : []),
    ...(subtask.access === 'read' && !textOnly
      ? ['', 'This is a read-only subtask: do not create, edit or delete any files and do not run commands that change anything. Report what you find.']
      : []),
    ...(earlier.length > 0
      ? ['', 'Other backends already worked on earlier parts of the same task in this project folder. Their reports:', '', renderReports(earlier)]
      : []),
    '',
    'End your reply with a short report of what you did or found — it is passed on to the backend coordinating this task.',
  ].join('\n');
}

/**
 * The message that takes a round's results back to the orchestrator and asks
 * for its verdict: close the task, or name what still has to be done. On the
 * last allowed round only closing is offered.
 */
export function buildReviewPrompt(
  task: string,
  reports: SubtaskReport[],
  canContinue: boolean,
  textOnlyRoles: Array<'hands' | 'routine'> = [],
): string {
  return [
    'The subtasks you planned have finished. Their reports:',
    '',
    renderReports(reports),
    '',
    `The original task was:\n${task}`,
    '',
    canContinue
      ? 'Check the reports against the task (look at the project folder yourself if you need to). If the task is complete, close it. If something is missing, wrong or failed, plan the follow-up subtasks — only what is still needed.'
      : 'Check the reports against the task (look at the project folder yourself if you need to) and close it: no further subtasks can be started, so say plainly what was achieved and what is still open.',
    'A report in which the backend says it was blocked, lacked access or could not do the work is a failed subtask, whatever its status line says — never describe such work as done.',
    ...(canContinue ? [...ROLE_AND_ACCESS_RULES, ...buildTextOnlyRule(textOnlyRoles)] : []),
    '',
    'Respond with ONLY a single fenced JSON code block and nothing else, in one of these shapes:',
    '```json',
    '{"status": "done", "summary": "what was achieved, for the user"}',
    '```',
    ...(canContinue ? ['```json', `{"status": "continue", "subtasks": [${SUBTASK_SHAPE}]}`, '```'] : []),
  ].join('\n');
}

/**
 * Reads the JSON object out of an orchestrator reply. The reply is asked to
 * be one fenced block, but a subtask description may itself contain code
 * fences (a file's content to write, say), so the first closing fence is
 * not necessarily the end of the JSON. Each reading is tried in turn: up to
 * the first closing fence, up to the last one, and from the first `{` to the
 * last `}` of the whole reply.
 */
function parseJsonReply(responseText: string): unknown {
  const candidates: string[] = [];
  const opening = responseText.search(/```json/i);
  if (opening >= 0) {
    const afterOpening = responseText.slice(opening).replace(/^```json\s*/i, '');
    const firstClose = afterOpening.indexOf('```');
    const lastClose = afterOpening.lastIndexOf('```');
    if (firstClose >= 0) {
      candidates.push(afterOpening.slice(0, firstClose));
    }
    if (lastClose > firstClose) {
      candidates.push(afterOpening.slice(0, lastClose));
    }
  }
  const firstBrace = responseText.indexOf('{');
  const lastBrace = responseText.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(responseText.slice(firstBrace, lastBrace + 1));
  }
  candidates.push(responseText.trim());

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next reading.
    }
  }
  throw new AppError(
    `The orchestrator's response was not valid JSON. Raw response:\n\n${responseText}`,
    { code: 'ORCHESTRATOR_PLAN_PARSE_FAILED', statusCode: 502 },
  );
}

function readSubtasks(subtasksRaw: unknown, responseText: string): OrchestratorSubtask[] {
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
      || (record?.access !== undefined && record.access !== 'read' && record.access !== 'write')
    ) {
      throw new AppError(
        `Subtask ${index} is missing a valid "title", "description", "role" ("hands"/"routine") or "access" ("read"/"write"). Raw response:\n\n${responseText}`,
        { code: 'ORCHESTRATOR_PLAN_PARSE_FAILED', statusCode: 502 },
      );
    }
    return {
      title: record.title,
      description: record.description,
      role: record.role,
      // Unstated access is full access: withholding tools a subtask needs fails it, which is worse.
      access: record.access === 'read' ? 'read' : 'write',
    };
  });
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
  return readSubtasks((parseJsonReply(responseText) as Record<string, unknown> | null)?.subtasks, responseText);
}

/** The orchestrator's verdict on a finished round. */
export type OrchestratorReview =
  | { status: 'done'; summary: string }
  | { status: 'continue'; subtasks: OrchestratorSubtask[] };

/** Parses the orchestrator's verdict on a round; throws `AppError` on any other shape, like `parseOrchestratorPlan`. */
export function parseOrchestratorReview(responseText: string): OrchestratorReview {
  const parsed = parseJsonReply(responseText) as Record<string, unknown> | null;
  if (parsed?.status === 'done') {
    return { status: 'done', summary: typeof parsed.summary === 'string' ? parsed.summary : '' };
  }
  if (parsed?.status === 'continue') {
    return { status: 'continue', subtasks: readSubtasks(parsed.subtasks, responseText) };
  }
  throw new AppError(
    `The orchestrator's review had no "status" of "done" or "continue". Raw response:\n\n${responseText}`,
    { code: 'ORCHESTRATOR_PLAN_PARSE_FAILED', statusCode: 502 },
  );
}

/**
 * Groups a plan into the steps it runs in: consecutive `read` subtasks form
 * one step and run together, every `write` subtask is a step of its own.
 * Two backends editing the same folder at once overwrite each other's work;
 * reading at once is harmless.
 */
export function groupSubtasksIntoSteps<T extends { access: OrchestratorSubtaskAccess }>(subtasks: T[]): T[][] {
  const steps: T[][] = [];
  for (const subtask of subtasks) {
    const last = steps[steps.length - 1];
    if (subtask.access === 'read' && last && last[0].access === 'read') {
      last.push(subtask);
    } else {
      steps.push([subtask]);
    }
  }
  return steps;
}

/**
 * The turn options that hold a subtask to its access level on `provider`.
 * `write` is the backend's ordinary behaviour. `read` withholds editing
 * with whatever that backend offers: Claude's tool lists, Codex's read-only
 * sandbox, OpenCode's plan agent. Cursor has no such switch and the API
 * provider has no tools at all, so for them the instruction in
 * `buildSubtaskPrompt` is the whole restriction.
 */
export function buildSubtaskTurnOptions(provider: LLMProvider, access: OrchestratorSubtaskAccess): Record<string, unknown> {
  if (access === 'write') {
    return {};
  }
  switch (provider) {
    case 'claude':
      return {
        toolsSettings: {
          allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
          disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
          skipPermissions: false,
        },
      };
    case 'codex':
      return { permissionMode: 'readOnly' };
    case 'opencode':
      return { permissionMode: 'plan' };
    default:
      return {};
  }
}

/**
 * Picks the backend a subtask goes to. First choice is a backend the user
 * gave the subtask's own role, in `PROVIDER_RESOLUTION_ORDER`. When nobody
 * holds that role the work is not dropped: a `routine` subtask goes to a
 * `hands` backend, and failing that — or for a `hands` subtask with no
 * `hands` backend — to the orchestrator's own backend, in a fresh session.
 * A user with one subscription and one API key (Claude as orchestrator, a
 * free model for routine) still gets every subtask done this way. Returns
 * `null` only when no backend has any of these roles.
 */
export function resolveSubtaskProvider(
  role: ProviderRole,
  providerRoles: Partial<Record<LLMProvider, ProviderRole>>,
  /** Lets the caller pass over a backend that cannot take work right now (at its usage limit). */
  isAvailable: (provider: LLMProvider) => boolean = () => true,
): LLMProvider | null {
  const fallbackRoles: ProviderRole[] = role === 'routine' ? ['routine', 'hands', 'orchestrator'] : [role, 'orchestrator'];
  for (const candidateRole of [...new Set(fallbackRoles)]) {
    const holders = PROVIDER_RESOLUTION_ORDER.filter((provider) => providerRoles[provider] === candidateRole);
    // A holder at its limit is still better than none: its session then hands off like any other.
    const chosen = holders.find(isAvailable) ?? holders[0];
    if (chosen) {
      return chosen;
    }
  }
  return null;
}
