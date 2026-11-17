/**
 * The server tier at startup: when a Nebula server served
 * this page, its projects join this browser's. A server marks its responses
 * with a Server-Timing entry, which the page reads without a request, so the
 * public site (no server tier) never asks and never loads this tier's code.
 */
import type { BrowserRegistryHandle } from '../files/opfsRegistry';

export function servedByNebulaServer(perf: Pick<Performance, 'getEntriesByType'> | undefined = globalThis.performance): boolean {
  try {
    const [navigation] = (perf?.getEntriesByType('navigation') ?? []) as PerformanceNavigationTiming[];
    return Boolean(navigation?.serverTiming?.some((entry) => entry.name === 'nebula-files'));
  } catch {
    return false;
  }
}

/** The browser's registry, with the server's projects beside its own when there is a server. */
export async function withServerTier(handle: BrowserRegistryHandle, storage: Storage | null): Promise<BrowserRegistryHandle> {
  if (!servedByNebulaServer()) return handle;
  const [{ fetchServerInfo }, { connectServer, withServerProjects }] = await Promise.all([import('../files/serverStore'), import('../files/serverRegistry')]);
  const info = await fetchServerInfo();
  if (!info) return handle;
  return { ...handle, registry: withServerProjects(handle.registry, connectServer(info), storage) };
}
