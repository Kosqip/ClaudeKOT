import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPlanRequestPrompt,
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
    '  {"title": "Write tests", "description": "Add unit tests for the login flow", "role": "hands"},',
    '  {"title": "Update changelog", "description": "Append a changelog entry", "role": "routine"}',
    ']}',
    '```',
  ].join('\n');

  const subtasks = parseOrchestratorPlan(response);
  assert.deepEqual(subtasks, [
    { title: 'Write tests', description: 'Add unit tests for the login flow', role: 'hands' },
    { title: 'Update changelog', description: 'Append a changelog entry', role: 'routine' },
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

test('resolveSubtaskProvider returns null when no provider holds the role', () => {
  const provider = resolveSubtaskProvider('routine', { claude: 'orchestrator', codex: 'hands' });
  assert.equal(provider, null);
});
