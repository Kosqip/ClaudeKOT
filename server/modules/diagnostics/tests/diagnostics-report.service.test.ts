import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import { redactSecrets } from '@/modules/diagnostics/services/diagnostics-report.service.js';

test('redactSecrets removes keys, tokens, e-mail addresses and the home folder', () => {
  const dirty = [
    'OpenRouter said 401 for sk-or-v1-0123456789abcdef0123456789abcdef',
    'Authorization: Bearer abcdefghijklmnop.qrstuv',
    '{"apiKey":"super-secret-value-1","token": "another-secret"}',
    'signed in as someone@example.com',
    `reading ${os.homedir()}/project/file.ts`,
  ].join('\n');
  const clean = redactSecrets(dirty);

  for (const leaked of ['0123456789abcdef', 'abcdefghijklmnop', 'super-secret-value-1', 'another-secret', 'someone@example.com']) {
    assert.equal(clean.includes(leaked), false, `leaked: ${leaked}`);
  }
  if (os.homedir().length > 1) {
    assert.equal(clean.includes(os.homedir()), false);
  }
  assert.match(clean, /OpenRouter said 401/);
  assert.match(clean, /~\/project\/file\.ts/);
});

test('redactSecrets leaves ordinary log text alone', () => {
  const line = '2026-01-01T00:00:00.000Z ERROR [Handoff] Auto-handoff failed { sessionId: "3f2c1a9e-1111-2222-3333-444455556666" }';
  assert.equal(redactSecrets(line), line);
});
