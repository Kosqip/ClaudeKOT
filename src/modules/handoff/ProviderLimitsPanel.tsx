import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { LLM_PROVIDER_NAMES } from '@/shared/constants';
import type { LLMProvider } from '@/shared/types';
import { cn } from '@/shared/utils';

/** One subscription window as `GET /api/providers/limits` reports it (mirrors the server's `ProviderLimitWindowSnapshot`). */
type ProviderLimitWindow = {
  usedPercent: number | null;
  resetsAt: string | null;
  status: 'allowed' | 'allowed_warning' | 'rejected';
  observedAt: string;
};

/** One provider's last known windows (mirrors the server's `ProviderLimitsSnapshot`); null: never reported. */
type ProviderLimits = {
  provider: LLMProvider;
  fiveHour: ProviderLimitWindow | null;
  sevenDay: ProviderLimitWindow | null;
};

function formatTime(iso: string, language: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(language, { dateStyle: 'short', timeStyle: 'short' });
}

function LimitWindowRow({ label, window }: { label: string; window: ProviderLimitWindow | null }) {
  const { t, i18n } = useTranslation('settings');
  if (!window) {
    return (
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-muted-foreground">{t('agents.providerLimits.noData')}</span>
      </div>
    );
  }

  const barColor = window.status === 'rejected' || (window.usedPercent ?? 0) >= 95
    ? 'bg-red-500'
    : window.status === 'allowed_warning' || (window.usedPercent ?? 0) >= 80 ? 'bg-amber-500' : 'bg-emerald-500';
  const details = [
    window.status !== 'allowed' ? t(`agents.providerLimits.status.${window.status}`) : null,
    window.resetsAt ? t('agents.providerLimits.resetsAt', { time: formatTime(window.resetsAt, i18n.language) }) : null,
    t('agents.providerLimits.observedAt', { time: formatTime(window.observedAt, i18n.language) }),
  ].filter(Boolean).join(' · ');

  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium text-foreground">
          {window.usedPercent === null
            ? t('agents.providerLimits.usedUnknown')
            : t('agents.providerLimits.used', { percent: window.usedPercent })}
        </span>
      </div>
      {window.usedPercent !== null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full', barColor)} style={{ width: `${Math.min(100, window.usedPercent)}%` }} />
        </div>
      )}
      <div className="text-xs text-muted-foreground">{details}</div>
    </div>
  );
}

/**
 * "Subscription limits": the last 5-hour and weekly usage Claude and Codex
 * themselves reported, with reset times and how old each reading is. Shows
 * "no data" for a window the server has not received, never an estimate.
 * Rendered once by the settings module's agents tab, above the handoff
 * threshold it informs.
 */
export default function ProviderLimitsPanel() {
  const { t } = useTranslation('settings');
  // The server's snapshot; null until the first answer arrives.
  const [limits, setLimits] = useState<ProviderLimits[] | null>(null);
  // Whether the last request failed, so a failure is not shown as "no data".
  const [loadFailed, setLoadFailed] = useState(false);

  // Bumped by the refresh button; each change asks the server again.
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.providers.limits()
      .then((response) => readApiJson<{ data: { providers: ProviderLimits[] } }>(response))
      .then(
        (body) => {
          if (!cancelled) {
            setLimits(body.data.providers);
            setLoadFailed(false);
          }
        },
        () => {
          if (!cancelled) {
            setLoadFailed(true);
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [reloadCount]);

  return (
    <div className="border-t border-border/50 px-4 py-4 md:px-6">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium text-foreground">{t('agents.providerLimits.title')}</div>
          <div className="mb-3 text-sm text-muted-foreground">{t('agents.providerLimits.description')}</div>
        </div>
        <button
          type="button"
          onClick={() => setReloadCount((count) => count + 1)}
          aria-label={t('agents.providerLimits.refresh')}
          title={t('agents.providerLimits.refresh')}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>
      {loadFailed && <p className="mb-2 text-sm text-destructive">{t('agents.providerLimits.loadFailed')}</p>}
      {limits && (
        <div className="grid gap-3 sm:grid-cols-2">
          {limits.map((entry) => (
            <div key={entry.provider} className="flex flex-col gap-2 rounded-md border border-border/50 p-3">
              <div className="font-medium text-foreground">{LLM_PROVIDER_NAMES[entry.provider] ?? entry.provider}</div>
              <LimitWindowRow label={t('agents.providerLimits.fiveHour')} window={entry.fiveHour} />
              <LimitWindowRow label={t('agents.providerLimits.sevenDay')} window={entry.sevenDay} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
