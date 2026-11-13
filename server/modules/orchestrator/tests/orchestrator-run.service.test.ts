import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  cancelOrchestratorRun,
  findLatestOrchestratorRun,
  forgetOrchestratorRunsInMemory,
  getOrchestratorRun,
  isOrchestratorManagedSession,
  resetOrchestratorRuns,
  resumeOrchestratorRun,
  startOrchestratorRun,
} from '@/modules/orchestrator/services/orchestrator-dispatch.service.js';
import type { OrchestratorRunDependencies } from '@/modules/orchestrator/services/orchestrator-dispatch.service.js';

type Turn = { sessionId: string; provider: string; content: string; options?: Record<string, unknown> };

const ROLES = { claude: 'orchestrator', codex: 'hands', openrouter: 'routine' } as const;
const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/**
 * Stands in for the backends: every turn is recorded, the orchestrator
 * session answers with the next scripted reply, and a subtask session
 * answers with whatever `subtaskReply` makes of its prompt.
 */
async function withOrchestrator(
  orchestratorReplies: string[],
  run: (context: {
    turns: Turn[];
    dependencies: OrchestratorRunDependencies;
    subtaskTurns: () => Turn[];
    /** Backends at their usage limit, with when it resets. */
    limits: Map<string, number>;
    aborted: string[];
  }) => Promise<void>,
  subtaskReply: (turn: Turn, limits: Map<string, number>) => string | null | Promise<string | null> = (turn) => `did: ${turn.content.split('\n')[0]}`,
  /** Stands in for the origin session's backend; returning undefined takes the next scripted reply. */
  leadReply: (turn: Turn, limits: Map<string, number>) => string | null | undefined = () => undefined,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-run-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  resetOrchestratorRuns();
  sessionsDb.createAppSession('lead', 'claude', tempDirectory);

  const turns: Turn[] = [];
  const replies = new Map<string, string | null>();
  const script = [...orchestratorReplies];
  const limits = new Map<string, number>();
  const aborted: string[] = [];
  const dependencies: OrchestratorRunDependencies = {
    runTurn: async (input) => {
      const provider = sessionsDb.getSessionById(input.sessionId)?.provider ?? '?';
      const turn = { sessionId: input.sessionId, provider, content: input.content, options: input.options };
      turns.push(turn);
      if (input.sessionId === 'lead') {
        const own = leadReply(turn, limits);
        replies.set('lead', own === undefined ? script.shift() ?? null : own);
      } else if (/^Coordinating:/.test(sessionsDb.getSessionById(input.sessionId)?.custom_name ?? '')) {
        // A backend that took the coordination over answers from the same script.
        replies.set(input.sessionId, script.shift() ?? null);
      } else {
        replies.set(input.sessionId, await subtaskReply(turn, limits));
      }
      return { started: true, error: null };
    },
    readLastReply: async (sessionId) => replies.get(sessionId) ?? null,
    abortTurn: async (sessionId) => {
      aborted.push(sessionId);
    },
    limitedUntil: (provider) => limits.get(provider) ?? null,
  };

  try {
    await run({ turns, dependencies, limits, aborted, subtaskTurns: () => turns.filter((turn) => turn.sessionId !== 'lead') });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const NO_BACKENDS: OrchestratorRunDependencies = {
  runTurn: async () => ({ started: false, error: 'unused' }),
  readLastReply: async () => null,
  abortTurn: async () => undefined,
  limitedUntil: () => null,
};

const start = (dependencies: OrchestratorRunDependencies, maxRounds?: number) => startOrchestratorRun(
  { orchestratorSessionId: 'lead', userId: 1, task: 'Ship the feature', providerRoles: ROLES, maxRounds },
  dependencies,
);

test('a run plans, gives each subtask to its role\'s backend with its access, reports back and closes', async () => {
  const plan = { subtasks: [
    { title: 'Study', description: 'Read the module', role: 'routine', access: 'read' },
    { title: 'Build', description: 'Write the code', role: 'hands', access: 'write' },
  ] };
  await withOrchestrator([json(plan), json({ status: 'done', summary: 'Feature shipped.' })], async ({ turns, dependencies, subtaskTurns }) => {
    const { run, finished } = start(dependencies);
    assert.equal(run.phase, 'planning');
    await finished;

    const final = getOrchestratorRun(run.id)!;
    assert.equal(final.phase, 'done');
    assert.equal(final.summary, 'Feature shipped.');
    assert.deepEqual(final.subtasks.map((subtask) => [subtask.title, subtask.provider, subtask.access, subtask.status, subtask.round]), [
      ['Study', 'openrouter', 'read', 'done', 1],
      ['Build', 'codex', 'write', 'done', 1],
    ]);

    const [study, build] = subtaskTurns();
    // The routine backend here is the text-only API provider.
    assert.match(study.content, /no access to files or commands/);
    // The write subtask runs after the read one and is told what it reported.
    assert.match(build.content, /did: Read the module/);
    assert.deepEqual(build.options, {});

    // Plan, then the review carrying both reports.
    const leadTurns = turns.filter((turn) => turn.sessionId === 'lead');
    assert.equal(leadTurns.length, 2);
    assert.match(leadTurns[1].content, /did: Write the code/);
    assert.equal(findLatestOrchestratorRun('lead')?.id, run.id);
  });
});

test('the orchestrator can ask for a follow-up round, and the last round can only close', async () => {
  const first = { subtasks: [{ title: 'Build', description: 'Write the code', role: 'hands', access: 'write' }] };
  const followUp = { status: 'continue', subtasks: [{ title: 'Fix', description: 'Fix the failing test', role: 'hands', access: 'write' }] };
  await withOrchestrator([json(first), json(followUp), json({ status: 'done', summary: 'Fixed.' })], async ({ turns, dependencies }) => {
    const { run, finished } = start(dependencies, 2);
    await finished;

    const final = getOrchestratorRun(run.id)!;
    assert.equal(final.phase, 'done');
    assert.deepEqual(final.subtasks.map((subtask) => [subtask.title, subtask.round]), [['Build', 1], ['Fix', 2]]);
    const reviews = turns.filter((turn) => turn.sessionId === 'lead').slice(1);
    assert.match(reviews[0].content, /"status": "continue"/);
    assert.doesNotMatch(reviews[1].content, /"status": "continue"/);
  });
});

test('a plan that does not parse is asked for once more before the run fails', async () => {
  const plan = { subtasks: [{ title: 'Build', description: 'Write the code', role: 'hands' }] };
  await withOrchestrator(['Sure! Here is my plan: first we build.', json(plan), json({ status: 'done', summary: 'ok' })], async ({ turns, dependencies }) => {
    const { run, finished } = start(dependencies);
    await finished;
    assert.equal(getOrchestratorRun(run.id)!.phase, 'done');
    assert.match(turns[1].content, /could not be used/);
  });

  await withOrchestrator(['no json', 'still no json'], async ({ dependencies }) => {
    const { run, finished } = start(dependencies);
    await finished;
    const final = getOrchestratorRun(run.id)!;
    assert.equal(final.phase, 'failed');
    assert.match(final.error ?? '', /not valid JSON/);
  });
});

test('a failed subtask is reported to the orchestrator instead of stopping the run, and a role nobody holds falls back', async () => {
  const plan = { subtasks: [
    { title: 'Build', description: 'Write the code', role: 'hands', access: 'write' },
    { title: 'Tidy', description: 'Tidy up', role: 'routine', access: 'write' },
  ] };
  await withOrchestrator([json(plan), json({ status: 'done', summary: 'Partly done.' })], async ({ turns, dependencies }) => {
    const { run, finished } = startOrchestratorRun(
      { orchestratorSessionId: 'lead', userId: 1, task: 'Ship', providerRoles: { claude: 'orchestrator', codex: 'hands' } },
      dependencies,
    );
    await finished;

    const final = getOrchestratorRun(run.id)!;
    assert.deepEqual(final.subtasks.map((subtask) => [subtask.status, subtask.provider]), [['failed', 'codex'], ['failed', 'codex']]);
    assert.equal(final.phase, 'done');
    const review = turns.filter((turn) => turn.sessionId === 'lead')[1].content;
    assert.match(review, /Build — failed/);
    assert.match(review, /Tidy — failed/);
  }, () => null);
});

test('an unreadable verdict closes the run with the orchestrator\'s own words instead of failing finished work', async () => {
  const plan = { subtasks: [{ title: 'Build', description: 'Write the code', role: 'hands' }] };
  await withOrchestrator([json(plan), 'Looks fine to me.', 'Really, it is fine.'], async ({ dependencies }) => {
    const { run, finished } = start(dependencies);
    await finished;
    const final = getOrchestratorRun(run.id)!;
    assert.equal(final.phase, 'done');
    assert.equal(final.summary, 'Really, it is fine.');
  });
});

test('cancelling skips the subtasks that have not started and asks for no review', async () => {
  const plan = { subtasks: [
    { title: 'One', description: 'First', role: 'hands', access: 'write' },
    { title: 'Two', description: 'Second', role: 'hands', access: 'write' },
  ] };
  let runId = '';
  await withOrchestrator([json(plan)], async ({ turns, dependencies }) => {
    const { run, finished } = start(dependencies);
    runId = run.id;
    await finished;

    const final = getOrchestratorRun(run.id)!;
    assert.equal(final.phase, 'cancelled');
    assert.deepEqual(final.subtasks.map((subtask) => subtask.status), ['done', 'skipped']);
    assert.equal(turns.filter((turn) => turn.sessionId === 'lead').length, 1);
  }, () => {
    void cancelOrchestratorRun(runId, NO_BACKENDS);
    return 'done';
  });
});

test('a session coordinates one task at a time, and only with the orchestrator role', async () => {
  await withOrchestrator([], async ({ dependencies }) => {
    const hanging: OrchestratorRunDependencies = { ...dependencies, runTurn: () => new Promise(() => undefined) };
    start(hanging);
    assert.throws(() => start(dependencies), /already coordinating/);
    assert.throws(
      () => startOrchestratorRun({ orchestratorSessionId: 'lead', userId: 1, task: 'x', providerRoles: { claude: 'hands' } }, dependencies),
      /orchestrator/,
    );
  });
});

const ONE_BUILD = { subtasks: [{ title: 'Build', description: 'Write the code', role: 'hands', access: 'write' }] };
const CLOSED = json({ status: 'done', summary: 'Shipped.' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a subtask whose backend runs out of usage is passed to the next backend of the role chain and followed there', async () => {
  await withOrchestrator([json(ONE_BUILD), CLOSED], async ({ dependencies, subtaskTurns }) => {
    const { run, finished } = start(dependencies);
    await finished;

    const final = getOrchestratorRun(run.id)!;
    assert.equal(final.phase, 'done');
    assert.deepEqual(subtaskTurns().map((turn) => turn.provider), ['codex', 'claude']);
    assert.match(subtaskTurns()[1].content, /already started on this and was cut off/);
    assert.equal(final.subtasks[0].status, 'done');
    assert.equal(final.subtasks[0].provider, 'claude');
    assert.deepEqual(final.subtasks[0].movedFrom, ['codex']);
    assert.equal(final.subtasks[0].sessionId, subtaskTurns()[1].sessionId);
  }, (turn, limits) => {
    if (turn.provider === 'codex') {
      limits.set('codex', Date.now() + 3_600_000);
      return null;
    }
    return 'built';
  });
});

test('with every backend of a chain at its limit the run pauses, and goes on when asked', async () => {
  await withOrchestrator([json(ONE_BUILD), CLOSED], async ({ dependencies, limits, subtaskTurns }) => {
    const { run, finished } = start(dependencies);
    await tick();

    const paused = getOrchestratorRun(run.id)!;
    assert.equal(paused.phase, 'paused');
    assert.equal(paused.pauseReason, 'limit');
    assert.equal(paused.resumeAt, new Date(limits.get('codex')!).toISOString());
    assert.equal(paused.waitingFor, 'codex');
    assert.equal(subtaskTurns().length, 0);
    assert.equal(isOrchestratorManagedSession('lead'), true);

    limits.clear();
    resumeOrchestratorRun(run.id, dependencies);
    await finished;
    const final = getOrchestratorRun(run.id)!;
    assert.equal(final.phase, 'done');
    assert.equal(final.resumeAt, undefined);
    assert.deepEqual(subtaskTurns().map((turn) => turn.provider), ['codex']);
    assert.equal(isOrchestratorManagedSession('lead'), false);
  }, undefined, (turn, limits) => {
    // The plan is given, and from then on both agent backends are out.
    if (/Break the task/.test(turn.content)) {
      limits.set('claude', Date.now() + 7_200_000);
      limits.set('codex', Date.now() + 3_600_000);
    }
    return undefined;
  });
});

test('when the orchestrator runs out of usage the next backend of its chain takes the coordination over', async () => {
  await withOrchestrator([json(ONE_BUILD), CLOSED], async ({ turns, dependencies }) => {
    const { run, finished } = start(dependencies);
    await finished;

    const final = getOrchestratorRun(run.id)!;
    assert.equal(final.phase, 'done');
    assert.equal(final.summary, 'Shipped.');
    assert.equal(final.coordinatorProvider, 'codex');
    assert.equal(final.orchestratorSessionId, 'lead');
    const takeover = turns.find((turn) => turn.sessionId === final.coordinatorSessionId)!;
    assert.match(takeover.content, /^You are taking over the coordination/);
    assert.match(takeover.content, /Ship the feature/);
    assert.match(takeover.content, /built/);
  }, () => 'built', (turn, limits) => {
    if (/have finished/.test(turn.content)) {
      limits.set('claude', Date.now() + 3_600_000);
      return null;
    }
    return undefined;
  });
});

test('stopping a run stops the turn it has going', async () => {
  let release: (reply: string | null) => void = () => undefined;
  await withOrchestrator([json(ONE_BUILD)], async ({ turns, dependencies, aborted, subtaskTurns }) => {
    const { run, finished } = start(dependencies);
    await tick();
    assert.equal(subtaskTurns().length, 1);

    const stopping = cancelOrchestratorRun(run.id, { ...dependencies, abortTurn: async (sessionId) => {
      await dependencies.abortTurn(sessionId);
      release(null);
    } });
    await stopping;
    await finished;

    const final = getOrchestratorRun(run.id)!;
    assert.deepEqual(aborted, [subtaskTurns()[0].sessionId]);
    assert.equal(final.phase, 'cancelled');
    assert.equal(final.subtasks[0].status, 'skipped');
    assert.equal(turns.filter((turn) => turn.sessionId === 'lead').length, 1);
  }, () => new Promise((resolve) => {
    release = resolve;
  }));
});

test('a run cut off by a restart comes back paused and, continued, redoes only what has no result', async () => {
  const plan = { subtasks: [
    { title: 'First', description: 'Do the first part', role: 'hands', access: 'write' },
    { title: 'Second', description: 'Do the second part', role: 'hands', access: 'write' },
  ] };
  let release: (reply: string | null) => void = () => undefined;
  let hang = true;
  await withOrchestrator([json(plan), CLOSED], async ({ dependencies, subtaskTurns }) => {
    const { run } = start(dependencies);
    await tick();
    assert.equal(subtaskTurns().length, 2);

    // The process "dies" with the second subtask still going.
    forgetOrchestratorRunsInMemory();
    const restored = getOrchestratorRun(run.id)!;
    assert.equal(restored.phase, 'paused');
    assert.equal(restored.pauseReason, 'restart');
    assert.deepEqual(restored.subtasks.map((subtask) => subtask.status), ['done', 'pending']);

    hang = false;
    await resumeOrchestratorRun(run.id, dependencies)!.finished;
    const final = getOrchestratorRun(run.id)!;
    assert.equal(final.phase, 'done');
    assert.deepEqual(subtaskTurns().map((turn) => turn.content.split('\n')[0]),
      ['Do the first part', 'Do the second part', 'Do the second part']);
    assert.match(subtaskTurns()[2].content, /already started on this and was cut off/);
    release(null);
  }, (turn) => (hang && /second part/.test(turn.content)
    ? new Promise((resolve) => {
      release = resolve;
    })
    : 'ok'));
});

test('file work is not handed to a text model that only stands in for the role', async () => {
  await withOrchestrator([json(ONE_BUILD), CLOSED], async ({ dependencies, subtaskTurns }) => {
    const { run, finished } = startOrchestratorRun(
      { orchestratorSessionId: 'lead', userId: 1, task: 'Ship the feature', providerRoles: { claude: 'orchestrator', codex: 'hands', openrouter: 'hands' }, preferredOrder: ['codex', 'openrouter'] },
      dependencies,
    );
    await finished;
    // Codex ran out; the text model is passed over and the orchestrator's backend builds.
    assert.deepEqual(subtaskTurns().map((turn) => turn.provider), ['codex', 'claude']);
    assert.equal(getOrchestratorRun(run.id)!.phase, 'done');
  }, (turn, limits) => {
    if (turn.provider === 'codex') {
      limits.set('codex', Date.now() + 3_600_000);
      return null;
    }
    return 'built';
  });
});
