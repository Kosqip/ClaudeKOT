// HandoffThresholdSetting: the global (not per-provider) control for when
// automatic limit handoff fires, rendered once by AgentsSettingsTab.
export { default as HandoffThresholdSetting } from '@/modules/handoff/HandoffThresholdSetting.js';

// HandoffFallbackOrderSetting: the global control for the order the handoff
// module tries fallback backends in, rendered once by AgentsSettingsTab.
export { default as HandoffFallbackOrderSetting } from '@/modules/handoff/HandoffFallbackOrderSetting.js';

// HandoffSuggestionBanner: the "move this conversation to <fallback>?" offer
// ChatInterface shows when a session's backend is close to its usage limit.
export { default as HandoffSuggestionBanner } from '@/modules/handoff/HandoffSuggestionBanner.js';
