import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp } from 'lucide-react';

import {
  DEFAULT_HANDOFF_FALLBACK_ORDER,
  readUserPreference,
  writeUserPreference,
} from '@/shared/userSettings';
import { LLM_PROVIDER_NAMES } from '@/shared/constants';
import type { LLMProvider } from '@/shared/types';

/**
 * Global control for the order the handoff module tries fallback backends
 * in — e.g. prefer Codex, then fall back further to a Custom API model only
 * once every CLI backend is also unavailable. Rendered once in the agents
 * settings tab, below `HandoffThresholdSetting`.
 */
export default function HandoffFallbackOrderSetting() {
  const { t } = useTranslation('settings');
  const [order, setOrder] = useState<LLMProvider[]>(() => (
    readUserPreference('handoffFallbackOrder', DEFAULT_HANDOFF_FALLBACK_ORDER)
  ));

  const persist = (next: LLMProvider[]) => {
    setOrder(next);
    writeUserPreference('handoffFallbackOrder', next);
  };

  const move = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= order.length) {
      return;
    }
    const next = [...order];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    persist(next);
  };

  return (
    <div className="border-t border-border/50 px-4 py-4 md:px-6">
      <div className="font-medium text-foreground">
        {t('agents.handoffFallbackOrder.title')}
      </div>
      <div className="mb-3 text-sm text-muted-foreground">
        {t('agents.handoffFallbackOrder.description')}
      </div>
      <ol className="flex flex-col gap-1">
        {order.map((provider, index) => (
          <li key={provider} className="flex items-center justify-between rounded-md border border-border/50 px-3 py-1.5 text-sm">
            <span>{index + 1}. {LLM_PROVIDER_NAMES[provider]}</span>
            <span className="flex gap-1">
              <button
                type="button"
                aria-label={t('agents.handoffFallbackOrder.moveUp')}
                disabled={index === 0}
                onClick={() => move(index, -1)}
                className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={t('agents.handoffFallbackOrder.moveDown')}
                disabled={index === order.length - 1}
                onClick={() => move(index, 1)}
                className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
