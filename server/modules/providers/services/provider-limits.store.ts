import { appConfigDb } from '@/modules/database/index.js';
import type {
  LLMProvider,
  ProviderLimitsSnapshot,
  ProviderLimitWindowSnapshot,
  RateLimitStatus,
} from '@/shared/types.js';

/** `app_config` key the snapshot is persisted under, so it survives a restart. */
const APP_CONFIG_KEY = 'provider_limits_snapshot';

/**
 * Providers whose plan windows the app can read: Claude pushes
 * `rate_limit_event` live, Codex writes its reading to the rollout file after
 * each model call. The others (Cursor, OpenCode, Custom API) report no
 * subscription window, so they are not listed rather than shown empty.
 */
const LIMIT_TRACKED_PROVIDERS: LLMProvider[] = ['claude', 'codex'];

type StoredWindows = { fiveHour: ProviderLimitWindowSnapshot | null; sevenDay: ProviderLimitWindowSnapshot | null };

type ProviderLimitsStoreDependencies = {
  /** Reads the persisted JSON snapshot, or null when there is none. */
  load(): string | null;
  /** Persists the JSON snapshot. */
  save(json: string): void;
  /** Current time; injectable for tests. */
  now(): Date;
};

const RATE_LIMIT_STATUSES: ReadonlySet<string> = new Set(['allowed', 'allowed_warning', 'rejected']);

// A persisted window is trusted only if it has the shape this file writes;
// anything else (a hand-edited row, an older format) is dropped as "no data".
function readStoredWindow(value: unknown): ProviderLimitWindowSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const window = value as Record<string, unknown>;
  if (typeof window.observedAt !== 'string' || typeof window.status !== 'string' || !RATE_LIMIT_STATUSES.has(window.status)) {
    return null;
  }
  return {
    usedPercent: typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? window.usedPercent : null,
    resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : null,
    status: window.status as RateLimitStatus['status'],
    observedAt: window.observedAt,
  };
}

/**
 * Builds the store of each provider's last known subscription windows.
 * Exported for this module's tests, which pass in-memory dependencies; the
 * app uses `providerLimitsStore` below.
 */
export function createProviderLimitsStore(dependencies: ProviderLimitsStoreDependencies) {
  let windowsByProvider: Map<LLMProvider, StoredWindows> | null = null;

  // Loaded on first use, not at import: the database is opened after the
  // modules are imported.
  const ensureLoaded = (): Map<LLMProvider, StoredWindows> => {
    if (windowsByProvider) {
      return windowsByProvider;
    }
    windowsByProvider = new Map();
    try {
      const raw = dependencies.load();
      const parsed = raw ? JSON.parse(raw) as Record<string, Record<string, unknown>> : {};
      for (const provider of LIMIT_TRACKED_PROVIDERS) {
        const entry = parsed[provider];
        if (entry && typeof entry === 'object') {
          windowsByProvider.set(provider, {
            fiveHour: readStoredWindow(entry.fiveHour),
            sevenDay: readStoredWindow(entry.sevenDay),
          });
        }
      }
    } catch {
      // An unreadable snapshot is the same as none: every window shows "no data".
    }
    return windowsByProvider;
  };

  const persist = (windows: Map<LLMProvider, StoredWindows>): void => {
    try {
      dependencies.save(JSON.stringify(Object.fromEntries(windows)));
    } catch (error) {
      // The in-memory reading still serves the screen until the next restart.
      console.warn('[ProviderLimits] Could not persist the limits snapshot', error);
    }
  };

  return {
    /**
     * Records one reading a provider reported. Only the five-hour and weekly
     * windows are kept (Claude's per-model weekly windows and readings that
     * name no window are ignored); a field the reading lacks is stored as
     * null rather than carried over from an older reading, so the screen
     * never shows a number the provider did not send. Returns whether the
     * reading was stored. Used by `server/index.ts` for Claude's live
     * `rate_limit_status` and for Codex's reading after each turn.
     */
    record(provider: LLMProvider, status: RateLimitStatus): boolean {
      if (!LIMIT_TRACKED_PROVIDERS.includes(provider)) {
        return false;
      }
      const field = status.rateLimitType === 'five_hour'
        ? 'fiveHour'
        : status.rateLimitType === 'seven_day' ? 'sevenDay' : null;
      if (!field) {
        return false;
      }
      const windows = ensureLoaded();
      const current = windows.get(provider) ?? { fiveHour: null, sevenDay: null };
      const utilization = typeof status.utilization === 'number' && Number.isFinite(status.utilization)
        ? status.utilization
        : null;
      windows.set(provider, {
        ...current,
        [field]: {
          usedPercent: utilization === null ? null : Math.round(Math.min(1, Math.max(0, utilization)) * 1000) / 10,
          resetsAt: status.resetsAt ?? null,
          status: status.status,
          observedAt: dependencies.now().toISOString(),
        },
      });
      persist(windows);
      return true;
    },

    /**
     * Every tracked provider's last known windows, in a fixed order; a
     * provider or window never reported is null. Used by
     * `GET /api/providers/limits`.
     */
    list(): ProviderLimitsSnapshot[] {
      const windows = ensureLoaded();
      return LIMIT_TRACKED_PROVIDERS.map((provider) => ({
        provider,
        fiveHour: windows.get(provider)?.fiveHour ?? null,
        sevenDay: windows.get(provider)?.sevenDay ?? null,
      }));
    },
  };
}

/**
 * The app's provider limits store, persisted in `app_config`. Written by
 * `server/index.ts` (through the providers barrel) whenever Claude or Codex
 * reports a plan-window reading; read by this module's
 * `GET /api/providers/limits` route for Settings → Agents → Subscription
 * limits.
 */
export const providerLimitsStore = createProviderLimitsStore({
  load: () => appConfigDb.get(APP_CONFIG_KEY),
  save: (json) => appConfigDb.set(APP_CONFIG_KEY, json),
  now: () => new Date(),
});
