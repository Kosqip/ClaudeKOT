import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { OpenRouterMcpProvider } from '@/modules/providers/list/openrouter/openrouter-mcp.provider.js';
import { OpenRouterProviderAuth } from '@/modules/providers/list/openrouter/openrouter-auth.provider.js';
import { openRouterProviderModels } from '@/modules/providers/list/openrouter/openrouter-models.provider.js';
import { openRouterRuntime } from '@/modules/providers/list/openrouter/openrouter-runtime.provider.js';
import { OpenRouterSessionSynchronizer } from '@/modules/providers/list/openrouter/openrouter-session-synchronizer.provider.js';
import { OpenRouterSessionsProvider } from '@/modules/providers/list/openrouter/openrouter-sessions.provider.js';
import { OpenRouterSkillsProvider } from '@/modules/providers/list/openrouter/openrouter-skills.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

/**
 * OpenRouter provider: a plain HTTP chat-completions backend (no local CLI),
 * registered in `provider.registry.ts` alongside the CLI-backed providers.
 */
export class OpenRouterProvider extends AbstractProvider {
  readonly runtime: IProviderRuntime = openRouterRuntime;
  readonly models: IProviderModels = openRouterProviderModels;
  readonly mcp = new OpenRouterMcpProvider();
  readonly auth: IProviderAuth = new OpenRouterProviderAuth();
  readonly skills: IProviderSkills = new OpenRouterSkillsProvider();
  readonly sessions: IProviderSessions = new OpenRouterSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new OpenRouterSessionSynchronizer();

  constructor() {
    super('openrouter');
  }
}
