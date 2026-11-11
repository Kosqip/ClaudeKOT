import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { NormalizedMessage } from '@/shared/types.js';
import { sanitizeLeafDirectoryName } from '@/shared/utils.js';

/**
 * On-disk transcript store for the OpenRouter provider.
 *
 * Every other provider adapter reads its session history back from files an
 * external CLI already writes. OpenRouter is a plain HTTP API with no CLI and
 * no transcript of its own, so the runtime adapter (`openrouter-runtime.provider.ts`)
 * writes one line of JSON per turn here itself, and the sessions adapter
 * (`openrouter-sessions.provider.ts`) reads it back for `fetchHistory`. Used
 * only within the openrouter provider module.
 */
const OPENROUTER_HISTORY_ROOT = path.join(os.homedir(), '.cloudcli', 'openrouter-sessions');

function resolveHistoryFilePath(sessionId: string): string {
  const safeSessionId = sanitizeLeafDirectoryName(sessionId, 'openrouter session id');
  return path.join(OPENROUTER_HISTORY_ROOT, `${safeSessionId}.jsonl`);
}

/** Appends one normalized message to a session's on-disk transcript. */
export async function appendOpenRouterHistoryRow(message: NormalizedMessage): Promise<void> {
  await mkdir(OPENROUTER_HISTORY_ROOT, { recursive: true });
  const filePath = resolveHistoryFilePath(message.sessionId);
  await appendFile(filePath, `${JSON.stringify(message)}\n`, 'utf8');
}

/** Reads every normalized message recorded for a session, oldest first. */
export async function readOpenRouterHistory(sessionId: string): Promise<NormalizedMessage[]> {
  const filePath = resolveHistoryFilePath(sessionId);

  try {
    const content = await readFile(filePath, 'utf8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as NormalizedMessage);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
