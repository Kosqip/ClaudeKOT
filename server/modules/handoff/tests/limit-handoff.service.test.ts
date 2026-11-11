import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_FALLBACK_ORDER,
  pickFallbackProvider,
  renderHistoryAsText,
  writeHandoffContextFile,
} from '@/modules/handoff/services/limit-handoff.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

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
