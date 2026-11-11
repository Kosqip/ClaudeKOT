import type { IProviderSkills } from '@/shared/interfaces.js';
import type { ProviderSkill } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Skills adapter for OpenRouter.
 *
 * OpenRouter has no local CLI and no skill markdown directory of its own, so
 * there is nothing to list or install; the skills panel simply shows none.
 */
export class OpenRouterSkillsProvider implements IProviderSkills {
  async listSkills(): Promise<ProviderSkill[]> {
    return [];
  }

  async addSkills(): Promise<ProviderSkill[]> {
    throw new AppError('OpenRouter does not support skills.', {
      code: 'SKILLS_UNSUPPORTED',
      statusCode: 400,
    });
  }

  async removeSkill(
    input: { directoryName: string },
  ): Promise<{ removed: boolean; provider: 'openrouter'; directoryName: string }> {
    return { removed: false, provider: 'openrouter', directoryName: input.directoryName };
  }
}
