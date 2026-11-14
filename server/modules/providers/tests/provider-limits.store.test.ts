import assert from 'node:assert/strict';
import test from 'node:test';

import { createProviderLimitsStore } from '@/modules/providers/services/provider-limits.store.js';

function memoryStore(initial: string | null = null) {
  let saved = initial;
  let now = new Date('2026-11-14T10:00:00.000Z');
  const store = createProviderLimitsStore({
    load: () => saved,
    save: (json) => {
      saved = json;
    },
    now: () => now,
  });
  return {
    store,
    saved: () => saved,
    setNow: (value: string) => {
      now = new Date(value);
    },
  };
}

test('a provider that never reported has "no data" for both windows', () => {
  const { store } = memoryStore();
  assert.deepEqual(store.list(), [
    { provider: 'claude', fiveHour: null, sevenDay: null },
    { provider: 'codex', fiveHour: null, sevenDay: null },
  ]);
});

test('each window keeps its own last reading with percent, reset time and when it was received', () => {
  const { store, setNow } = memoryStore();
  assert.equal(store.record('claude', { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.873, resetsAt: '2026-11-14T13:00:00.000Z' }), true);
  setNow('2026-11-14T10:05:00.000Z');
  assert.equal(store.record('claude', { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.4, resetsAt: '2026-11-18T00:00:00.000Z' }), true);

  const claude = store.list()[0];
  assert.deepEqual(claude.fiveHour, { usedPercent: 87.3, resetsAt: '2026-11-14T13:00:00.000Z', status: 'allowed_warning', observedAt: '2026-11-14T10:00:00.000Z' });
  assert.deepEqual(claude.sevenDay, { usedPercent: 40, resetsAt: '2026-11-18T00:00:00.000Z', status: 'allowed', observedAt: '2026-11-14T10:05:00.000Z' });
});

test('a field the reading lacks is stored as null, not carried over or guessed', () => {
  const { store } = memoryStore();
  store.record('claude', { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: '2026-11-14T13:00:00.000Z' });
  store.record('claude', { status: 'rejected', rateLimitType: 'five_hour' });
  assert.deepEqual(store.list()[0].fiveHour, { usedPercent: null, resetsAt: null, status: 'rejected', observedAt: '2026-11-14T10:00:00.000Z' });
});

test('readings without a five-hour or weekly window, and providers without plan windows, are ignored', () => {
  const { store, saved } = memoryStore();
  assert.equal(store.record('claude', { status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 0.9 }), false);
  assert.equal(store.record('claude', { status: 'allowed', utilization: 0.9 }), false);
  assert.equal(store.record('openrouter', { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.9 }), false);
  assert.equal(saved(), null);
  assert.deepEqual(store.list()[0], { provider: 'claude', fiveHour: null, sevenDay: null });
});

test('the snapshot is persisted and read back by a new store; a corrupt one reads as no data', () => {
  const first = memoryStore();
  first.store.record('codex', { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.12, resetsAt: '2026-11-20T00:00:00.000Z' });

  const second = memoryStore(first.saved());
  assert.deepEqual(second.store.list()[1].sevenDay, { usedPercent: 12, resetsAt: '2026-11-20T00:00:00.000Z', status: 'allowed', observedAt: '2026-11-14T10:00:00.000Z' });

  const corrupt = memoryStore('{not json');
  assert.deepEqual(corrupt.store.list()[1], { provider: 'codex', fiveHour: null, sevenDay: null });
});
