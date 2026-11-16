import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { LLM_PROVIDER_NAMES } from '@/shared/constants';
import type { LLMProvider } from '@/shared/types';
import { DEFAULT_HANDOFF_THRESHOLD_PERCENT, readUserPreference, subscribeToUserPreferences } from '@/shared/userSettings';
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

/** How often the "N minutes ago" texts are recomputed. */
const CLOCK_TICK_MS = 30_000;

/** An absolute time in the viewer's own time zone and locale. */
function formatLocalTime(ms: number, language: string): string {
  return new Date(ms).toLocaleString(language, { dateStyle: 'short', timeStyle: 'short' });
}

/** "5 minutes ago" / "in 2 hours", in the viewer's language, in the largest unit that fits. */
function formatRelative(ms: number, now: number, language: string): string {
  const deltaSeconds = Math.round((ms - now) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [['day', 86_400], ['hour', 3_600], ['minute', 60]];
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  for (const [unit, seconds] of units) {
    if (Math.abs(deltaSeconds) >= seconds) {
      return formatter.format(Math.trunc(deltaSeconds / seconds), unit);
    }
  }
  return formatter.format(0, 'minute');
}

function LimitWindowRow({
  label,
  window,
  now,
  thresholdPercent,
}: {
  label: string;
  window: ProviderLimitWindow | null;
  now: number;
  thresholdPercent: number;
}) {
  const { t, i18n } = useTranslation('settings');
  if (!window) {
    return (
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-muted-foreground">{t('agents.providerLimits.noData')}</span>
      </div>
    );
  }

  const observedMs = Date.parse(window.observedAt);
  const resetsMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const hasReset = Number.isFinite(resetsMs) && resetsMs <= now;
  // 100 means the user turned early switching off: only a refusal warns then.
  const overThreshold = !hasReset && thresholdPercent < 100 && window.usedPercent !== null && window.usedPercent >= thresholdPercent;
  const barColor = window.status === 'rejected' || (window.usedPercent ?? 0) >= 95
    ? 'bg-red-500'
    : overThreshold || window.status === 'allowed_warning' ? 'bg-amber-500' : 'bg-emerald-500';

  const details = [
    window.status !== 'allowed' && !hasReset ? t(`agents.providerLimits.status.${window.status}`) : null,
    Number.isFinite(resetsMs)
      ? (hasReset
        ? t('agents.providerLimits.resetPassed', { time: formatLocalTime(resetsMs, i18n.language) })
        : t('agents.providerLimits.resetsAt', {
          time: formatLocalTime(resetsMs, i18n.language),
          relative: formatRelative(resetsMs, now, i18n.language),
        }))
      : null,
    Number.isFinite(observedMs)
      ? t('agents.providerLimits.observedAt', { relative: formatRelative(observedMs, now, i18n.language) })
      : null,
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
      <div className="text-xs text-muted-foreground" title={Number.isFinite(observedMs) ? formatLocalTime(observedMs, i18n.language) : undefined}>
        {details}
      </div>
      {overThreshold && (
        <div className="text-xs text-amber-700 dark:text-amber-400">
          {t('agents.providerLimits.overThreshold', { threshold: thresholdPercent })}
        </div>
      )}
    </div>
  );
}

/**
 * "Subscription limits": the last 5-hour and weekly usage Claude and Codex
 * themselves reported, with reset times in the viewer's own time, how old
 * each reading is, and a warning once usage reaches the user's handoff
 * threshold. Shows
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
  // The current time, advanced on a timer so "N minutes ago" stays true while the screen is open.
  const [now, setNow] = useState(() => Date.now());
  // Follows the threshold select rendered just below, so the warning moves with it.
  const thresholdPercent = useSyncExternalStore(
    subscribeToUserPreferences,
    () => readUserPreference('handoffThresholdPercent', DEFAULT_HANDOFF_THRESHOLD_PERCENT),
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.providers.limits()
      .then((response) => readApiJson<{ data: { providers: ProviderLimits[] } }>(response))
      .then(
        (body) => {
          if (!cancelled) {
            setLimits(body.data.providers);
            setLoadFailed(false);
            setNow(Date.now());
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
              <LimitWindowRow label={t('agents.providerLimits.fiveHour')} window={entry.fiveHour} now={now} thresholdPercent={thresholdPercent} />
              <LimitWindowRow label={t('agents.providerLimits.sevenDay')} window={entry.sevenDay} now={now} thresholdPercent={thresholdPercent} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
