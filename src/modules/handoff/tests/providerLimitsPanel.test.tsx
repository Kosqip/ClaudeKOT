import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

/**
 * The "Subscription limits" screen shows exactly what the server stored: a
 * reported window with its percent, and "no data" for a window nobody has
 * reported — never a zero standing in for a missing reading.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values?.percent !== undefined ? `${key}:${String(values.percent)}` : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      limits: async () => new Response(JSON.stringify({
        success: true,
        data: {
          providers: [
            {
              provider: 'claude',
              fiveHour: { usedPercent: 87.5, resetsAt: '2026-11-14T13:00:00.000Z', status: 'allowed_warning', observedAt: '2026-11-14T10:00:00.000Z' },
              sevenDay: null,
            },
            { provider: 'codex', fiveHour: null, sevenDay: null },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    },
  },
  readApiJson: async (response: Response) => response.json(),
}));

const { default: ProviderLimitsPanel } = await import('@/modules/handoff/ProviderLimitsPanel');

test('a reported window shows its usage and every unreported window shows "no data"', async () => {
  render(<ProviderLimitsPanel />);

  assert.ok(await screen.findByText('agents.providerLimits.used:87.5'));
  assert.equal(screen.getAllByText('agents.providerLimits.noData').length, 3);
  assert.ok(screen.getByText('Claude'));
  assert.ok(screen.getByText('Codex'));
});
