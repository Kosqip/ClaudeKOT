import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPlanRequestPrompt,
  buildReviewPrompt,
  buildSubtaskPrompt,
  buildSubtaskTurnOptions,
  groupSubtasksIntoSteps,
  parseOrchestratorReview,
  parseOrchestratorPlan,
  resolveSubtaskProvider,
} from '@/modules/orchestrator/services/orchestrator-plan.service.js';

test('buildPlanRequestPrompt embeds the task and demands a fenced JSON block', () => {
  const prompt = buildPlanRequestPrompt('Refactor the auth module');
  assert.ok(prompt.includes('Refactor the auth module'));
  assert.ok(prompt.includes('```json'));
  assert.ok(prompt.includes('"subtasks"'));
});

test('parseOrchestratorPlan reads a fenced JSON block with valid subtasks', () => {
  const response = [
    'Here is the plan:',
    '```json',
    '{"subtasks": [',
    '  {"title": "Write tests", "description": "Add unit tests for the login flow", "role": "hands", "access": "read"},',
    '  {"title": "Update changelog", "description": "Append a changelog entry", "role": "routine"}',
    ']}',
    '```',
  ].join('\n');

  const subtasks = parseOrchestratorPlan(response);
  assert.deepEqual(subtasks, [
    { title: 'Write tests', description: 'Add unit tests for the login flow', role: 'hands', access: 'read' },
    // No access stated: full access, so a subtask is never starved of tools it needs.
    { title: 'Update changelog', description: 'Append a changelog entry', role: 'routine', access: 'write' },
  ]);
});

test('parseOrchestratorPlan falls back to parsing the whole response when there is no fence', () => {
  const response = '{"subtasks": [{"title": "Fix bug", "description": "Fix the null pointer", "role": "hands"}]}';
  const subtasks = parseOrchestratorPlan(response);
  assert.equal(subtasks.length, 1);
  assert.equal(subtasks[0].title, 'Fix bug');
});

test('parseOrchestratorPlan rejects a response that is not valid JSON, with the raw text in the error', () => {
  const response = 'Sure, I will get right on that!';
  assert.throws(
    () => parseOrchestratorPlan(response),
    (error: unknown) => error instanceof Error && error.message.includes(response),
  );
});

test('parseOrchestratorPlan rejects JSON with no subtasks array', () => {
  assert.throws(
    () => parseOrchestratorPlan('```json\n{"plan": "do stuff"}\n```'),
    /no "subtasks" array/,
  );
});

test('parseOrchestratorPlan rejects a subtask with an invalid role', () => {
  const response = '```json\n{"subtasks": [{"title": "X", "description": "Y", "role": "manager"}]}\n```';
  assert.throws(
    () => parseOrchestratorPlan(response),
    /Subtask 0 is missing a valid/,
  );
});

test('parseOrchestratorPlan rejects a subtask missing a description', () => {
  const response = '```json\n{"subtasks": [{"title": "X", "role": "hands"}]}\n```';
  assert.throws(
    () => parseOrchestratorPlan(response),
    /Subtask 0 is missing a valid/,
  );
});

test('resolveSubtaskProvider returns the first provider (in LLMProvider order) holding the role', () => {
  const provider = resolveSubtaskProvider('hands', { openrouter: 'hands', codex: 'hands', claude: 'orchestrator' });
  assert.equal(provider, 'codex');
});

test('resolveSubtaskProvider returns null only when no backend holds any usable role', () => {
  assert.equal(resolveSubtaskProvider('hands', { openrouter: 'routine' }), null);
  assert.equal(resolveSubtaskProvider('routine', {}), null);
});

test('parseOrchestratorPlan rejects an access level it does not know', () => {
  assert.throws(
    () => parseOrchestratorPlan('{"subtasks": [{"title": "t", "description": "d", "role": "hands", "access": "admin"}]}'),
    /"access"/,
  );
});

test('resolveSubtaskProvider passes over a backend at its limit when another holds the role, and keeps it when none does', () => {
  const roles = { claude: 'hands', codex: 'hands' } as const;
  assert.equal(resolveSubtaskProvider('hands', roles, (provider) => provider !== 'claude'), 'codex');
  assert.equal(resolveSubtaskProvider('hands', { claude: 'hands' }, () => false), 'claude');
});

test('groupSubtasksIntoSteps runs neighbouring read subtasks together and every write subtask alone', () => {
  const steps = groupSubtasksIntoSteps([
    { id: 1, access: 'read' as const },
    { id: 2, access: 'read' as const },
    { id: 3, access: 'write' as const },
    { id: 4, access: 'write' as const },
    { id: 5, access: 'read' as const },
  ]);
  assert.deepEqual(steps.map((step) => step.map((subtask) => subtask.id)), [[1, 2], [3], [4], [5]]);
});

test('buildSubtaskTurnOptions withholds editing for a read subtask with what each backend offers', () => {
  assert.deepEqual(buildSubtaskTurnOptions('claude', 'write'), {});
  const claude = buildSubtaskTurnOptions('claude', 'read') as { toolsSettings: { disallowedTools: string[] } };
  assert.ok(claude.toolsSettings.disallowedTools.includes('Edit'));
  assert.ok(claude.toolsSettings.disallowedTools.includes('Write'));
  assert.deepEqual(buildSubtaskTurnOptions('codex', 'read'), { permissionMode: 'readOnly' });
  assert.deepEqual(buildSubtaskTurnOptions('opencode', 'read'), { permissionMode: 'plan' });
  assert.deepEqual(buildSubtaskTurnOptions('cursor', 'read'), {});
});

test('buildSubtaskPrompt carries earlier reports and tells a read subtask not to change anything', () => {
  const prompt = buildSubtaskPrompt(
    { title: 'Review', description: 'Review the new parser', role: 'hands', access: 'read' },
    [{ title: 'Write parser', status: 'done', result: 'Added src/parser.ts' }],
  );
  assert.ok(prompt.startsWith('Review the new parser'));
  assert.match(prompt, /read-only subtask/);
  assert.match(prompt, /Added src\/parser\.ts/);

  const writePrompt = buildSubtaskPrompt({ title: 'W', description: 'Do it', role: 'hands', access: 'write' }, []);
  assert.doesNotMatch(writePrompt, /read-only subtask/);
});

test('buildReviewPrompt offers a follow-up round only while one is allowed', () => {
  const reports = [{ title: 'A', status: 'failed' as const, result: 'compile error' }];
  assert.match(buildReviewPrompt('Task', reports, true), /"status": "continue"/);
  const last = buildReviewPrompt('Task', reports, false);
  assert.doesNotMatch(last, /"status": "continue"/);
  assert.match(last, /compile error/);
});

test('parseOrchestratorReview reads both verdicts and rejects anything else', () => {
  assert.deepEqual(parseOrchestratorReview('```json\n{"status": "done", "summary": "All good"}\n```'), { status: 'done', summary: 'All good' });
  const more = parseOrchestratorReview('{"status": "continue", "subtasks": [{"title": "Fix", "description": "Fix it", "role": "hands", "access": "write"}]}');
  assert.equal(more.status, 'continue');
  assert.throws(() => parseOrchestratorReview('{"status": "maybe"}'), /status/);
  assert.throws(() => parseOrchestratorReview('{"status": "continue", "subtasks": []}'), /subtasks/);
});

test('resolveSubtaskProvider falls back to hands, then the orchestrator, when a role has no backend of its own', () => {
  // One subscription and one API key: nobody is "hands".
  const roles = { claude: 'orchestrator', openrouter: 'routine' } as const;
  assert.equal(resolveSubtaskProvider('hands', roles), 'claude');
  assert.equal(resolveSubtaskProvider('routine', roles), 'openrouter');
  assert.equal(resolveSubtaskProvider('routine', { claude: 'orchestrator', codex: 'hands' }), 'codex');
  assert.equal(resolveSubtaskProvider('routine', { claude: 'orchestrator' }), 'claude');
});

test('a text-only backend is planned for and addressed as one', () => {
  // The API provider is a chat completion: it cannot open the project folder.
  assert.doesNotMatch(buildPlanRequestPrompt('Task'), /plain text model/);
  assert.match(buildPlanRequestPrompt('Task', ['routine']), /"routine" backend here is a plain text model/);

  const subtask = { title: 'Draft', description: 'Draft the note', role: 'routine' as const, access: 'read' as const };
  const prompt = buildSubtaskPrompt(subtask, [], true);
  assert.match(prompt, /no access to files or commands/);
  // Telling a model with no tools not to edit files only confuses it.
  assert.doesNotMatch(prompt, /read-only subtask/);
});

test('the review is told that a blocked backend is a failed subtask', () => {
  assert.match(buildReviewPrompt('Task', [], false), /blocked, lacked access or could not do the work is a failed subtask/);
});

test('a plan whose description contains its own code fence is still read whole', () => {
  // Seen live: the orchestrator put a file's content, fences and all, into a description.
  const description = 'Save this file:\n```md\n# Guide\n```\nand nothing else';
  const reply = `\`\`\`json\n${JSON.stringify({ status: 'continue', subtasks: [{ title: 'Save', description, role: 'hands', access: 'write' }] })}\n\`\`\``;
  const review = parseOrchestratorReview(reply);
  assert.equal(review.status, 'continue');
  assert.equal(review.status === 'continue' && review.subtasks[0].description, description);

  // Prose around an unfenced object is tolerated too.
  assert.deepEqual(parseOrchestratorReview('Here you go: {"status": "done", "summary": "ok"} — bye'), { status: 'done', summary: 'ok' });
});
