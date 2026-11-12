import { readFileSync } from 'node:fs';
import path from 'node:path';

import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';
import type { TaskRouterConfig, TaskTag } from '@/shared/types.js';

/**
 * Fixed tag order: the first tag whose keyword list matches wins when no
 * explicit tag was given. Keeping this order out of the config file (rather
 * than inferring it from key order in parsed JSON, which is not guaranteed
 * stable across engines) makes the precedence rule explicit and easy to
 * reason about.
 */
const TAG_PRECEDENCE: TaskTag[] = ['second_opinion', 'complex', 'coding', 'routine'];

/**
 * Falls back to this when `task-router.config.json` is missing or fails to
 * parse, so a corrupted or deleted config degrades to "nothing auto-matches"
 * instead of crashing every classification call.
 */
const EMPTY_CONFIG: TaskRouterConfig = {
  routine: [],
  coding: [],
  second_opinion: [],
  complex: [],
};

/**
 * Absolute path to the user-editable keyword config, resolved the same way
 * `findApplicationRoot` is used elsewhere (`cli.module.ts`,
 * `commands.module.ts`) so it works both from source (tsx) and from the
 * compiled `dist-server` output. Lives at the repo root, not inside this
 * module's own directory, because the build does not copy non-TypeScript
 * files out of `server/` — a path relative to this compiled file's own
 * location would not resolve in a built server.
 */
function getConfigPath(): string {
  return path.join(findApplicationRoot(getModuleDirectory(import.meta.url)), 'task-router.config.json');
}

/**
 * Reads and parses `task-router.config.json` fresh on every call — no
 * caching — so an edit takes effect on the very next classification without
 * needing a server restart, let alone a rebuild. The file is tiny (a few
 * keyword lists), so re-reading it per call costs nothing meaningful.
 *
 * Exported for this module's own tests; `classifyTask` is the only other
 * caller.
 */
export function loadTaskRouterConfig(): TaskRouterConfig {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const config: TaskRouterConfig = { ...EMPTY_CONFIG };
    for (const tag of TAG_PRECEDENCE) {
      const keywords = parsed[tag];
      if (Array.isArray(keywords)) {
        config[tag] = keywords.filter((keyword): keyword is string => typeof keyword === 'string');
      }
    }
    return config;
  } catch {
    return EMPTY_CONFIG;
  }
}

/**
 * Decides which tag a task belongs to: an explicit tag always wins outright
 * (the user's own choice overrides keyword matching entirely); otherwise the
 * task text is checked against each tag's keyword list, case-insensitively,
 * in `TAG_PRECEDENCE` order, and the first match wins. Returns `null` when
 * nothing matches — callers must treat that as "ask the user", never as a
 * silent default, since guessing wrong here would route a task to the wrong
 * backend without anyone noticing.
 *
 * Deliberately simple substring matching, not any model or ML call — see
 * `docs/PROJECT_REQUIREMENTS.md` decision #13 for why.
 *
 * Consumed by `task-router-dispatch.service.ts` and this module's tests.
 */
export function classifyTask(text: string, explicitTag?: TaskTag): TaskTag | null {
  if (explicitTag) {
    return explicitTag;
  }

  const config = loadTaskRouterConfig();
  const normalizedText = text.toLowerCase();
  for (const tag of TAG_PRECEDENCE) {
    const matched = config[tag].some((keyword) => keyword && normalizedText.includes(keyword.toLowerCase()));
    if (matched) {
      return tag;
    }
  }

  return null;
}
