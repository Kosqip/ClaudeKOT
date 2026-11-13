import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';

import { api } from '@/shared/api';
import { Button } from '@/shared/ui';

type KeyStatus = { service: 'openrouter' | 'anthropic' | 'openai'; envVarName: string; source: 'ui' | 'env' | 'none' };

const SERVICES: Array<{ service: KeyStatus['service']; placeholder: string }> = [
  { service: 'openrouter', placeholder: 'sk-or-...' },
  { service: 'anthropic', placeholder: 'sk-ant-...' },
  { service: 'openai', placeholder: 'sk-...' },
];

async function readKeys(response: Response): Promise<KeyStatus[]> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message ?? 'request failed');
  }
  return (body?.data?.keys ?? []) as KeyStatus[];
}

/**
 * One service's key row: shows where its key currently comes from
 * (Settings / .env / nothing) and a field to set or clear it from here,
 * without ever displaying the key itself back.
 */
function KeyRow({
  status,
  onSaved,
}: {
  status: KeyStatus;
  onSaved: (keys: KeyStatus[]) => void;
}) {
  const { t } = useTranslation('settings');
  // The field always starts empty: the server never sends a saved key back, so there is nothing to prefill.
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<'idle' | 'saved' | 'cleared' | 'failed'>('idle');

  const save = async (nextValue: string) => {
    setBusy(true);
    setFeedback('idle');
    try {
      const keys = await readKeys(await api.providers.setOpenRouterKey(status.service, nextValue));
      setValue('');
      setFeedback(nextValue ? 'saved' : 'cleared');
      onSaved(keys);
    } catch {
      setFeedback('failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-foreground">{t(`agents.login.apiKeys.${status.service}Label`)}</div>
          <div className="text-xs text-muted-foreground">
            {status.source === 'ui' && t('agents.login.apiKeys.sourceUi')}
            {status.source === 'env' && t('agents.login.apiKeys.sourceEnv', { variable: status.envVarName })}
            {status.source === 'none' && t('agents.login.apiKeys.sourceNone')}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type={reveal ? 'text' : 'password'}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={SERVICES.find((entry) => entry.service === status.service)?.placeholder}
            autoComplete="off"
            className="w-full rounded-md border border-input bg-background py-1.5 pl-2 pr-8 text-sm"
          />
          <button
            type="button"
            onClick={() => setReveal((current) => !current)}
            aria-label={reveal ? t('agents.login.apiKeys.hide') : t('agents.login.apiKeys.show')}
            className="absolute inset-y-0 right-2 flex items-center text-muted-foreground"
          >
            {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        <Button size="sm" disabled={busy || !value.trim()} onClick={() => void save(value)}>
          {t('agents.login.apiKeys.save')}
        </Button>
        {status.source === 'ui' && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void save('')}>
            {t('agents.login.apiKeys.clear')}
          </Button>
        )}
      </div>
      {feedback === 'saved' && <p className="text-xs text-emerald-600 dark:text-emerald-400">{t('agents.login.apiKeys.savedNotice')}</p>}
      {feedback === 'cleared' && <p className="text-xs text-muted-foreground">{t('agents.login.apiKeys.clearedNotice')}</p>}
      {feedback === 'failed' && <p className="text-xs text-destructive">{t('agents.login.apiKeys.failedNotice')}</p>}
    </div>
  );
}

/**
 * Lets the user set each Custom API service's key directly in Settings
 * instead of editing the server's `.env` file by hand. Rendered by
 * `AccountContent` for the `openrouter` agent in place of the "Log in"
 * block every CLI provider gets (Custom API has no browser login).
 */
export default function CustomApiKeysForm({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation('settings');
  const [keys, setKeys] = useState<KeyStatus[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.providers.openRouterKeys().then(readKeys).then(
      (loaded) => {
        if (!cancelled) {
          setKeys(loaded);
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
  }, []);

  const handleSaved = (nextKeys: KeyStatus[]) => {
    setKeys(nextKeys);
    onChanged();
  };

  return (
    <div className="border-t border-border/50 pt-4">
      <div className="mb-1 font-medium text-foreground">{t('agents.login.apiKeys.title')}</div>
      <p className="mb-3 text-sm text-muted-foreground">{t('agents.login.apiKeys.description')}</p>
      {loadFailed && <p className="text-sm text-destructive">{t('agents.login.apiKeys.loadFailed')}</p>}
      {keys && (
        <div className="flex flex-col gap-2">
          {keys.map((status) => (
            <KeyRow key={status.service} status={status} onSaved={handleSaved} />
          ))}
        </div>
      )}
    </div>
  );
}
