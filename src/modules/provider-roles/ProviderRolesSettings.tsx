import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PROVIDER_ROLE_OPTIONS, readUserPreference, writeUserPreference } from '@/shared/userSettings';
import type { LLMProvider } from '@/shared/types';

const PROVIDERS: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode', 'openrouter'];

const PROVIDER_LABEL: Record<LLMProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  openrouter: 'Custom API',
};

const ROLE_LABEL: Record<(typeof PROVIDER_ROLE_OPTIONS)[number], string> = {
  '': 'No role',
  orchestrator: 'Orchestrator',
  hands: 'Hands',
  routine: 'Routine',
};

/**
 * Global per-provider role assignment — purely declarative today: nothing in
 * this app yet reads `providerRoles` to drive behavior. It is the
 * configuration surface for a future task-splitting orchestrator (not yet
 * built), which would read a provider marked `orchestrator` to plan and
 * delegate work, `hands` to execute delegated subtasks, and `routine` as a
 * cheap default for low-stakes work. Rendered once in the agents settings
 * tab, alongside the handoff settings.
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
        {t('agents.providerRoles.title', { defaultValue: 'Provider roles' })}
      </div>
      <div className="mb-3 text-sm text-muted-foreground">
        {t('agents.providerRoles.description', {
          defaultValue: 'Labels for a future task-splitting orchestrator — not used by anything yet.',
        })}
      </div>
      <ul className="flex flex-col gap-1">
        {PROVIDERS.map((provider) => (
          <li key={provider} className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-1.5 text-sm">
            <span>{PROVIDER_LABEL[provider]}</span>
            <select
              value={roles[provider] ?? ''}
              onChange={(event) => handleChange(provider, event.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            >
              {PROVIDER_ROLE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABEL[option]}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </div>
  );
}
