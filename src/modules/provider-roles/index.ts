// ProviderRolesSettings: rendered once by AgentsSettingsTab, below the
// handoff settings — purely declarative today, a future orchestrator's
// configuration surface.
export { default as ProviderRolesSettings } from '@/modules/provider-roles/ProviderRolesSettings.js';

// OpenRouterRoutingSetting: the global control for how OpenRouter chooses
// among the providers hosting one model, rendered once by AgentsSettingsTab.
export { default as OpenRouterRoutingSetting } from '@/modules/provider-roles/OpenRouterRoutingSetting.js';
