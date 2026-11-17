/**
 * The server tier's projects beside the browser's. When
 * the app is served by a Nebula server (cli/nebula-files.mjs), the projects
 * it serves are listed with this browser's own, open as HttpFileStores, and
 * take their name and colour from their `.nebula/project.json` there.
 *
 * This browser keeps only when it last opened each one (localStorage,
 * `nebula:server:opened`), so the list and the startup project follow what
 * was opened last, wherever it lives. A server project can't be removed from
 * here: its folder is on the server, and the server lists it while it's there.
 */
import type { BrowserRegistry, CreateProjectInput } from './registry';
import { HttpFileStore, fetchServerInfo, type ServerInfo, type ServerProject } from './serverStore';
import type { FileStore, ProjectMeta, ProjectRecord } from './types';

export const SERVER_OPENED_KEY = 'nebula:server:opened';

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
};

export function connectServer(first: ServerInfo, options: { base?: string; fetch?: typeof fetch; graceMs?: number } = {}): ServerConnection {
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
        store = HttpFileStore.open({ projectId: id, label: info.place.label, base: options.base, fetch: options.fetch, graceMs: options.graceMs });
        stores.set(id, store);
        store.catch(() => stores.delete(id));
      }
      return store;
    },
  };
}

type Opened = Record<string, string>;

function readOpened(storage: Storage | null): Opened {
  try {
    const value: unknown = JSON.parse(storage?.getItem(SERVER_OPENED_KEY) ?? '{}');
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
    server: { label, folder: project.folder },
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
  const opened = (id: string) => {
    const all = readOpened(storage);
    all[id] = now().toISOString();
    try {
      storage?.setItem(SERVER_OPENED_KEY, JSON.stringify(all));
    } catch {
      // A browser that keeps nothing: the order is this tab's.
    }
  };
  const records = (info: ServerInfo, ownIds: Set<string>) => {
    const times = readOpened(storage);
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
      const times = readOpened(storage);
      const latest = server.info.projects
        .filter((project) => times[project.id] && !own.has(project.id))
        .sort((a, b) => times[b.id].localeCompare(times[a.id]))[0];
      if (!latest) return mine;
      if (!mine) return latest.id;
      const record = (await inner.list()).find((item) => item.id === mine);
      return (record?.lastOpened ?? '') >= times[latest.id] ? mine : latest.id;
    },
    async create(input: CreateProjectInput) {
      const created = await inner.create(input);
      owned = null;
      return created;
    },
    async open(id) {
      if (!(await isServer(id))) return inner.open(id);
      const store = await server.store(id);
      opened(id);
      return store;
    },
    async files(id) {
      return (await isServer(id)) ? server.store(id) : inner.files(id);
    },
    async update(id, patch) {
      if (!(await isServer(id))) return inner.update(id, patch);
      const store = await server.store(id);
      const text = await store.readText('.nebula/project.json');
      const meta = { ...(JSON.parse(text) as ProjectMeta) };
      if (patch.name !== undefined) meta.name = patch.name.trim() || meta.name;
      if (patch.color !== undefined) meta.color = patch.color.toLowerCase();
      await store.write('.nebula/project.json', `${JSON.stringify(meta, null, 2)}\n`, { ifUnchanged: { text } });
      const info = await server.refresh();
      const project = info.projects.find((item) => item.id === id);
      if (!project) throw new ServerProjectError(meta.name, info.place.label);
      return recordOf(project, info.place.label, readOpened(storage));
    },
    async remove(id) {
      if (!(await isServer(id))) {
        await inner.remove(id);
        owned = null;
        return;
      }
      const project = server.info.projects.find((item) => item.id === id);
      throw new ServerProjectError(project?.name ?? id, server.info.place.label);
    },
  };
  return registry;
}
