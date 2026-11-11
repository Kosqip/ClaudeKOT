import type { IProviderMcp } from '@/shared/interfaces.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * MCP adapter for OpenRouter.
 *
 * OpenRouter is a stateless chat-completions HTTP endpoint with no MCP
 * support of its own, so every operation here is a no-op; the MCP settings
 * UI simply shows no servers for this provider.
 */
export class OpenRouterMcpProvider implements IProviderMcp {
  async listServers(): Promise<Record<McpScope, ProviderMcpServer[]>> {
    return { user: [], local: [], project: [] };
  }

  async listServersForScope(): Promise<ProviderMcpServer[]> {
    return [];
  }

  async upsertServer(): Promise<ProviderMcpServer> {
    throw new AppError('OpenRouter does not support MCP servers.', {
      code: 'MCP_UNSUPPORTED',
      statusCode: 400,
    });
  }

  async removeServer(
    input: { name: string; scope?: McpScope },
  ): Promise<{ removed: boolean; provider: 'openrouter'; name: string; scope: McpScope }> {
    return { removed: false, provider: 'openrouter', name: input.name, scope: input.scope ?? 'user' };
  }
}
