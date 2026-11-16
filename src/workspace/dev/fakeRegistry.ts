import { FolderUnavailableError } from '../../files/folderTier';
import type { FileStore, FolderAccess, FolderHandle, ProjectMeta, ProjectRecord, ProjectRegistry } from '../../files/types';
import { MemoryStore } from './memoryStore';
import { sampleProjects } from './sample';

/** A folder on this computer, as a test picks it: its files, and the
 * project it already is (its `.nebula/project.json`), if any. */
export type FakeFolder = FolderHandle & { files?: MemoryStore; projectId?: string };

export function fakeFolder(name: string, files = new MemoryStore()): FakeFolder {
  return { kind: 'directory', name, files };
}

export type FakeRegistry = ProjectRegistry & {
  /** The stores behind each project, for tests that change files "from elsewhere". */
  stores: Map<string, MemoryStore>;
  /** Says what the browser now answers for a folder project's folder. */
  setAccess(id: string, access: FolderAccess): void;
  /** As the browser registry's: true when registry.json came from a newer
   * Nebula, and the project list can't be changed. */
  readonly readOnly: boolean;
};

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

/** A ProjectRegistry in memory, seeded like the sample project (Night Sky)
 * plus four more projects. `projects: 1` is a first visit. */
export function createFakeRegistry(options: { projects?: number; empty?: boolean; latency?: number; readOnly?: boolean } = {}): FakeRegistry {
  const count = options.empty ? 0 : (options.projects ?? 5);
  const records = new Map<string, ProjectRecord>();
  const stores = new Map<string, MemoryStore>();
  const base = Date.parse('2026-10-22T09:00:00.000Z');

  const samples = sampleProjects().slice(0, count);
  samples.forEach((sample, index) => {
    records.set(sample.id, {
      id: sample.id,
      name: sample.name,
      color: sample.color,
      // The sample came first, like a real first visit.
      created: new Date(base - (samples.length - index) * 86_400_000).toISOString(),
      createdBy: 'nebula',
      tier: 'browser',
      lastOpened: new Date(base - index * 60_000).toISOString(),
    });
    const store = new MemoryStore(sample.files);
    store.latency = options.latency ?? 0;
    stores.set(sample.id, store);
  });

  const ordered = () =>
    [...records.values()].sort(
      (a, b) => (b.lastOpened ?? '').localeCompare(a.lastOpened ?? '') || b.created.localeCompare(a.created),
    );

  const need = (id: string): ProjectRecord => {
    const record = records.get(id);
    if (!record) throw new DOMException(`No project ${id}`, 'NotFoundError');
    return record;
  };

  /** What the browser registry throws when it's read-only. */
  const access = new Map<string, FolderAccess>();
  const shown = (record: ProjectRecord): ProjectRecord =>
    record.folder ? { ...record, folder: { ...record.folder, access: access.get(record.id) ?? 'granted' } } : { ...record };

  const refuse = () => {
    if (!options.readOnly) return;
    throw Object.assign(new Error('The project list was written by a newer version of Nebula.'), { name: 'ReadOnlyRegistryError' });
  };

  return {
    stores,
    readOnly: options.readOnly ?? false,
    setAccess(id, state) {
      access.set(id, state);
    },
    async list() {
      return ordered().map(shown);
    },
    async create({ name, color, folder, from }) {
      refuse();
      const picked = folder as FakeFolder | undefined;
      // Move to a folder…: an empty folder takes the project's files.
      if (picked && from !== undefined) {
        const record = need(from);
        const target = picked.files ?? new MemoryStore();
        if ((await target.list()).length > 0) {
          throw Object.assign(new Error(`The folder ‘${picked.name}’ isn’t empty. Choose an empty folder, so nothing in it is mixed up with the project or written over.`), {
            name: 'FolderNotEmptyError',
          });
        }
        const source = stores.get(from)!;
        for (const entry of await source.list()) {
          if (entry.type === 'dir') await target.mkdir(entry.path);
          else await target.write(entry.path, await source.readBlob(entry.path));
        }
        record.tier = 'folder';
        record.folder = { name: picked.name, access: 'granted' };
        stores.set(from, target);
        picked.projectId = from;
        return shown(record);
      }
      // A folder that already is one of these projects is that project.
      if (picked?.projectId && records.has(picked.projectId)) {
        access.set(picked.projectId, 'granted');
        return shown(records.get(picked.projectId)!);
      }
      let id = slug(name);
      for (let n = 2; records.has(id); n += 1) id = `${slug(name)}-${n}`;
      const record: ProjectRecord = {
        id,
        name,
        color,
        created: new Date().toISOString(),
        createdBy: 'nebula',
        tier: picked ? 'folder' : 'browser',
        ...(picked ? { folder: { name: picked.name, access: 'granted' as const } } : {}),
      };
      records.set(id, record);
      const store = picked?.files ?? new MemoryStore();
      store.latency = options.latency ?? 0;
      stores.set(id, store);
      if (picked) picked.projectId = id;
      return shown(record);
    },
    async open(id): Promise<FileStore> {
      const record = need(id);
      const state = access.get(id) ?? 'granted';
      if (record.folder && state !== 'granted') throw new FolderUnavailableError(record.folder.name, state);
      record.lastOpened = new Date(Math.max(Date.now(), Date.parse(ordered()[0]?.lastOpened ?? '0') + 1)).toISOString();
      return stores.get(id)!;
    },
    async update(id, patch: Partial<Pick<ProjectMeta, 'name' | 'color'>>) {
      refuse();
      const record = need(id);
      if (patch.name !== undefined) record.name = patch.name;
      if (patch.color !== undefined) record.color = patch.color;
      return shown(record);
    },
    async remove(id) {
      refuse();
      need(id);
      records.delete(id);
      stores.delete(id);
    },
    async current() {
      return ordered()[0]?.id ?? null;
    },
  };
}
