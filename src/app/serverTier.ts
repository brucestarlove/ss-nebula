/**
 * The server tier at startup: when a Nebula server served
 * this page, its projects join this browser's. A server marks its responses
 * with a Server-Timing entry, which the page reads without a request, so the
 * public site (no server tier) never asks and never loads this tier's code.
 * The mark's description names where the server's API is.
 */
import type { BrowserRegistryHandle } from '../files/opfsRegistry';
import { ALL_HOMES, STANDALONE, onlyServer, type Hosting } from '../files/places';

/** The API's base when the mark doesn't name one: a 2.0.2 server's mark says
 * "1". The same as serverStore's SERVER_API, kept here so the site's first
 * load doesn't carry the tier's code. */
export const DEFAULT_API = '/nebula-api/v1';

/** The description of the page's `nebula-files` mark ('' when it has none),
 * or null when no Nebula server served the page. */
export function serverMark(perf: Pick<Performance, 'getEntriesByType'> | undefined = globalThis.performance): string | null {
  try {
    const [navigation] = (perf?.getEntriesByType('navigation') ?? []) as PerformanceNavigationTiming[];
    const mark = navigation?.serverTiming?.find((entry) => entry.name === 'nebula-files');
    return mark ? (mark.description ?? '') : null;
  } catch {
    return null;
  }
}

export function servedByNebulaServer(perf: Pick<Performance, 'getEntriesByType'> | undefined = globalThis.performance): boolean {
  return serverMark(perf) !== null;
}

/** Where the API is, from the mark: a description starting with `/` is its
 * base; anything else (`"1"` from a 2.0.2 server, or none) means DEFAULT_API. */
export function apiBaseOf(mark: string | null): string {
  return mark !== null && mark.startsWith('/') ? mark.replace(/\/+$/, '') : DEFAULT_API;
}

/** The browser's registry, with the server's projects beside its own when there is a server. */
export async function withServerTier(handle: BrowserRegistryHandle, storage: Storage | null): Promise<BrowserRegistryHandle> {
  const mark = serverMark();
  if (mark === null) return handle;
  const api = apiBaseOf(mark);
  const [{ fetchServerInfo }, { connectServer, withServerProjects }] = await Promise.all([import('../files/serverStore'), import('../files/serverRegistry')]);
  const info = await fetchServerInfo({ api });
  if (!info) return handle;
  return { ...handle, registry: withServerProjects(handle.registry, connectServer(info, { api }), storage) };
}

export type Tiers = { handle: BrowserRegistryHandle; hosting: Hosting };

/**
 * Every tier the page's host offers, opened. With no server, the browser's
 * (OPFS, or memory). With one, its place says which homes it offers: every
 * one, its projects beside the browser's; or only its own (the Suite), and
 * then the browser's storage is never opened, so nothing of one person's
 * shows for another who signs in on the same computer.
 */
export async function openTiers(storage: Storage | null, openBrowser: () => Promise<BrowserRegistryHandle>): Promise<Tiers> {
  const mark = serverMark();
  if (mark === null) return { handle: await openBrowser(), hosting: STANDALONE };
  const api = apiBaseOf(mark);
  const [{ fetchServerInfo }, { connectServer, serverOnlyRegistry, withServerProjects }] = await Promise.all([import('../files/serverStore'), import('../files/serverRegistry')]);
  const info = await fetchServerInfo({ api });
  if (!info) {
    // A server that names its API's base (2.0.3 on) served this page and doesn't answer: which homes
    // it offers is unknown, so the browser's storage isn't opened on a guess.
    if (mark.startsWith('/')) throw new Error('Nebula can’t reach the server that served this page. Reload to try again.');
    return { handle: await openBrowser(), hosting: STANDALONE };
  }
  const homes = info.homes?.length ? ALL_HOMES.filter((home) => info.homes?.includes(home)) : ALL_HOMES;
  const server = connectServer(info, { api });
  const hosting: Hosting = {
    homes,
    server: {
      label: info.place.label,
      canCreate: info.capabilities?.createProject === true && homes.includes('server'),
      you: info.you,
      versions: info.capabilities?.versions === true,
      deletedFiles: info.capabilities?.versions === true && info.capabilities?.deletedFiles === true,
      ...(info.capabilities?.removeProject === true && homes.includes('server')
        ? { canRemove: true, removed: { list: () => server.removed(), restore: async (id: string) => void (await server.restore(id)) } }
        : {}),
    },
  };
  if (onlyServer(hosting)) return { handle: { registry: serverOnlyRegistry(server, storage), persistent: true, onlyServer: true }, hosting };
  const handle = await openBrowser();
  return { handle: { ...handle, registry: withServerProjects(handle.registry, server, storage) }, hosting };
}
