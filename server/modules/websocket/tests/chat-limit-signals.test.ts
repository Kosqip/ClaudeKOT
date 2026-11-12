import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { runDetachedChatTurn, startDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';

type Writer = { send(data: unknown): void; setSessionId?(id: string): void; getSessionId?(): string | null };

async function withSession(
  provider: string,
  run: (sessionId: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-limit-signals-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    sessionsDb.createAppSession('signal-session', provider, tempDirectory);
    await run('signal-session');
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

test('an error a runtime reports as a message, without throwing, still reaches onRunFailed', async () => {
  // Codex and the API provider catch their own failures, send an `error`
  // message and resolve — the path a limit on either of them takes.
  await withSession('codex', async (sessionId) => {
    const failures: Array<{ provider: string; sessionId: string; message: string }> = [];

    const result = await runDetachedChatTurn(
      { sessionId, userId: 1, content: 'hello' },
      {
        runtime: {
          hasRuntime: () => true,
          run: async (_provider: string, _command: string, _options: unknown, writer: Writer) => {
            writer.send({ kind: 'error', content: 'You have hit your usage limit', sessionId, provider: 'codex' });
          },
        } as never,
        onRunFailed: (failure) => failures.push(failure),
      },
    );

    assert.equal(result.started, true);
    assert.deepEqual(failures, [{ provider: 'codex', sessionId, userId: 1, message: 'You have hit your usage limit' }]);
  });
});

test('a rate_limit_status message reaches onRateLimitStatus and the writer keeps its other methods', async () => {
  await withSession('claude', async (sessionId) => {
    const statuses: unknown[] = [];
    let sessionIdFromWriter: string | null | undefined;

    await runDetachedChatTurn(
      { sessionId, userId: 1, content: 'hello' },
      {
        runtime: {
          hasRuntime: () => true,
          run: async (_provider: string, _command: string, _options: unknown, writer: Writer) => {
            writer.send({ kind: 'rate_limit_status', sessionId, provider: 'claude', rateLimitStatus: { status: 'rejected', rateLimitType: 'five_hour' } });
            // Not part of `ProviderRuntimeWriter`, but the Claude runtime calls it.
            sessionIdFromWriter = writer.getSessionId?.();
          },
        } as never,
        onRateLimitStatus: (input) => statuses.push(input.status),
      },
    );

    assert.deepEqual(statuses, [{ status: 'rejected', rateLimitType: 'five_hour' }]);
    assert.notEqual(sessionIdFromWriter, undefined, 'getSessionId was lost by the writer wrapper');
  });
});

test('startDetachedChatTurn resolves when the turn starts, not when it ends', async () => {
  await withSession('claude', async (sessionId) => {
    let finishTurn: () => void = () => undefined;
    const turnFinished = new Promise<void>((resolve) => { finishTurn = resolve; });

    const dispatch = await startDetachedChatTurn(
      { sessionId, userId: 1, content: 'a long task' },
      { runtime: { hasRuntime: () => true, run: () => turnFinished } as never },
    );

    assert.equal(dispatch.started, true);
    let settled = false;
    void dispatch.completion.then(() => { settled = true; });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.equal(settled, false, 'the turn is still running');

    // A second start for the same session is refused up front.
    const second = await startDetachedChatTurn(
      { sessionId, userId: 1, content: 'again' },
      { runtime: { hasRuntime: () => true, run: async () => undefined } as never },
    );
    assert.equal(second.started, false);

    finishTurn();
    assert.deepEqual(await dispatch.completion, { started: true, error: null });
  });
});

test('startDetachedChatTurn refuses a session that does not exist', async () => {
  await withSession('claude', async () => {
    const dispatch = await startDetachedChatTurn(
      { sessionId: 'missing', userId: 1, content: 'x' },
      { runtime: { hasRuntime: () => true, run: async () => undefined } as never },
    );
    assert.equal(dispatch.started, false);
    assert.equal(dispatch.error, 'The session no longer exists.');
  });
});
