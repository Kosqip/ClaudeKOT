import os from 'node:os';

import { userPreferencesDb } from '@/modules/database/index.js';
import { getProviderLimitedUntil } from '@/modules/handoff/index.js';
import { listRecentOrchestratorRuns } from '@/modules/orchestrator/index.js';
import { listCustomApiKeyStatus, providerAuthService } from '@/modules/providers/index.js';
import type { LLMProvider } from '@/shared/types.js';

/** How many recent console lines are kept for the report. */
const MAX_LOG_LINES = 400;
/** Longest single kept line; a dumped object can run to megabytes. */
const MAX_LOG_LINE_CHARS = 2000;

const PROVIDERS: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode', 'openrouter'];
/** Keys read straight from the environment (not through Custom API's own key store); the report says only whether each is set. */
const KEY_VARIABLES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
/** Preferences worth seeing when something misbehaves; none of them holds a secret. */
const REPORTED_PREFERENCES = ['providerRoles', 'handoffFallbackOrder', 'handoffThresholdPercent', 'openRouterProviderSort'];

const logLines: string[] = [];
let captureInstalled = false;

/**
 * Removes what must not leave the machine from a piece of report text: API
 * keys and tokens in their usual shapes, anything following a
 * key/token/password label, e-mail addresses, and the user's home folder
 * (which carries their account name). Deliberately over-eager — a report
 * with a harmless word blanked is fine, one with a key in it is not.
 */
export function redactSecrets(text: string): string {
  const home = os.homedir();
  return (home.length > 1 ? text.split(home).join('~') : text)
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[a-z])[-_][A-Za-z0-9_-]{8,}/g, '[key removed]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [key removed]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[token removed]')
    .replace(/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, '$1[removed]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email removed]');
}

function renderLogArgument(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Starts keeping the last `MAX_LOG_LINES` console lines in memory, so a
 * report can show what the server said before a problem. The console keeps
 * working as before; nothing is written to disk. Called once by
 * `server/index.ts` at startup.
 */
export function installDiagnosticsLogCapture(): void {
  if (captureInstalled) {
    return;
  }
  captureInstalled = true;
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]) => {
      try {
        // eslint-disable-next-line no-control-regex
        const line = values.map(renderLogArgument).join(' ').replace(/\u001b\[[0-9;]*m/g, '').slice(0, MAX_LOG_LINE_CHARS);
        if (line.trim()) {
          logLines.push(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${line}`);
          if (logLines.length > MAX_LOG_LINES) {
            logLines.splice(0, logLines.length - MAX_LOG_LINES);
          }
        }
      } catch {
        // Keeping a copy must never break the logging itself.
      }
      original(...values);
    };
  }
}

async function describeProvider(provider: LLMProvider): Promise<string> {
  const limitedUntil = getProviderLimitedUntil(provider);
  const limit = limitedUntil === null ? 'no limit recorded' : `at its usage limit until ${new Date(limitedUntil).toISOString()}`;
  try {
    const status = await providerAuthService.getProviderAuthStatus(provider);
    return [
      `${provider}: ${status.installed ? 'installed' : 'NOT installed'}`,
      status.installedVersion ? `version ${status.installedVersion}` : null,
      status.authenticated ? `signed in${status.method ? ` (${status.method})` : ''}` : 'NOT signed in',
      limit,
      status.error ? `error: ${status.error}` : null,
    ].filter(Boolean).join(', ');
  } catch (error) {
    return `${provider}: status check failed — ${error instanceof Error ? error.message : String(error)}, ${limit}`;
  }
}

/**
 * Builds the plain-text report a user sends when something goes wrong and
 * nobody else can look at their machine: versions, which backends are
 * installed/signed in/at their limit, the settings that steer roles and
 * handoff, the latest orchestrated tasks step by step, and the server's
 * recent console lines. Contains no keys, tokens, e-mail addresses or
 * conversation text — only whether keys are set — and is passed through
 * `redactSecrets` as a whole before it is returned.
 *
 * Consumed by `diagnostics.routes.ts`.
 */
export async function buildDiagnosticsReport(input: { userId: number; appVersion: string | null; installMode: string }): Promise<string> {
  const preferences = userPreferencesDb.getPreferences(input.userId);
  const providers = await Promise.all(PROVIDERS.map(describeProvider));
  const runs = listRecentOrchestratorRuns(5);

  const sections = [
    '=== ClaudeKOT diagnostics report ===',
    `Generated: ${new Date().toISOString()}`,
    `App version: ${input.appVersion ?? 'unknown'} (${input.installMode} install)`,
    `Node: ${process.version}`,
    `System: ${os.type()} ${os.release()} (${process.platform}, ${process.arch})`,
    `Server running for: ${Math.round(process.uptime() / 60)} min`,
    '',
    '--- Backends ---',
    ...providers,
    '',
    '--- Custom API keys (set or not; values are never included) ---',
    ...listCustomApiKeyStatus().map(({ envVarName, source }) =>
      `${envVarName}: ${source === 'none' ? 'not set' : source === 'ui' ? 'set in Settings' : 'set in .env'}`),
    '',
    '--- Other keys (set or not; values are never included) ---',
    ...KEY_VARIABLES.map((name) => `${name}: ${process.env[name] ? 'set' : 'not set'}`),
    '',
    '--- Settings ---',
    ...REPORTED_PREFERENCES.map((key) => `${key}: ${preferences[key] === undefined ? '(default)' : JSON.stringify(preferences[key])}`),
    '',
    `--- Orchestrated tasks (latest ${runs.length}) ---`,
    ...(runs.length === 0 ? ['none'] : runs.flatMap((run) => [
      `Task ${run.id.slice(0, 8)}: ${run.phase}, round ${run.round} of ${run.maxRounds}, coordinated by ${run.coordinatorProvider ?? '?'}`
        + (run.pauseReason ? `, paused (${run.pauseReason}${run.resumeAt ? `, until ${run.resumeAt}` : ''})` : ''),
      ...(run.error ? [`  error: ${run.error.slice(0, 600)}`] : []),
      ...run.subtasks.map((subtask) =>
        `  round ${subtask.round} · ${subtask.role}/${subtask.access} · ${subtask.provider ?? 'no backend'} · ${subtask.status}`
        + (subtask.movedFrom?.length ? ` · moved from ${subtask.movedFrom.join(', ')}` : '')
        + (subtask.error ? ` · ${subtask.error.slice(0, 300)}` : '')),
    ])),
    '',
    `--- Server log (last ${logLines.length} lines) ---`,
    ...(logLines.length === 0 ? ['(empty)'] : logLines),
  ];
  return redactSecrets(sections.join('\n'));
}
