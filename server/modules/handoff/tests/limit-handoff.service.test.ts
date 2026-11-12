import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  DEFAULT_FALLBACK_ORDER,
  handoffSessionOnLimit,
  isProviderLimited,
  markProviderLimited,
  pickFallbackProvider,
  releaseHandoffClaim,
  renderHistoryAsText,
  resetHandoffState,
  tryClaimHandoff,
  writeHandoffContextFile,
} from '@/modules/handoff/services/limit-handoff.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

// Claims and limited-provider records live in module memory; start each test clean.
test.beforeEach(() => resetHandoffState());

/**
 * A fake gateway: `hasRuntime` reports true for every provider named in
 * `installed`, mirroring what `providerRuntimeService.hasRuntime` would say
 * for a machine with only those CLIs/keys configured.
 */
function fakeRuntime(installed: string[]): ProviderRuntimeGateway {
  return {
    hasRuntime: (provider: string) => installed.includes(provider),
  } as ProviderRuntimeGateway;
}

test('pickFallbackProvider returns the first installed provider in order, excluding the one that hit its limit', () => {
  const runtime = fakeRuntime(['claude', 'codex', 'openrouter']);
  const picked = pickFallbackProvider(DEFAULT_FALLBACK_ORDER, 'claude', runtime);
  assert.equal(picked, 'codex');
});

test('pickFallbackProvider skips the excluded provider even if it is first in the order', () => {
  const runtime = fakeRuntime(['codex', 'claude']);
  const picked = pickFallbackProvider(DEFAULT_FALLBACK_ORDER, 'codex', runtime);
  assert.equal(picked, 'claude');
});

test('pickFallbackProvider returns null when nothing in the order is installed', () => {
  const runtime = fakeRuntime(['cursor']);
  const picked = pickFallbackProvider(['codex', 'claude'], 'claude', runtime);
  assert.equal(picked, null);
});

test('pickFallbackProvider respects a custom fallback order over the default', () => {
  const runtime = fakeRuntime(['claude', 'openrouter']);
  const picked = pickFallbackProvider(['openrouter', 'claude'], 'codex', runtime);
  assert.equal(picked, 'openrouter');
});

test('renderHistoryAsText labels user and assistant turns and skips empty content', () => {
  const text = renderHistoryAsText([
    { role: 'user', content: 'Fix the bug' },
    { role: 'assistant', content: 'Done.' },
    { role: 'user', content: undefined },
  ]);
  assert.equal(text, 'User: Fix the bug\n\nAssistant: Done.');
});

test('renderHistoryAsText returns an empty string for no messages', () => {
  assert.equal(renderHistoryAsText([]), '');
});

test('writeHandoffContextFile writes the rendered history and returns an absolute, readable path', async () => {
  const toSessionId = randomUUID();
  const filePath = await writeHandoffContextFile(toSessionId, 'User: Fix the bug\n\nAssistant: Done.');

  assert.ok(path.isAbsolute(filePath));
  assert.equal(path.dirname(filePath), path.join(os.homedir(), '.cloudcli', 'handoff-context'));
  assert.equal(await readFile(filePath, 'utf8'), 'User: Fix the bug\n\nAssistant: Done.');
});

test('writeHandoffContextFile writes a placeholder instead of an empty file when there is no history', async () => {
  const filePath = await writeHandoffContextFile(randomUUID(), '');
  assert.equal(await readFile(filePath, 'utf8'), '(no prior messages)');
});

test('a session gets one automatic handoff per mode, and a rejection may follow a proactive switch', () => {
  assert.equal(tryClaimHandoff('s1', 'standby'), true);
  assert.equal(tryClaimHandoff('s1', 'standby'), false);
  // The user kept working in the original session and the provider then refused a request.
  assert.equal(tryClaimHandoff('s1', 'continue'), true);
  assert.equal(tryClaimHandoff('s1', 'continue'), false);
  assert.equal(tryClaimHandoff('s1', 'standby'), false);

  releaseHandoffClaim('s1');
  assert.equal(tryClaimHandoff('s1', 'continue'), true);
});

test('a provider recorded as limited is skipped as a fallback until its limit resets', () => {
  const runtime = fakeRuntime(['claude', 'codex', 'openrouter']);
  markProviderLimited('codex', Date.now() + 60_000);

  assert.equal(isProviderLimited('codex'), true);
  assert.equal(pickFallbackProvider(DEFAULT_FALLBACK_ORDER, 'claude', runtime), 'openrouter');

  markProviderLimited('codex', Date.now() - 1);
  assert.equal(isProviderLimited('codex'), false);
  assert.equal(pickFallbackProvider(DEFAULT_FALLBACK_ORDER, 'claude', runtime), 'codex');
});

/** Runs `run` against a throwaway database, with a runtime that records each started turn. */
async function withHandoffDatabase(
  run: (context: { projectPath: string; runtime: ProviderRuntimeGateway; turns: Array<{ provider: string; command: string }> }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'limit-handoff-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const turns: Array<{ provider: string; command: string }> = [];
  const runtime = {
    hasRuntime: () => true,
    run: async (provider: string, command: string) => {
      turns.push({ provider, command });
    },
  } as unknown as ProviderRuntimeGateway;

  try {
    await run({ projectPath: tempDirectory, runtime, turns });
    // Let the started turns settle before the database goes away.
    await new Promise((resolve) => { setTimeout(resolve, 30); });
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('handoffSessionOnLimit opens a session on the first fallback that is signed in and starts it from the history file', async () => {
  await withHandoffDatabase(async ({ projectPath, runtime, turns }) => {
    sessionsDb.createAppSession('from-session', 'openrouter', projectPath, 'Refactor');

    const result = await handoffSessionOnLimit(
      { fromSessionId: 'from-session', userId: 1, reason: 'rate_limit', fallbackOrder: ['codex', 'claude', 'cursor'] },
      runtime,
      // Codex is first in the order but not signed in on this machine.
      async (provider) => provider !== 'codex',
    );

    assert.equal(result.fromProvider, 'openrouter');
    assert.equal(result.toProvider, 'claude');
    assert.equal(result.mode, 'continue');

    const created = sessionsDb.getSessionById(result.toSessionId);
    assert.equal(created?.provider, 'claude');
    assert.equal(created?.custom_name, 'Refactor (continued)');

    assert.equal(turns.length, 1);
    assert.equal(turns[0].provider, 'claude');
    const contextFile = path.join(os.homedir(), '.cloudcli', 'handoff-context', `${result.toSessionId}.md`);
    assert.ok(turns[0].command.includes(contextFile));
    assert.match(turns[0].command, /continue from where it leaves off/);
  });
});

test('a standby handoff tells the fallback to wait instead of resuming work', async () => {
  await withHandoffDatabase(async ({ projectPath, runtime, turns }) => {
    sessionsDb.createAppSession('from-session', 'openrouter', projectPath);

    const result = await handoffSessionOnLimit(
      { fromSessionId: 'from-session', userId: 1, reason: 'five_hour', mode: 'standby', fallbackOrder: ['codex'] },
      runtime,
      async () => true,
    );

    assert.equal(result.mode, 'standby');
    assert.match(turns[0].command, /do not start any work yet/);
  });
});

test('two exhausted backends do not hand a conversation back and forth', async () => {
  await withHandoffDatabase(async ({ projectPath, runtime }) => {
    sessionsDb.createAppSession('first', 'openrouter', projectPath);
    const first = await handoffSessionOnLimit(
      { fromSessionId: 'first', userId: 1, reason: 'rate_limit', fallbackOrder: ['codex', 'openrouter'] },
      runtime,
      async () => true,
    );
    assert.equal(first.toProvider, 'codex');

    // The fallback hits its own limit: the original provider is still limited.
    await assert.rejects(
      handoffSessionOnLimit(
        { fromSessionId: first.toSessionId, userId: 1, reason: 'unknown_limit', fallbackOrder: ['codex', 'openrouter'] },
        runtime,
        async () => true,
      ),
      /No fallback backend is available/,
    );
  });
});
