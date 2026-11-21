/**
 * Hosting from the page (src/app/serverTier.ts): what `openTiers` makes of the server's place.
 * `fetch` and the page's Server-Timing mark are stubbed; nothing leaves the test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserRegistryHandle } from '../files/opfsRegistry';
import { STANDALONE } from '../files/places';
import { apiBaseOf, openTiers, serverMark } from './serverTier';

const you = { type: 'human' as const, id: 'u-1', name: 'Bruce' };

function mark(description: string | null) {
  const entries = description === null ? [{}] : [{ serverTiming: [{ name: 'nebula-files', description }] }];
  vi.stubGlobal('performance', { getEntriesByType: () => entries });
}

type Place = { homes?: string[]; capabilities?: Record<string, boolean>; you?: typeof you };

/** The API as a stub: its place, and the routes the removed projects use. */
function serve(place: Place | null) {
  const calls: Array<{ method: string; path: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://app.test');
      const path = url.pathname;
      calls.push({ method: init.method ?? 'GET', path });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (path.endsWith('/place')) {
        return place === null
          ? json({ error: 'down' }, 503)
          : json({ place: { tier: 'server', label: 'suite', url: 'http://app.test' }, projects: [], ...place });
      }
      if (path.endsWith('/removed-projects')) return json({ projects: [{ id: 'old', name: 'Old', color: '#fff', removed: 'x', purgeAfter: 'y' }] });
      if (path.endsWith('/removed-projects/old/restore')) return json({ project: { id: 'old', name: 'Old', color: '#fff', created: 'x', createdBy: 'nebula' } });
      return json({ error: 'unexpected' }, 500);
    }),
  );
  return calls;
}

const browser = (): BrowserRegistryHandle => ({ registry: { list: async () => [], tag: 'browser' } as never, persistent: true });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('serverMark and apiBaseOf', () => {
  it('reads the mark, and where the API is from it', () => {
    mark('/nebula-api/v2/');
    expect(serverMark()).toBe('/nebula-api/v2/');
    expect(apiBaseOf('/nebula-api/v2/')).toBe('/nebula-api/v2');
    expect(apiBaseOf('1')).toBe('/nebula-api/v1'); // a 2.0.2 server's mark
    expect(apiBaseOf(null)).toBe('/nebula-api/v1');
    mark(null);
    expect(serverMark()).toBeNull();
  });
});

describe('openTiers', () => {
  it('with no server, the browser’s own and nothing hosted', async () => {
    mark(null);
    const open = vi.fn(async () => browser());
    const tiers = await openTiers(null, open);
    expect(tiers.hosting).toBe(STANDALONE);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('gives hosting.server who you are, the versions, and the removal and removed calls where the place says removeProject', async () => {
    mark('/nebula-api/v1');
    const calls = serve({ you, capabilities: { createProject: true, versions: true, removeProject: true } });
    const { hosting } = await openTiers(null, async () => browser());
    expect(hosting.server).toMatchObject({ label: 'suite', canCreate: true, you, versions: true, canRemove: true });
    expect(typeof hosting.server?.removed?.list).toBe('function');
    calls.length = 0;
    const list = await hosting.server!.removed!.list();
    expect(list.map((project) => project.id)).toEqual(['old']);
    await hosting.server!.removed!.restore('old');
    expect(calls).toEqual([
      { method: 'GET', path: '/nebula-api/v1/removed-projects' },
      { method: 'POST', path: '/nebula-api/v1/removed-projects/old/restore' },
      { method: 'GET', path: '/nebula-api/v1/place' }, // the restore asks the place again
    ]);
  });

  it('with removeProject unset, canRemove and removed are not there, and versions are off unless said', async () => {
    mark('/nebula-api/v1');
    serve({ capabilities: { createProject: true } });
    const { hosting } = await openTiers(null, async () => browser());
    expect(hosting.server).not.toBeNull();
    expect(hosting.server).not.toHaveProperty('canRemove');
    expect(hosting.server).not.toHaveProperty('removed');
    expect(hosting.server?.versions).toBe(false);
    expect(hosting.server?.you).toBeUndefined();
  });

  it('with removeProject set but the server not among the host’s homes, none of them is there', async () => {
    mark('/nebula-api/v1');
    serve({ homes: ['browser', 'folder'], capabilities: { removeProject: true, createProject: true } });
    const { hosting } = await openTiers(null, async () => browser());
    expect(hosting.server?.canCreate).toBe(false);
    expect(hosting.server).not.toHaveProperty('canRemove');
    expect(hosting.server).not.toHaveProperty('removed');
  });

  it('removeProject only counts as exactly true', async () => {
    mark('/nebula-api/v1');
    serve({ capabilities: { removeProject: 'yes' as unknown as boolean } });
    const { hosting } = await openTiers(null, async () => browser());
    expect(hosting.server).not.toHaveProperty('canRemove');
  });

  it('where the host offers only its server, this browser’s storage is never opened', async () => {
    mark('/nebula-api/v1');
    serve({ homes: ['server'], capabilities: { removeProject: true } });
    const open = vi.fn(async () => browser());
    const tiers = await openTiers(null, open);
    expect(open).not.toHaveBeenCalled();
    expect(tiers.handle).toMatchObject({ onlyServer: true, persistent: true });
    expect(tiers.hosting.server).toMatchObject({ canRemove: true });
  });

  it('a server that named its API and doesn’t answer is an error, not a guess; one that only marked itself falls back to the browser', async () => {
    mark('/nebula-api/v1');
    serve(null);
    await expect(openTiers(null, async () => browser())).rejects.toThrow();
    mark('1');
    serve(null);
    const open = vi.fn(async () => browser());
    const tiers = await openTiers(null, open);
    expect(tiers.hosting).toBe(STANDALONE);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
