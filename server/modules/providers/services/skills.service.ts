import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  LLMProvider,
  ProviderSkill,
  ProviderSkillCreateInput,
  ProviderSkillListOptions,
  ProviderSkillRemoveInput,
} from '@/shared/types.js';

export const providerSkillsService = {
  /**
   * Lists normalized skills visible to one provider.
   */
  async listProviderSkills(
    providerName: string,
    options?: ProviderSkillListOptions,
  ): Promise<ProviderSkill[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.listSkills(options);
  },

  /**
   * Writes one or more global skills for one provider.
   */
  async addProviderSkills(
    providerName: string,
    input: ProviderSkillCreateInput,
  ): Promise<ProviderSkill[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.addSkills(input);
  },

  async removeProviderSkill(
    providerName: string,
    input: ProviderSkillRemoveInput,
  ): Promise<{ removed: boolean; provider: string; directoryName: string }> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.removeSkill(input);
  },

  /**
   * Writes the same skill entries to every registered provider's own skill
   * folder in one call, mirroring `providerMcpService.addMcpServerToAllProviders`.
   *
   * Closes the gap that MCP already had a "add to all providers" action but
   * skills did not: Codex, Cursor, and OpenCode already converge on reading
   * `.agents/skills`, but Claude Code only reads `.claude/skills` — without
   * this, a skill added for one provider silently would not appear for the
   * others, undoing the "one project, several seamless backends" goal. A
   * provider whose adapter rejects the write (e.g. one with no local skill
   * folder) reports its own error without blocking the others.
   */
  async addSkillToAllProviders(
    input: ProviderSkillCreateInput,
  ): Promise<Array<{ provider: LLMProvider; skills?: ProviderSkill[]; error?: string }>> {
    const results: Array<{ provider: LLMProvider; skills?: ProviderSkill[]; error?: string }> = [];
    for (const provider of providerRegistry.listProviders()) {
      try {
        const skills = await provider.skills.addSkills(input);
        results.push({ provider: provider.id, skills });
      } catch (error) {
        results.push({
          provider: provider.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
    return results;
  },
};
