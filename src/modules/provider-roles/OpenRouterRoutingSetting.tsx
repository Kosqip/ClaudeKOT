import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  OPENROUTER_PROVIDER_SORT_OPTIONS,
  readUserPreference,
  writeUserPreference,
} from '@/shared/userSettings';
import type { OpenRouterProviderSort } from '@/shared/userSettings';

/**
 * Global control for how OpenRouter picks among the hosting providers that
 * sell the same model — its own balance, cheapest first, fastest output
 * first, or quickest to start answering first. Applies to every OpenRouter
 * request the Custom API backend makes. Rendered once in the agents
 * settings tab, below the backend roles.
 */
export default function OpenRouterRoutingSetting() {
  const { t } = useTranslation('settings');
  const [sort, setSort] = useState<OpenRouterProviderSort>(() => (
    readUserPreference('openRouterProviderSort', 'default')
  ));

  const handleChange = (value: OpenRouterProviderSort) => {
    setSort(value);
    writeUserPreference('openRouterProviderSort', value);
  };

  return (
    <div className="border-t border-border/50 px-4 py-4 md:px-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="font-medium text-foreground">{t('agents.openRouterRouting.title')}</div>
          <div className="text-sm text-muted-foreground">{t('agents.openRouterRouting.description')}</div>
        </div>
        <select
          value={sort}
          onChange={(event) => handleChange(event.target.value as OpenRouterProviderSort)}
          className="rounded-md border border-input bg-background py-1.5 pl-3 pr-8 text-sm"
        >
          {OPENROUTER_PROVIDER_SORT_OPTIONS.map((option) => (
            <option key={option} value={option}>{t(`agents.openRouterRouting.options.${option}`)}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
