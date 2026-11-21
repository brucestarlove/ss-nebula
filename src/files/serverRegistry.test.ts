/**
 * The server tier's project calls (remove, list removed, restore) and the registries that use
 * them, against a fake server that answers as the API's contract says. The fake refuses any
 * address but its own.
 */
import { describe, expect, it } from 'vitest';
import { MemoryFileStore } from './memoryStore';
import { createBrowserRegistry } from './registry';
import { connectServer, removedServerProjects, removeServerProject, restoreServerProject, serverOnlyRegistry, ServerProjectError, withServerProjects } from './serverRegistry';
import { ServerError, ServerUnreachableError, type ServerInfo, type ServerProject } from './serverStore';
import type { RemovedProject } from './serverContract';

const ORIGIN = 'http://nebula.test';
const API = '/nebula-api/v1';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const project = (id: string, name = id): ServerProject => ({ id, name, color: '#7c8cff', created: '2026-11-01T00:00:00.000Z', createdBy: 'nebula' });

type Call = { method: string; path: string };

/** A server that keeps its projects and the removed ones, and says what it can do. */
function fakeServer(options: { removeProject?: boolean; projects?: ServerProject[] } = {}) {
  const projects = options.projects ?? [project('night-sky', 'Night Sky'), project('pulse', 'Pulse')];
  const removed: RemovedProject[] = [];
  const calls: Call[] = [];
  let down = false;
  const info = (): ServerInfo => ({
    place: { tier: 'server', label: 'vps', url: ORIGIN },
    projects: [...projects],
    capabilities: { createProject: true, versions: true, ...(options.removeProject === false ? {} : { removeProject: true }) },
  });
  const doFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.origin !== ORIGIN) throw new Error(`the test reached for ${url.origin}`);
    const method = init.method ?? 'GET';
    const path = url.pathname.slice(API.length); // the id's own `/` stays encoded here
    calls.push({ method, path });
    if (down) throw new TypeError('network');
    if (path === '/place') return json(info());
    let match: RegExpExecArray | null;
    if ((match = /^\/projects\/([^/]+)\/state$/.exec(path))) return json({ cursor: 'c0' });
    if (method === 'DELETE' && (match = /^\/projects\/([^/]+)$/.exec(path))) {
      const at = projects.findIndex((item) => item.id === decodeURIComponent(match![1]));
      if (at < 0) return json({ error: 'no-project', message: 'There is no such project' }, 404);
      const [gone] = projects.splice(at, 1);
      const record: RemovedProject = { id: gone.id, name: gone.name, color: gone.color, removed: '2026-11-21T10:00:00.000Z', purgeAfter: '2026-12-05T10:00:00.000Z' };
      removed.push(record);
      return json({ removed: record });
    }
    if (method === 'GET' && path === '/removed-projects') return json({ projects: [...removed] });
    if (method === 'POST' && (match = /^\/removed-projects\/([^/]+)\/restore$/.exec(path))) {
      const at = removed.findIndex((item) => item.id === decodeURIComponent(match![1]));
      if (at < 0) return json({ error: 'no-project', message: 'That project has been deleted for good' }, 404);
      const [back] = removed.splice(at, 1);
      projects.push(project(back.id, back.name));
      return json({ project: projects.at(-1) });
    }
    return json({ error: 'unexpected' }, 500);
  }) as typeof fetch;
  return { projects, removed, calls, fetch: doFetch, setDown: (value: boolean) => void (down = value), info };
}

const options = (server: ReturnType<typeof fakeServer>) => ({ base: ORIGIN, fetch: server.fetch });

describe('removeServerProject, removedServerProjects, restoreServerProject', () => {
  it('DELETE <api>/projects/<id> answers the removed record, with the id URL-encoded', async () => {
    const server = fakeServer({ projects: [project('a b/c', 'Odd one')] });
    const record = await removeServerProject('a b/c', 'vps', options(server));
    expect(record).toMatchObject({ id: 'a b/c', name: 'Odd one' });
    expect(server.calls).toEqual([{ method: 'DELETE', path: `/projects/${encodeURIComponent('a b/c')}` }]);
  });

  it('GET <api>/removed-projects answers the projects', async () => {
    const server = fakeServer();
    await removeServerProject('pulse', 'vps', options(server));
    server.calls.length = 0;
    const list = await removedServerProjects('vps', options(server));
    expect(list.map((item) => item.id)).toEqual(['pulse']);
    expect(server.calls).toEqual([{ method: 'GET', path: '/removed-projects' }]);
  });

  it('POST <api>/removed-projects/<id>/restore answers the project, with the id URL-encoded', async () => {
    const server = fakeServer({ projects: [project('a b/c', 'Odd one')] });
    await removeServerProject('a b/c', 'vps', options(server));
    server.calls.length = 0;
    expect(await restoreServerProject('a b/c', 'vps', options(server))).toMatchObject({ id: 'a b/c', name: 'Odd one' });
    expect(server.calls).toEqual([{ method: 'POST', path: `/removed-projects/${encodeURIComponent('a b/c')}/restore` }]);
  });

  it('uses the api the caller names', async () => {
    const seen: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      seen.push(new URL(String(input)).pathname);
      return json({ projects: [] });
    }) as typeof fetch;
    await removedServerProjects('vps', { base: ORIGIN, api: '/mount/api', fetch: fetcher });
    expect(seen).toEqual(['/mount/api/removed-projects']);
  });

  it('a refusal is a ServerError with the server’s code and words; a purged project is 404 no-project', async () => {
    const server = fakeServer();
    const error = await restoreServerProject('never-was', 'vps', options(server)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({ status: 404, code: 'no-project', message: 'That project has been deleted for good' });
    await expect(removeServerProject('never-was', 'vps', options(server))).rejects.toMatchObject({ name: 'ServerError', code: 'no-project' });
  });

  it('a 5xx is ServerUnreachableError, a fetch that throws is too, and a 507 stays a ServerError', async () => {
    const answer = (status: number, body: unknown) => (async () => json(body, status)) as unknown as typeof fetch;
    await expect(removedServerProjects('vps', { fetch: answer(503, {}) })).rejects.toBeInstanceOf(ServerUnreachableError);
    await expect(removedServerProjects('vps', { fetch: (async () => Promise.reject(new TypeError('network'))) as typeof fetch })).rejects.toBeInstanceOf(ServerUnreachableError);
    await expect(removeServerProject('x', 'vps', { fetch: answer(507, { error: 'space-full' }) })).rejects.toMatchObject({ name: 'ServerError', status: 507, code: 'space-full' });
    await expect(restoreServerProject('x', 'vps', { fetch: answer(400, {}) })).rejects.toMatchObject({ name: 'ServerError', status: 400, code: 'unknown' });
  });
});

describe('a registry over a server that can remove projects', () => {
  async function setup(removeProject = true) {
    const server = fakeServer({ removeProject });
    const info = server.info();
    const connection = connectServer(info, options(server));
    const inner = createBrowserRegistry(new MemoryFileStore());
    const mine = await inner.create({ name: 'My own', color: '#e0a458' });
    return { server, connection, inner, mine, registry: withServerProjects(inner, connection, null) };
  }

  it('remove of a server project calls the server, then the next list() no longer has it', async () => {
    const { server, registry } = await setup();
    expect((await registry.list()).map((record) => record.id)).toContain('pulse');
    await registry.remove('pulse');
    expect(server.calls.filter((call) => call.method === 'DELETE')).toEqual([{ method: 'DELETE', path: '/projects/pulse' }]);
    const after = (await registry.list()).map((record) => record.id);
    expect(after).not.toContain('pulse');
    expect(after).toContain('night-sky');
  });

  it('the connection drops the project at once, even when the server can’t be asked for its place afterwards', async () => {
    const { server, connection } = await setup();
    const real = server.fetch;
    let removed = false;
    const dropped = connectServer(connection.info, {
      base: ORIGIN,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (removed && new URL(String(input)).pathname.endsWith('/place')) return json({ error: 'down' }, 503);
        const response = await real(input, init);
        if (init?.method === 'DELETE') removed = true;
        return response;
      }) as typeof fetch,
    });
    await dropped.remove('pulse');
    expect(dropped.info.projects.map((item) => item.id)).toEqual(['night-sky']);
  });

  it('its cached store is dropped, so a project made again under the id opens afresh', async () => {
    const { server, connection } = await setup();
    await connection.store('pulse');
    await connection.store('pulse');
    expect(server.calls.filter((call) => call.path === '/projects/pulse/state')).toHaveLength(1); // cached: one store
    await connection.remove('pulse');
    await connection.restore('pulse');
    await connection.store('pulse');
    expect(server.calls.filter((call) => call.path === '/projects/pulse/state')).toHaveLength(2);
  });

  it('connect(...).restore(id) puts the project back in info.projects', async () => {
    const { connection } = await setup();
    await connection.remove('pulse');
    expect(connection.info.projects.map((item) => item.id)).not.toContain('pulse');
    expect((await connection.removed()).map((item) => item.id)).toEqual(['pulse']);
    const back = await connection.restore('pulse');
    expect(back.id).toBe('pulse');
    expect(connection.info.projects.map((item) => item.id)).toContain('pulse');
    expect(await connection.removed()).toEqual([]);
  });

  it('where the place doesn’t say removeProject, remove still throws ServerProjectError and asks nothing', async () => {
    const { server, registry } = await setup(false);
    await registry.list();
    server.calls.length = 0;
    await expect(registry.remove('pulse')).rejects.toBeInstanceOf(ServerProjectError);
    expect(server.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect((await registry.list()).map((record) => record.id)).toContain('pulse');
  });

  it('a browser project’s remove is untouched: the server is not asked', async () => {
    const { server, registry, inner, mine } = await setup();
    await registry.list();
    server.calls.length = 0;
    await registry.remove(mine.id);
    expect(server.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect((await inner.list()).map((record) => record.id)).not.toContain(mine.id);
  });

  it('a server that refuses the removal keeps the project in the list', async () => {
    const { server, registry } = await setup();
    await registry.list();
    server.setDown(true);
    await expect(registry.remove('pulse')).rejects.toBeInstanceOf(ServerUnreachableError);
    server.setDown(false);
    expect((await registry.list()).map((record) => record.id)).toContain('pulse');
  });
});

describe('serverOnlyRegistry', () => {
  it('removes through the server where it can, and the list follows', async () => {
    const server = fakeServer();
    const registry = serverOnlyRegistry(connectServer(server.info(), options(server)), null);
    await registry.remove('pulse');
    expect(server.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/projects/pulse']);
    expect((await registry.list()).map((record) => record.id)).toEqual(['night-sky']);
  });

  it('where it can’t, remove throws ServerProjectError and asks nothing', async () => {
    const server = fakeServer({ removeProject: false });
    const registry = serverOnlyRegistry(connectServer(server.info(), options(server)), null);
    await expect(registry.remove('pulse')).rejects.toBeInstanceOf(ServerProjectError);
    expect(server.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });
});
