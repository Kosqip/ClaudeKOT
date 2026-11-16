import type {
  LLMProvider,
  OrchestratorClaimOutcome,
  OrchestratorCommitteeClaim,
  OrchestratorCommitteeVote,
  OrchestratorFindingSeverity,
  OrchestratorReviewFinding,
  OrchestratorSubtask,
  OrchestratorSubtaskAccess,
  ProviderRole,
} from '@/shared/types.js';
import { AppError, isTextOnlyProvider } from '@/shared/utils.js';

// isTextOnlyProvider re-exported for this module's existing consumers
// (orchestrator-dispatch.service.ts and this module's own tests); its
// definition now lives in @/shared/utils.js since the handoff module needs
// it too.
export { isTextOnlyProvider };

/**
 * Canonical provider order `resolveSubtaskProvider` picks the first match
 * from when more than one provider shares a role. Matches `LLMProvider`'s own
 * declaration order (`server/shared/types.ts`) rather than an arbitrary list,
 * so the tie-break never drifts out of sync with that union.
 */
const PROVIDER_RESOLUTION_ORDER: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode', 'openrouter'];

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
/**
 * Put in front of a plan or review request when it goes to a backend that
 * takes the coordination over in a new session (the previous orchestrator
 * ran out of usage): the request itself already carries the task and the
 * reports, this only says why it arrives without a conversation before it.
 */
export function buildCoordinatorTakeoverNote(): string {
  return 'You are taking over the coordination of a task from another AI backend that ran out of its usage limit. Everything you need is in this message; the earlier conversation is not available to you.\n\n';
}

export function buildPlanRetryPrompt(problem: string, shape: 'plan' | 'review' | 'claims'): string {
  const expected = {
    plan: `{"subtasks": [${SUBTASK_SHAPE}]}`,
    review: `{"status": "done", "summary": "what was achieved, for the user"}  or  {"status": "continue", "subtasks": [${SUBTASK_SHAPE}]}`,
    claims: COMMITTEE_CLAIMS_SHAPE,
  };
  return [
    `Your last reply could not be used: ${problem}`,
    'Reply again with ONLY a single fenced JSON code block and nothing else, in exactly this shape:',
    '```json',
    expected[shape],
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
  /** Another backend already began this subtask and was cut off (usage limit, restart). */
  takenOver = false,
): string {
  return [
    subtask.description,
    ...(takenOver && !textOnly
      ? ['', 'Another backend already started on this and was cut off before finishing, so some of it may be half-done. Check the actual state of the project folder first (for example `git status` and `git diff`) and continue from there instead of starting over.']
      : []),
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

// ---------------------------
// Pair mode: one writer and one read-only reviewer take turns on the whole task.

/** The line a pair run's writer ends its reply with; `parsePairWriterDone` looks for it. */
const WRITER_STATUS_LINE = /WRITER_STATUS:\s*(done|not_done)\b/gi;

const PAIR_REVIEW_SHAPE = '{"status": "approved"}  or  {"status": "changes", "findings": [{"severity": "P0", "text": "what is wrong, where, and what to do"}]}';

const PAIR_SEVERITY_RULES = [
  'Severity:',
  '- "P0": broken, wrong or unsafe — the work must not ship like this',
  '- "P1": a real defect or a requirement of the task that is missing',
  '- "P2": a minor improvement; optional',
];

function renderFindings(findings: OrchestratorReviewFinding[]): string {
  return findings.map((finding) => `- [${finding.severity}] ${finding.text}`).join('\n');
}

function cutReport(report: string): string {
  return report.length > MAX_REPORTED_RESULT_CHARS ? `${report.slice(0, MAX_REPORTED_RESULT_CHARS)}\n[…cut]` : report;
}

/**
 * The message of a pair run's writer turn. The first round gets the task
 * alone; later ones also get the reviewer's findings from the round before
 * (P0/P1 to fix, P2 optional) and the writer's own previous report, since
 * every round starts in a new session. `userContinued` says the user saw a
 * finding come back twice and asked for another round anyway. The writer is
 * asked to end with a `WRITER_STATUS` line (`parsePairWriterDone`).
 */
export function buildPairWriterPrompt(input: {
  task: string;
  round: number;
  previousFindings: OrchestratorReviewFinding[];
  previousReport: string | null;
  userContinued: boolean;
  takenOver: boolean;
}): string {
  const mustFix = input.previousFindings.filter((finding) => finding.severity !== 'P2');
  const optional = input.previousFindings.filter((finding) => finding.severity === 'P2');
  return [
    'You are the writer in a writer–reviewer pair. You do the work in the project folder; another AI backend reviews it after each of your turns, read-only, and its findings come back to you.',
    '',
    `Task:\n${input.task}`,
    ...(input.round > 1 && input.previousReport
      ? ['', `Your report from the previous round (round ${input.round - 1}):`, cutReport(input.previousReport)]
      : []),
    ...(mustFix.length > 0 ? ['', 'The reviewer found these problems. Fix every one of them:', renderFindings(mustFix)] : []),
    ...(optional.length > 0 ? ['', 'Minor suggestions from the reviewer (optional):', renderFindings(optional)] : []),
    ...(input.round > 1 && input.previousFindings.length === 0
      ? ['', 'The reviewer had no findings on your previous round, but you said the work was not finished. Continue it.']
      : []),
    ...(input.userContinued
      ? ['', 'The same finding came back two rounds in a row, and the user asked for another round. Either fix it in a different way or explain clearly in your report why it should stay as it is.']
      : []),
    ...(input.takenOver
      ? ['', 'Another backend already started this round and was cut off before finishing, so some of it may be half-done. Check the actual state of the project folder first (for example `git status` and `git diff`) and continue from there.']
      : []),
    '',
    'End your reply with a short report of what you did, and then, on its own last line, exactly one of:',
    'WRITER_STATUS: done      — the task is complete as far as you can tell',
    'WRITER_STATUS: not_done  — work remains',
  ].join('\n');
}

/**
 * Whether a pair writer's reply says the work is finished: the last
 * `WRITER_STATUS` line wins. A reply without one counts as not finished —
 * a pair run closes only on the writer's explicit word.
 */
export function parsePairWriterDone(reply: string): boolean {
  const matches = [...reply.matchAll(WRITER_STATUS_LINE)];
  return matches.length > 0 && matches[matches.length - 1][1].toLowerCase() === 'done';
}

/** The writer's report without its `WRITER_STATUS` line, as shown to the reviewer and the user. */
export function stripPairWriterStatus(reply: string): string {
  return reply.replace(WRITER_STATUS_LINE, '').trim();
}

/**
 * The message of a pair run's reviewer turn: the task, the writer's report,
 * the plain statement that it must not change anything (its turn is also
 * started with editing withheld — `buildSubtaskTurnOptions(provider, 'read')`),
 * and the JSON verdict it must answer with (`parsePairReview`).
 */
export function buildPairReviewPrompt(input: {
  task: string;
  round: number;
  writerReport: string;
  previousFindings: OrchestratorReviewFinding[];
}): string {
  return [
    'You are the reviewer in a writer–reviewer pair. Another AI backend (the writer) works on the task below in this project folder; you check its work.',
    'This is a read-only review: do not create, edit or delete any files and do not run commands that change anything.',
    '',
    `Task:\n${input.task}`,
    '',
    `The writer's report for round ${input.round}:`,
    cutReport(input.writerReport) || '(no report)',
    ...(input.previousFindings.length > 0
      ? ['', 'Your findings from the previous round, which the writer was asked to fix:', renderFindings(input.previousFindings)]
      : []),
    '',
    'Check the actual project folder (for example `git diff` and the files themselves), not only the report. Report only real problems against the task.',
    ...PAIR_SEVERITY_RULES,
    '',
    'Respond with ONLY a single fenced JSON code block and nothing else, in one of these shapes:',
    '```json',
    PAIR_REVIEW_SHAPE,
    '```',
  ].join('\n');
}

/** The one follow-up a pair reviewer gets when its verdict could not be read: names the problem and repeats the shape. */
export function buildPairReviewRetryPrompt(problem: string): string {
  return [
    `Your last reply could not be used: ${problem}`,
    'Reply again with ONLY a single fenced JSON code block and nothing else, in exactly this shape:',
    '```json',
    PAIR_REVIEW_SHAPE,
    '```',
  ].join('\n');
}

/** A pair reviewer's verdict on one round. */
export type PairReview = { status: 'approved' | 'changes'; findings: OrchestratorReviewFinding[] };

const FINDING_SEVERITIES: OrchestratorFindingSeverity[] = ['P0', 'P1', 'P2'];

/**
 * Parses a pair reviewer's JSON verdict. `approved` may come without
 * findings; `changes` carries a list of `{severity, text}`. Throws
 * `AppError` with the raw reply on any other shape, like
 * `parseOrchestratorPlan` — the caller asks once more.
 */
export function parsePairReview(responseText: string): PairReview {
  const parsed = parseJsonReply(responseText) as Record<string, unknown> | null;
  if (parsed?.status !== 'approved' && parsed?.status !== 'changes') {
    throw new AppError(
      `The review had no "status" of "approved" or "changes". Raw response:\n\n${responseText}`,
      { code: 'ORCHESTRATOR_PLAN_PARSE_FAILED', statusCode: 502 },
    );
  }
  const findingsRaw = parsed.findings ?? [];
  if (!Array.isArray(findingsRaw)) {
    throw new AppError(`The review's "findings" is not a list. Raw response:\n\n${responseText}`, {
      code: 'ORCHESTRATOR_PLAN_PARSE_FAILED',
      statusCode: 502,
    });
  }
  const findings = findingsRaw.map((entry, index): OrchestratorReviewFinding => {
    const record = entry as Record<string, unknown>;
    const severity = typeof record?.severity === 'string' ? record.severity.toUpperCase() : '';
    if (!(FINDING_SEVERITIES as string[]).includes(severity) || typeof record?.text !== 'string' || !record.text.trim()) {
      throw new AppError(
        `Finding ${index} is missing a valid "severity" ("P0"/"P1"/"P2") or "text". Raw response:\n\n${responseText}`,
        { code: 'ORCHESTRATOR_PLAN_PARSE_FAILED', statusCode: 502 },
      );
    }
    return { severity: severity as OrchestratorFindingSeverity, text: record.text.trim() };
  });
  return { status: parsed.status, findings };
}

/** The findings that keep a pair run open: P0 and P1 of a `changes` verdict. An approval leaves nothing open. */
export function listOpenPairFindings(review: { verdict?: 'approved' | 'changes'; findings: OrchestratorReviewFinding[] }): OrchestratorReviewFinding[] {
  return review.verdict === 'changes' ? review.findings.filter((finding) => finding.severity !== 'P2') : [];
}

function normalizeFindingText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * The open (P0/P1) findings of `current` that were also open in `previous`,
 * compared by their text with case, punctuation and spacing ignored — a
 * severity that moved between P0 and P1 is still the same finding. Two
 * rounds in a row with one of these means the pair is stuck on it.
 */
export function findRepeatedPairFindings(
  previous: { verdict?: 'approved' | 'changes'; findings: OrchestratorReviewFinding[] },
  current: { verdict?: 'approved' | 'changes'; findings: OrchestratorReviewFinding[] },
): OrchestratorReviewFinding[] {
  const earlier = new Set(listOpenPairFindings(previous).map((finding) => normalizeFindingText(finding.text)));
  return listOpenPairFindings(current).filter((finding) => earlier.has(normalizeFindingText(finding.text)));
}

// ---------------------------
// Committee mode: blind answers → merged claims → a vote on each claim → a summary.

const COMMITTEE_CLAIMS_SHAPE = '{"claims": [{"text": "one self-contained, checkable statement"}]}';
const COMMITTEE_VOTES_SHAPE = '{"votes": [{"claim": 1, "vote": "agree"}]}';
/** Most claims kept from the merge — more would make every ballot a chore and the vote noisy. */
const MAX_COMMITTEE_CLAIMS = 15;
const COMMITTEE_VOTES: OrchestratorCommitteeVote[] = ['agree', 'disagree', 'unsure'];

/**
 * The message of a committee member's answer turn. The member is told it
 * answers independently and will not see the others, works read-only, and
 * should make concrete statements — they become the claims everyone votes on.
 */
export function buildCommitteeAnswerPrompt(task: string, textOnly: boolean, takenOver: boolean): string {
  return [
    'You are one of several AI backends asked the same question independently. You will not see the other answers, and they will not see yours; afterwards the answers are merged into a list of claims that every backend votes on.',
    textOnly
      ? 'You have no access to files or commands here: answer from the text in this message alone and say plainly what you cannot know without the project.'
      : 'This is read-only: you may look at the project folder, but do not create, edit or delete any files and do not run commands that change anything.',
    ...(takenOver ? ['Another backend began this answer and was cut off; start your own answer from scratch.'] : []),
    '',
    `Question or task:\n${task}`,
    '',
    'Give your full answer. Make concrete, checkable statements rather than general remarks, and say how sure you are where it matters.',
  ].join('\n');
}

/**
 * The orchestrator's request to merge the members' answers into one list of
 * distinct claims. The answers are labelled A, B, C… without their backends,
 * so the merge cannot lean towards its own backend's answer.
 */
export function buildCommitteeClaimsPrompt(task: string, answers: string[]): string {
  const letters = answers.map((_answer, index) => String.fromCharCode(65 + index));
  return [
    'Several AI backends answered the same question independently. Merge their answers into one list of distinct claims for them to vote on.',
    '',
    `Question or task:\n${task}`,
    '',
    ...answers.flatMap((answer, index) => [`### Answer ${letters[index]}`, cutReport(answer) || '(empty)', '']),
    `Rules: each claim is one self-contained statement that can be agreed or disagreed with on its own. Keep claims that only one answer makes. When answers contradict each other, list each side as its own claim. Merge claims that say the same thing. At most ${MAX_COMMITTEE_CLAIMS} claims, most important first.`,
    '',
    'Respond with ONLY a single fenced JSON code block and nothing else, in exactly this shape:',
    '```json',
    COMMITTEE_CLAIMS_SHAPE,
    '```',
  ].join('\n');
}

/** Parses the merged claims, numbering them from 1; throws `AppError` on any other shape (the caller asks once more). */
export function parseCommitteeClaims(responseText: string): OrchestratorCommitteeClaim[] {
  const raw = (parseJsonReply(responseText) as Record<string, unknown> | null)?.claims;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError(`The reply had no "claims" list. Raw response:\n\n${responseText}`, {
      code: 'ORCHESTRATOR_PLAN_PARSE_FAILED',
      statusCode: 502,
    });
  }
  const texts = raw.map((entry) => {
    const text = typeof entry === 'string' ? entry : (entry as Record<string, unknown> | null)?.text;
    return typeof text === 'string' ? text.trim() : '';
  }).filter(Boolean);
  if (texts.length === 0) {
    throw new AppError(`Every claim was empty. Raw response:\n\n${responseText}`, {
      code: 'ORCHESTRATOR_PLAN_PARSE_FAILED',
      statusCode: 502,
    });
  }
  return texts.slice(0, MAX_COMMITTEE_CLAIMS).map((text, index) => ({ id: index + 1, text, votes: {} }));
}

/** The message of a member's ballot turn: the numbered claims and the JSON vote it must answer with (`parseCommitteeVotes`). */
export function buildCommitteeVotePrompt(task: string, claims: OrchestratorCommitteeClaim[], textOnly: boolean): string {
  return [
    'Several AI backends, you among them, answered the question below independently. Their answers were merged into the numbered claims below. Vote on every claim on its merits — whoever made it.',
    textOnly
      ? 'You have no access to files or commands here: judge from the text alone.'
      : 'This is read-only: you may check claims against the project folder, but do not change anything.',
    '',
    `Question or task:\n${task}`,
    '',
    'Claims:',
    ...claims.map((claim) => `${claim.id}. ${claim.text}`),
    '',
    'For each claim vote "agree", "disagree" or "unsure".',
    'Respond with ONLY a single fenced JSON code block and nothing else, in exactly this shape, with one entry per claim:',
    '```json',
    COMMITTEE_VOTES_SHAPE,
    '```',
  ].join('\n');
}

/** The one follow-up a member gets when its ballot could not be read. */
export function buildCommitteeVoteRetryPrompt(problem: string): string {
  return [
    `Your last reply could not be used: ${problem}`,
    'Reply again with ONLY a single fenced JSON code block and nothing else, in exactly this shape, with one entry per claim:',
    '```json',
    COMMITTEE_VOTES_SHAPE,
    '```',
  ].join('\n');
}

/**
 * Parses a member's ballot into claim id → vote. Entries for unknown claims
 * are dropped and a claim without an entry stays unvoted. Throws `AppError`
 * when there is no `votes` list or not a single usable entry.
 */
export function parseCommitteeVotes(responseText: string, claimIds: number[]): Map<number, OrchestratorCommitteeVote> {
  const raw = (parseJsonReply(responseText) as Record<string, unknown> | null)?.votes;
  const votes = new Map<number, OrchestratorCommitteeVote>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const record = entry as Record<string, unknown> | null;
      const claim = Number(record?.claim);
      const vote = typeof record?.vote === 'string' ? record.vote.toLowerCase() : '';
      if (claimIds.includes(claim) && (COMMITTEE_VOTES as string[]).includes(vote)) {
        votes.set(claim, vote as OrchestratorCommitteeVote);
      }
    }
  }
  if (votes.size === 0) {
    throw new AppError(`The ballot had no usable "votes". Raw response:\n\n${responseText}`, {
      code: 'ORCHESTRATOR_PLAN_PARSE_FAILED',
      statusCode: 502,
    });
  }
  return votes;
}

/** Counts a claim's votes and names its outcome (see `OrchestratorClaimOutcome`); a claim nobody voted on is `disputed`. */
export function tallyCommitteeClaim(claim: OrchestratorCommitteeClaim): { agree: number; disagree: number; unsure: number; outcome: OrchestratorClaimOutcome } {
  const ballots = Object.values(claim.votes);
  const agree = ballots.filter((vote) => vote === 'agree').length;
  const disagree = ballots.filter((vote) => vote === 'disagree').length;
  const unsure = ballots.length - agree - disagree;
  const outcome: OrchestratorClaimOutcome = ballots.length > 0 && agree === ballots.length
    ? 'consensus'
    : agree * 2 > ballots.length ? 'majority' : disagree * 2 > ballots.length ? 'rejected' : 'disputed';
  return { agree, disagree, unsure, outcome };
}

/**
 * The orchestrator's closing request: the claims with their tallies, to be
 * turned into a plain-text answer for the user that says what everyone
 * agreed on, what most agreed on, and what stays disputed.
 */
export function buildCommitteeSummaryPrompt(task: string, claims: OrchestratorCommitteeClaim[], members: number): string {
  return [
    `${members} AI backends answered the question below independently, their answers were merged into claims, and every backend voted on each claim.`,
    '',
    `Question or task:\n${task}`,
    '',
    'Claims with votes (agree / disagree / unsure) and outcome:',
    ...claims.map((claim) => {
      const tally = tallyCommitteeClaim(claim);
      return `${claim.id}. ${claim.text} — ${tally.agree}/${tally.disagree}/${tally.unsure}, ${tally.outcome}`;
    }),
    '',
    'Write the final answer for the user in plain text (no JSON): the answer to the question built on what was agreed, then what the backends disagree about and why it matters. Do not present a disputed or rejected claim as fact.',
  ].join('\n');
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
 * The backends that may do a role's work, best first — the role's chain.
 * First come the backends the user gave that very role; after them the
 * substitutes: `hands` work may fall to an `orchestrator` backend, `routine`
 * work to `hands` and then `orchestrator`, and coordinating
 * (`orchestrator`) to a `hands` backend. Within one role the user's own
 * backend order (`preferredOrder`, their handoff fallback order) decides,
 * then `PROVIDER_RESOLUTION_ORDER`.
 *
 * The chain only names who may stand in; the caller takes the first one
 * that is not at its usage limit, so a role goes back to its first choice
 * by itself once that backend's limit resets.
 */
export function listRoleCandidates(
  role: ProviderRole,
  providerRoles: Partial<Record<LLMProvider, ProviderRole>>,
  preferredOrder: LLMProvider[] = [],
): LLMProvider[] {
  const order = [...new Set([...preferredOrder, ...PROVIDER_RESOLUTION_ORDER])];
  const chainRoles: ProviderRole[] = role === 'routine'
    ? ['routine', 'hands', 'orchestrator']
    : role === 'hands' ? ['hands', 'orchestrator'] : ['orchestrator', 'hands'];
  return chainRoles.flatMap((chainRole) => order.filter((provider) => providerRoles[provider] === chainRole));
}

/**
 * Picks the backend a subtask goes to: the first of the role's chain
 * (`listRoleCandidates`) that can take work now. A user with one
 * subscription and one API key (Claude as orchestrator, a free model for
 * routine) still gets every subtask done this way. Returns `null` only when
 * no backend has any role of the chain.
 */
export function resolveSubtaskProvider(
  role: ProviderRole,
  providerRoles: Partial<Record<LLMProvider, ProviderRole>>,
  /** Lets the caller pass over a backend that cannot take work right now (at its usage limit). */
  isAvailable: (provider: LLMProvider) => boolean = () => true,
): LLMProvider | null {
  const candidates = listRoleCandidates(role, providerRoles);
  // A candidate at its limit is still better than none.
  return candidates.find(isAvailable) ?? candidates[0] ?? null;
}
