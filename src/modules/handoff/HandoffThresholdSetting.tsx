import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  DEFAULT_HANDOFF_THRESHOLD_PERCENT,
  HANDOFF_THRESHOLD_OPTIONS,
  readUserPreference,
  writeUserPreference,
} from '@/shared/userSettings';

/**
 * Global (not per-provider) control for when the handoff module continues a
 * Claude session on a fallback backend automatically: at a hard rejection
 * only (100), or proactively once claude.ai's own reported utilization
 * reaches one of 95/90/85/80 percent. Rendered once in the agents settings
 * tab, below the per-provider account/model sections — this setting is not
 * scoped to any one provider.
 */
export default function HandoffThresholdSetting() {
  const { t } = useTranslation('settings');
  const [thresholdPercent, setThresholdPercent] = useState(() => (
    readUserPreference('handoffThresholdPercent', DEFAULT_HANDOFF_THRESHOLD_PERCENT)
  ));

  const handleChange = (value: number) => {
    setThresholdPercent(value);
    writeUserPreference('handoffThresholdPercent', value);
  };

  return (
    <div className="border-t border-border/50 px-4 py-4 md:px-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="font-medium text-foreground">
            {t('agents.handoffThreshold.title', { defaultValue: 'Automatic backend handoff' })}
          </div>
          <div className="text-sm text-muted-foreground">
            {t('agents.handoffThreshold.description', {
              defaultValue: 'When Claude’s own usage reaches this level, continue the session on a fallback backend automatically. "Only on full limit" waits for a hard rejection instead.',
            })}
          </div>
        </div>
        <select
          value={thresholdPercent}
          onChange={(event) => handleChange(Number(event.target.value))}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        >
          {HANDOFF_THRESHOLD_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option === 100
                ? t('agents.handoffThreshold.onlyFullLimit', { defaultValue: 'Only on full limit' })
                : t('agents.handoffThreshold.atPercent', { defaultValue: `At ${option}%`, percent: option })}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
