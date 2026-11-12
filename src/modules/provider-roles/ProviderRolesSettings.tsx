import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PROVIDER_ROLE_OPTIONS, readUserPreference, writeUserPreference } from '@/shared/userSettings';
import { LLM_PROVIDER_NAMES } from '@/shared/constants';
import type { LLMProvider } from '@/shared/types';

const PROVIDERS: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode', 'openrouter'];

/**
 * Global per-provider role assignment, read by the orchestrator: in a
 * session whose provider is marked `orchestrator`, "Split into subtasks"
 * has that provider plan the work and sends each subtask to the provider
 * marked `hands` or `routine`. Rendered once in the agents settings tab,
 * alongside the handoff settings.
 */
export default function ProviderRolesSettings() {
  const { t } = useTranslation('settings');
  const [roles, setRoles] = useState(() => readUserPreference('providerRoles', {} as Record<LLMProvider, string>));

  const handleChange = (provider: LLMProvider, role: string) => {
    const next = { ...roles, [provider]: role || undefined };
    setRoles(next);
    writeUserPreference('providerRoles', next);
  };

  return (
    <div className="border-t border-border/50 px-4 py-4 md:px-6">
      <div className="font-medium text-foreground">
        {t('agents.providerRoles.title')}
      </div>
      <div className="mb-3 text-sm text-muted-foreground">
        {t('agents.providerRoles.description')}
      </div>
      <ul className="flex flex-col gap-1">
        {PROVIDERS.map((provider) => (
          <li key={provider} className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-1.5 text-sm">
            <span>{LLM_PROVIDER_NAMES[provider]}</span>
            <select
              value={roles[provider] ?? ''}
              onChange={(event) => handleChange(provider, event.target.value)}
              className="rounded-md border border-input bg-background py-1 pl-2 pr-8 text-sm"
            >
              {PROVIDER_ROLE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {t(`agents.providerRoles.roles.${option || 'none'}`)}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </div>
  );
}
