/**
 * The server tier's projects beside the browser's. When
 * the app is served by a Nebula server (cli/nebula-files.mjs), the projects
 * it serves are listed with this browser's own, open as HttpFileStores, and
 * take their name and colour from their `.nebula/project.json` there.
 *
 * This browser keeps only when it last opened each one (localStorage,
 * `nebula:server:opened`, or `nebula:server:opened:<scope>` when the server's
 * place names a scope, so one account's recent projects don't show for
 * another on a shared computer), so the list and the startup project follow
 * what was opened last, wherever it lives. A server project can't be removed
 * from here when its folder is on the server: the server lists it while it's
 * there. Where the server removes projects itself (the database backend), Remove
 * asks it to, and the project can be restored until the server purges it.
 *
 * Where the host offers only its server (the Suite), serverOnlyRegistry is
 * the whole registry: nothing of this browser's is listed, and New project
 * makes the project on the server.
 */
import type { BrowserRegistry, CreateProjectInput } from './registry';
import { HttpFileStore, SERVER_API, ServerError, ServerUnreachableError, fetchServerInfo, type ServerInfo, type ServerProject } from './serverStore';
import { FileNotFoundError } from './errors';
import type { FileStore, ProjectMeta, ProjectRecord } from './types';
import type { RemovedProject } from './serverContract';

export const SERVER_OPENED_KEY = 'nebula:server:opened';

/** The key this device notes server projects under: the scope's own when the place names one. */
export function serverOpenedKey(scope?: string): string {
  return scope ? `${SERVER_OPENED_KEY}:${scope}` : SERVER_OPENED_KEY;
}

/** Removing a server project from Nebula: it lives on the server. */
export class ServerProjectError extends Error {
  constructor(project: string, label: string) {
    super(`${project} lives on ${label}. To remove it, remove its folder there.`);
    this.name = 'ServerProjectError';
  }
}

export type ServerConnection = {
  /** What the server said last. */
  readonly info: ServerInfo;
  /** Asks again; keeps the last answer when the server can't be reached. */
  refresh(): Promise<ServerInfo>;
  /** One store per project, shared, so a project has one change feed. */
  store(id: string): Promise<FileStore>;
  /** Makes a project on the server (`POST <api>/projects`), where it makes
   * projects; a refusal says why in words (ServerError's message). */
  create(input: { name: string; color?: string }): Promise<ServerProject>;
  /** Removes a project, where the server can (`capabilities.removeProject`): it leaves the list and
   * can be restored until its `purgeAfter`. */
  remove(id: string): Promise<RemovedProject>;
  /** The projects removed and still restorable. */
  removed(): Promise<RemovedProject[]>;
  /** Brings a removed project back into the list. */
  restore(id: string): Promise<ServerProject>;
};

/** Where the API is, as a connection or a caller names it. */
export type ServerCall = { base?: string; api?: string; fetch?: typeof fetch };

/** One call to the API's own routes (not a project's file routes): the answer's body, or the error
 * the server's words make. 5xx that isn't a full space says the server can't be reached. */
async function call<T>(label: string, method: 'GET' | 'POST' | 'DELETE', route: string, options: ServerCall): Promise<T> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${options.base ?? ''}${options.api ?? SERVER_API}${route}`, { method, headers: { accept: 'application/json' }, cache: 'no-store' });
  } catch (error) {
    throw new ServerUnreachableError(label, error);
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!response.ok) {
    if (response.status >= 500 && response.status !== 507) throw new ServerUnreachableError(label);
    throw new ServerError(response.status, body.error ?? 'unknown', body.message ?? `${label} answered ${response.status}`);
  }
  return body;
}

/** `DELETE <api>/projects/<id>` (contract §2): the project is removed, and restorable until `purgeAfter`. */
export async function removeServerProject(id: string, label: string, options: ServerCall = {}): Promise<RemovedProject> {
  return (await call<{ removed: RemovedProject }>(label, 'DELETE', `/projects/${encodeURIComponent(id)}`, options)).removed;
}

/** `GET <api>/removed-projects`: what was removed and can still be restored. */
export async function removedServerProjects(label: string, options: ServerCall = {}): Promise<RemovedProject[]> {
  return (await call<{ projects: RemovedProject[] }>(label, 'GET', '/removed-projects', options)).projects;
}

/** `POST <api>/removed-projects/<id>/restore`: one already purged answers 404 `no-project`. */
export async function restoreServerProject(id: string, label: string, options: ServerCall = {}): Promise<ServerProject> {
  return (await call<{ project: ServerProject }>(label, 'POST', `/removed-projects/${encodeURIComponent(id)}/restore`, options)).project;
}

export function connectServer(first: ServerInfo, options: { base?: string; api?: string; fetch?: typeof fetch; graceMs?: number } = {}): ServerConnection {
  let info = first;
  const stores = new Map<string, Promise<HttpFileStore>>();
  return {
    get info() {
      return info;
    },
    async refresh() {
      const next = await fetchServerInfo(options);
      if (next) info = next;
      return info;
    },
    store(id) {
      let store = stores.get(id);
      if (!store) {
        store = HttpFileStore.open({ projectId: id, label: info.place.label, base: options.base, api: options.api, fetch: options.fetch, graceMs: options.graceMs });
        stores.set(id, store);
        store.catch(() => stores.delete(id));
      }
      return store;
    },
    async create(input) {
      const label = info.place.label;
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)(`${options.base ?? ''}${options.api ?? SERVER_API}/projects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ name: input.name, ...(input.color ? { color: input.color } : {}) }),
          cache: 'no-store',
        });
      } catch (error) {
        throw new ServerUnreachableError(label, error);
      }
      const body = (await response.json().catch(() => ({}))) as { project?: ServerProject; error?: string; message?: string };
      if (!response.ok || !body.project) {
        if (response.status >= 500 && response.status !== 507) throw new ServerUnreachableError(label);
        throw new ServerError(response.status, body.error ?? 'unknown', body.message ?? `${label} answered ${response.status}`);
      }
      const next = await fetchServerInfo(options);
      if (next) info = next;
      return body.project;
    },
    async remove(id) {
      const removed = await removeServerProject(id, info.place.label, options);
      // Its live feed ended on the server; a store opened again would be a new project's.
      stores.delete(id);
      info = { ...info, projects: info.projects.filter((project) => project.id !== id) };
      const next = await fetchServerInfo(options);
      if (next) info = next;
      return removed;
    },
    removed: () => removedServerProjects(info.place.label, options),
    async restore(id) {
      const project = await restoreServerProject(id, info.place.label, options);
      const next = await fetchServerInfo(options);
      if (next) info = next;
      return project;
    },
  };
}

type Opened = Record<string, string>;

function readOpened(storage: Storage | null, key: string): Opened {
  try {
    const value: unknown = JSON.parse(storage?.getItem(key) ?? '{}');
    return value && typeof value === 'object' ? (value as Opened) : {};
  } catch {
    return {};
  }
}

function recordOf(project: ServerProject, label: string, opened: Opened): ProjectRecord {
  const record: ProjectRecord = {
    id: project.id,
    name: project.name,
    color: project.color,
    created: project.created,
    createdBy: project.createdBy,
    tier: 'server',
    // '' when the server keeps no folders (a database): the workspace then names the server alone.
    server: { label, folder: project.folder ?? '' },
  };
  if (opened[project.id]) record.lastOpened = opened[project.id];
  return record;
}

/** Most recently opened first; never opened after, in the order given. */
function byOpened(a: ProjectRecord, b: ProjectRecord): number {
  return (b.lastOpened ?? '').localeCompare(a.lastOpened ?? '');
}

export function withServerProjects(inner: BrowserRegistry, server: ServerConnection, storage: Storage | null, now: () => Date = () => new Date()): BrowserRegistry {
  // Which ids are this browser's own. One rule, the same before the first
  // list() and after it: an id that a browser project holds is the browser's,
  // and a server project that shares it (a zip-moved copy) stays out of the
  // list and out of reach until one of them is renamed or removed, rather
  // than opening one and hiding the other. Loaded on first use, and replaced
  // by each list(); a load that fails is tried again, never remembered.
  let owned: Promise<Set<string>> | null = null;
  const idsOf = (records: ProjectRecord[]) => new Set(records.map((record) => record.id));
  const ownIds = () => {
    if (!owned) {
      owned = inner.list().then(idsOf);
      owned.catch(() => {
        owned = null;
      });
    }
    return owned;
  };
  const isServer = async (id: string) => server.info.projects.some((project) => project.id === id) && !(await ownIds()).has(id);
  const side = serverSide(server, storage, now);
  const records = (info: ServerInfo, ownIds: Set<string>) => {
    const times = side.times();
    return info.projects.filter((project) => !ownIds.has(project.id)).map((project) => recordOf(project, info.place.label, times));
  };

  const registry: BrowserRegistry = {
    get tree() {
      return inner.tree;
    },
    get readOnly() {
      return inner.readOnly;
    },
    async list() {
      const [mine, info] = await Promise.all([inner.list(), server.refresh()]);
      const ownNow = idsOf(mine);
      owned = Promise.resolve(ownNow);
      return [...mine, ...records(info, ownNow)].sort(byOpened);
    },
    async current() {
      const [mine, own] = await Promise.all([inner.current(), ownIds()]);
      const times = side.times();
      const latest = server.info.projects
        .filter((project) => times[project.id] && !own.has(project.id))
        .sort((a, b) => times[b.id].localeCompare(times[a.id]))[0];
      if (!latest) return mine;
      if (!mine) return latest.id;
      const record = (await inner.list()).find((item) => item.id === mine);
      return (record?.lastOpened ?? '') >= times[latest.id] ? mine : latest.id;
    },
    async create(input: CreateProjectInput) {
      if (input.where === 'server') return side.create(input);
      const created = await inner.create(input);
      owned = null;
      return created;
    },
    async open(id) {
      return (await isServer(id)) ? side.open(id) : inner.open(id);
    },
    async files(id) {
      return (await isServer(id)) ? server.store(id) : inner.files(id);
    },
    async update(id, patch) {
      return (await isServer(id)) ? side.update(id, patch) : inner.update(id, patch);
    },
    async remove(id) {
      if (!(await isServer(id))) {
        await inner.remove(id);
        owned = null;
        return;
      }
      await side.remove(id);
    },
  };
  return registry;
}

/** What both registries do with a server's projects: when each was last
 * opened here (under the place's scope), opening, renaming and recolouring
 * through project.json, making one, and removing one where the server can (else refusing). */
function serverSide(server: ServerConnection, storage: Storage | null, now: () => Date) {
  const key = () => serverOpenedKey(server.info.scope);
  const times = () => readOpened(storage, key());
  return {
    times,
    async open(id: string): Promise<FileStore> {
      const store = await server.store(id);
      const all = times();
      all[id] = now().toISOString();
      try {
        storage?.setItem(key(), JSON.stringify(all));
      } catch {
        // A browser that keeps nothing: the order is this tab's.
      }
      return store;
    },
    async update(id: string, patch: Partial<Pick<ProjectMeta, 'name' | 'color'>>): Promise<ProjectRecord> {
      const store = await server.store(id);
      const text = await store.readText('.nebula/project.json');
      const meta = { ...(JSON.parse(text) as ProjectMeta) };
      if (patch.name !== undefined) meta.name = patch.name.trim() || meta.name;
      if (patch.color !== undefined) meta.color = patch.color.toLowerCase();
      await store.write('.nebula/project.json', `${JSON.stringify(meta, null, 2)}\n`, { ifUnchanged: { text } });
      const info = await server.refresh();
      const project = info.projects.find((item) => item.id === id);
      if (!project) throw new ServerProjectError(meta.name, info.place.label);
      return recordOf(project, info.place.label, times());
    },
    async create(input: CreateProjectInput): Promise<ProjectRecord> {
      const made = await server.create({ name: input.name, color: input.color });
      return recordOf(made, server.info.place.label, times());
    },
    /** The server removes it where it can (the database backend, restorable for a while); where it
     * can't, its folder is on the server, which lists it while it's there. */
    async remove(id: string): Promise<void> {
      if (server.info.capabilities?.removeProject === true) {
        await server.remove(id);
        return;
      }
      const project = server.info.projects.find((item) => item.id === id);
      throw new ServerProjectError(project?.name ?? id, server.info.place.label);
    },
  };
}

/** The whole registry when the host offers only its server: its projects,
 * and nothing of this browser's (no OPFS, no tree for device files). */
export function serverOnlyRegistry(server: ServerConnection, storage: Storage | null, now: () => Date = () => new Date()): BrowserRegistry {
  const side = serverSide(server, storage, now);
  const known = async (id: string) => {
    if (!server.info.projects.some((project) => project.id === id)) await server.refresh();
    const project = server.info.projects.find((item) => item.id === id);
    if (!project) throw new FileNotFoundError(`project ${id}`);
    return project;
  };
  return {
    async list() {
      const info = await server.refresh();
      const times = side.times();
      return info.projects.map((project) => recordOf(project, info.place.label, times)).sort(byOpened);
    },
    async current() {
      const times = side.times();
      return server.info.projects.filter((project) => times[project.id]).sort((a, b) => times[b.id].localeCompare(times[a.id]))[0]?.id ?? null;
    },
    create: (input) => side.create(input),
    async open(id) {
      await known(id);
      return side.open(id);
    },
    async files(id) {
      await known(id);
      return server.store(id);
    },
    update: (id, patch) => side.update(id, patch),
    remove: (id) => side.remove(id),
  };
}
