import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readOpenRouterHistory } from '@/modules/providers/list/openrouter/openrouter-history.store.js';
import { openRouterRuntime } from '@/modules/providers/list/openrouter/openrouter-runtime.provider.js';
import { parseModelReference } from '@/modules/providers/list/openrouter/openrouter-service-registry.js';
import { detectProviderLimit } from '@/modules/providers/services/provider-limit-detection.service.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

const KEY_ENV_VARS = ['OPENROUTER_API_KEY', 'ANTHROPIC_DIRECT_API_KEY', 'OPENAI_DIRECT_API_KEY'] as const;

type FetchCall = { url: string; headers: Record<string, string>; body: AnyRecord };

/** A streamed HTTP response whose body arrives in exactly the given chunks. */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, { status });
}

/**
 * Runs one turn of the API provider against a stubbed `fetch`, with only the
 * given API keys set, and returns what it sent, wrote and stored.
 */
async function runTurn(input: {
  model: string;
  keys: Partial<Record<(typeof KEY_ENV_VARS)[number], string>>;
  respond: () => Response;
  alreadyHasProviderId?: boolean;
}) {
  const sessionId = randomUUID();
  const previousFetch = globalThis.fetch;
  const previousKeys = Object.fromEntries(KEY_ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of KEY_ENV_VARS) {
    delete process.env[name];
  }
  Object.assign(process.env, input.keys);

  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as AnyRecord,
    });
    return input.respond();
  }) as typeof fetch;

  const sent: AnyRecord[] = [];
  const announcedSessionIds: string[] = [];
  try {
    await openRouterRuntime.run(
      'Say hi',
      { sessionId, model: input.model },
      {
        send: (data) => sent.push(data as AnyRecord),
        setSessionId: (id) => announcedSessionIds.push(id),
      },
      {
        resolveResumeModel: async (_sessionId: string | undefined, model?: string | null) => model ?? undefined,
        resolveProviderSessionId: () => (input.alreadyHasProviderId ? sessionId : null),
      } as unknown as ProviderRuntimeContext,
    );
    return { sessionId, calls, sent, announcedSessionIds, history: await readOpenRouterHistory(sessionId) };
  } finally {
    globalThis.fetch = previousFetch;
    for (const name of KEY_ENV_VARS) {
      if (previousKeys[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previousKeys[name];
      }
    }
    await rm(path.join(os.homedir(), '.cloudcli', 'openrouter-sessions', `${sessionId}.jsonl`), { force: true });
  }
}

test('parseModelReference reads a known service prefix and leaves every other model id whole', () => {
  assert.deepEqual(parseModelReference('anthropic:claude-opus-5-5'), { service: 'anthropic', modelId: 'claude-opus-5-5' });
  assert.deepEqual(parseModelReference('openai:gpt-5.1'), { service: 'openai', modelId: 'gpt-5.1' });
  assert.deepEqual(
    parseModelReference('openrouter:meta-llama/llama-3.1-8b-instruct:free'),
    { service: 'openrouter', modelId: 'meta-llama/llama-3.1-8b-instruct:free' },
  );
  // A bare OpenRouter id with its own colon, as stored before services existed.
  assert.deepEqual(
    parseModelReference('meta-llama/llama-3.1-8b-instruct:free'),
    { service: 'openrouter', modelId: 'meta-llama/llama-3.1-8b-instruct:free' },
  );
});

test('an OpenRouter turn streams the reply, stores both sides and registers the session id', async () => {
  const turn = await runTurn({
    model: 'meta-llama/llama-3.1-8b-instruct:free',
    keys: { OPENROUTER_API_KEY: 'or-key' },
    // The second delta is split across two network chunks, mid-line.
    respond: () => sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"de',
      'lta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
    ]),
  });

  assert.equal(turn.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(turn.calls[0].headers.Authorization, 'Bearer or-key');
  assert.equal(turn.calls[0].body.model, 'meta-llama/llama-3.1-8b-instruct:free');
  assert.deepEqual(turn.calls[0].body.messages, [{ role: 'user', content: 'Say hi' }]);

  assert.deepEqual(turn.sent.filter((message) => message.kind === 'stream_delta').map((message) => message.content), ['Hel', 'lo']);
  assert.equal(turn.sent.at(-1)?.kind, 'complete');
  assert.equal(turn.sent.at(-1)?.exitCode, 0);

  assert.deepEqual(
    turn.history.map((message) => [message.role, message.content]),
    [['user', 'Say hi'], ['assistant', 'Hello']],
  );
  // Without this the app considers the session to have no transcript at all.
  assert.deepEqual(turn.announcedSessionIds, [turn.sessionId]);
});

test('a session that already has its provider id is not announced again', async () => {
  const turn = await runTurn({
    model: 'meta-llama/llama-3.1-8b-instruct:free',
    keys: { OPENROUTER_API_KEY: 'or-key' },
    respond: () => sseResponse(['data: [DONE]\n\n']),
    alreadyHasProviderId: true,
  });
  assert.deepEqual(turn.announcedSessionIds, []);
});

test('an anthropic: model goes to the Anthropic Messages API in its own format', async () => {
  const turn = await runTurn({
    model: 'anthropic:claude-opus-5-5',
    keys: { ANTHROPIC_DIRECT_API_KEY: 'ant-key' },
    respond: () => sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hidden"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]),
  });

  assert.equal(turn.calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(turn.calls[0].headers['x-api-key'], 'ant-key');
  assert.ok(turn.calls[0].headers['anthropic-version']);
  assert.equal(turn.calls[0].body.model, 'claude-opus-5-5');
  assert.equal(turn.calls[0].body.stream, true);
  assert.ok(Number(turn.calls[0].body.max_tokens) > 0);

  assert.deepEqual(turn.history.map((message) => [message.role, message.content]), [['user', 'Say hi'], ['assistant', 'Hi']]);
});

test('an error the service sends after streaming began is reported and kept in the transcript', async () => {
  const turn = await runTurn({
    model: 'anthropic:claude-opus-5-5',
    keys: { ANTHROPIC_DIRECT_API_KEY: 'ant-key' },
    respond: () => sseResponse([
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Par"}}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ]),
  });

  const error = turn.sent.find((message) => message.kind === 'error');
  assert.equal(error?.content, 'anthropic stream failed: Overloaded');
  assert.deepEqual(turn.history.map((message) => message.kind), ['text', 'error', 'text']);
  assert.equal(turn.sent.at(-1)?.kind, 'complete');
});

test('a 429 from any service is reported in the form the limit detector recognises', async () => {
  const turn = await runTurn({
    model: 'openai:gpt-5.1',
    keys: { OPENAI_DIRECT_API_KEY: 'oai-key' },
    respond: () => new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 }),
  });

  assert.equal(turn.calls[0].url, 'https://api.openai.com/v1/chat/completions');
  const error = turn.sent.find((message) => message.kind === 'error');
  assert.match(String(error?.content), /^openai request failed \(429\)/);
  assert.deepEqual(
    detectProviderLimit('openrouter', { message: String(error?.content) }),
    { detected: true, reason: 'rate_limit' },
  );
});

test('a missing API key is reported without calling the service, and the question is still stored', async () => {
  const turn = await runTurn({
    model: 'anthropic:claude-opus-5-5',
    keys: {},
    respond: () => { throw new Error('fetch must not be called'); },
  });

  assert.equal(turn.calls.length, 0);
  assert.equal(turn.sent.find((message) => message.kind === 'error')?.content, 'ANTHROPIC_DIRECT_API_KEY is not set on the server.');
  assert.deepEqual(turn.history.map((message) => message.kind), ['text', 'error']);
});
