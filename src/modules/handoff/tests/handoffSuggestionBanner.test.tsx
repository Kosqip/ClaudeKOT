import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { HandoffSuggestion } from '@/shared/types';

/**
 * The offer to move a conversation off a backend that is close to its limit:
 * accepting asks the server for a standby handoff and reports the new session,
 * dismissing asks the server for nothing, and a refused request stays on
 * screen as a failure instead of pretending the conversation moved.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const trigger = vi.fn();
vi.mock('@/shared/api', () => ({
  api: { handoff: { trigger: (body: unknown) => trigger(body) } },
}));

const { default: HandoffSuggestionBanner } = await import('@/modules/handoff/HandoffSuggestionBanner');

const suggestion: HandoffSuggestion = {
  sessionId: 'from-session',
  fromProvider: 'claude',
  toProvider: 'codex',
  reason: 'five_hour',
  utilizationPercent: 91,
};

beforeEach(() => trigger.mockReset());

test('accepting requests a standby handoff and reports the new session', async () => {
  trigger.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { result: { toSessionId: 'to-session' } } }) });
  const switched: string[] = [];
  render(<HandoffSuggestionBanner suggestion={suggestion} onSwitched={(id) => switched.push(id)} onDismiss={() => undefined} />);

  assert.ok(screen.getByText('input.handoffSuggestPercent'));
  await act(async () => { fireEvent.click(screen.getByText('input.handoffSuggestAccept')); });

  assert.deepEqual(trigger.mock.calls[0][0], { sessionId: 'from-session', reason: 'five_hour', mode: 'standby' });
  assert.deepEqual(switched, ['to-session']);
});

test('a refused request shows a failure and does not report a switch', async () => {
  trigger.mockResolvedValue({ ok: false, json: async () => ({ success: false }) });
  const switched: string[] = [];
  render(<HandoffSuggestionBanner suggestion={suggestion} onSwitched={(id) => switched.push(id)} onDismiss={() => undefined} />);

  await act(async () => { fireEvent.click(screen.getByText('input.handoffSuggestAccept')); });

  assert.ok(screen.getByText('input.handoffSuggestFailed'));
  assert.deepEqual(switched, []);
});

test('dismissing does not contact the server', () => {
  let dismissed = 0;
  render(<HandoffSuggestionBanner suggestion={suggestion} onSwitched={() => undefined} onDismiss={() => { dismissed += 1; }} />);

  fireEvent.click(screen.getByText('input.handoffSuggestDismiss'));

  assert.equal(dismissed, 1);
  assert.equal(trigger.mock.calls.length, 0);
});
