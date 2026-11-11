import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

/**
 * Session synchronizer for OpenRouter.
 *
 * Other providers scan provider-native transcript files on disk (written by
 * an external CLI) to discover sessions the app has never seen. OpenRouter
 * has no external process: every session and transcript row is created by
 * this app's own runtime adapter and written straight into the app's
 * session/history store, so there is nothing left for a scan to discover.
 */
export class OpenRouterSessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(): Promise<number> {
    return 0;
  }

  async synchronizeFile(): Promise<string | null> {
    return null;
  }
}
