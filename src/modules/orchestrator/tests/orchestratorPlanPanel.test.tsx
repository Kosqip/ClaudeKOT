import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { OrchestratorPlanPanel } from '@/modules/orchestrator';

const { orchestratorApi } = vi.hoisted(() => ({
  orchestratorApi: {
    latestRun: vi.fn(),
    plan: vi.fn(),
    run: vi.fn(),
    cancel: vi.fn(),
    resume: vi.fn(),
  },
}));

vi.mock('@/shared/api', () => ({ api: { orchestrator: orchestratorApi } }));

const answer = (run: unknown) => ({ ok: true, json: async () => ({ data: { run } }) }) as unknown as Response;

/** A pair run stuck on one finding: two rounds, the second paused for the user's decision. */
const PAUSED_PAIR_RUN = {
  id: 'run-1',
  orchestratorSessionId: 'lead',
  task: 'Ship the feature',
  mode: 'pair',
  phase: 'paused',
  pauseReason: 'decision',
  round: 2,
  maxRounds: 3,
  subtasks: [
    { title: 'Writer — round 1', role: 'hands', access: 'write', round: 1, status: 'done', provider: 'codex', pairPart: 'writer', sessionId: 's1' },
    { title: 'Reviewer — round 1', role: 'orchestrator', access: 'read', round: 1, status: 'done', provider: 'claude', pairPart: 'reviewer', sessionId: 's2' },
    { title: 'Writer — round 2', role: 'hands', access: 'write', round: 2, status: 'done', provider: 'codex', pairPart: 'writer', sessionId: 's3' },
    { title: 'Reviewer — round 2', role: 'orchestrator', access: 'read', round: 2, status: 'done', provider: 'claude', pairPart: 'reviewer', sessionId: 's4' },
  ],
  pairRounds: [
    { round: 1, writerDone: true, verdict: 'changes', findings: [{ severity: 'P1', text: 'Errors are swallowed' }] },
    { round: 2, writerDone: true, verdict: 'changes', findings: [{ severity: 'P1', text: 'Errors are swallowed' }, { severity: 'P2', text: 'Rename it' }] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

test('starting in pair mode sends the mode and its default of three rounds', async () => {
  orchestratorApi.latestRun.mockResolvedValue(answer(null));
  orchestratorApi.plan.mockResolvedValue(answer({ ...PAUSED_PAIR_RUN, phase: 'running', pauseReason: undefined, subtasks: [], pairRounds: [] }));
  render(<OrchestratorPlanPanel sessionId="lead" onOpenSubtaskSession={() => undefined} />);

  fireEvent.change(screen.getByDisplayValue('Plan'), { target: { value: 'pair' } });
  fireEvent.change(screen.getByPlaceholderText('The task to coordinate'), { target: { value: 'Ship the feature' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));

  await waitFor(() => assert.equal(orchestratorApi.plan.mock.calls.length, 1));
  assert.deepEqual(orchestratorApi.plan.mock.calls[0][0], { sessionId: 'lead', task: 'Ship the feature', maxRounds: 3, mode: 'pair' });
});

test('a pair run shows each round\'s writer, reviewer, verdict and findings, and asks for a decision when stuck', async () => {
  orchestratorApi.latestRun.mockResolvedValue(answer(PAUSED_PAIR_RUN));
  render(<OrchestratorPlanPanel sessionId="lead" onOpenSubtaskSession={() => undefined} />);

  await screen.findByText(/Your decision is needed/);
  assert.equal(screen.getAllByText('Errors are swallowed').length, 2);
  assert.ok(screen.getByText('Rename it'));
  assert.equal(screen.getAllByText('writer: done · changes requested').length, 2);
  assert.equal(screen.getAllByText(/reviewer, read only · Claude/).length, 2);
  assert.ok(screen.getByRole('button', { name: 'Continue now' }));
});

test('a committee run shows its stages, members\' turns and every claim with its votes and outcome', async () => {
  orchestratorApi.latestRun.mockResolvedValue(answer({
    id: 'run-2',
    orchestratorSessionId: 'lead',
    task: 'Which cache?',
    mode: 'committee',
    phase: 'done',
    round: 2,
    maxRounds: 2,
    summary: 'Use Redis.',
    subtasks: [
      { title: 'Answer — claude', role: 'orchestrator', access: 'read', round: 1, status: 'done', provider: 'claude', committeePart: 'answer' },
      { title: 'Answer — codex', role: 'hands', access: 'read', round: 1, status: 'done', provider: 'codex', committeePart: 'answer' },
      { title: 'Vote — claude', role: 'orchestrator', access: 'read', round: 2, status: 'done', provider: 'claude', committeePart: 'vote' },
      { title: 'Vote — codex', role: 'hands', access: 'read', round: 2, status: 'done', provider: 'codex', committeePart: 'vote' },
    ],
    committee: {
      members: ['claude', 'codex'],
      stage: 'summary',
      claims: [
        { id: 1, text: 'Redis fits', votes: { claude: 'agree', codex: 'agree' }, outcome: 'consensus' },
        { id: 2, text: 'Memcached is enough', votes: { claude: 'disagree', codex: 'agree' }, outcome: 'disputed' },
      ],
    },
  }));
  render(<OrchestratorPlanPanel sessionId="lead" onOpenSubtaskSession={() => undefined} />);

  await screen.findByText('Redis fits');
  assert.ok(screen.getByText('Independent answers'));
  assert.ok(screen.getByText('Vote'));
  assert.ok(screen.getByText('✓2 ✗0 ?0'));
  assert.ok(screen.getByText('all agree'));
  assert.ok(screen.getByText('disputed'));
  assert.equal(screen.getAllByText(/— answer, read only/).length, 2);
  assert.ok(screen.getByText('Use Redis.'));
});
