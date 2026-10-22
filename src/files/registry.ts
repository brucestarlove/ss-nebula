/**
 * The browser tier's registry (docs/slice-3.md, decision 2): a JSON file in
 * the same tree as the projects, so one FileStore implementation reads it all
 * and the memory store tests it.
 *
 *   registry.json                 { version: 1, projects: [{ id, dir, tier, lastOpened }], current }
 *   projects/<dir>/               one project's files
 *   projects/<dir>/.nebula/project.json   its ProjectMeta: the source of truth for name and colour
 *
 * In OPFS the tree is `nebula/` under the origin's root (see opfsRegistry.ts).
 */
import { DEFAULT_PLANET_COLOUR } from './palette';
import { FileExistsError, FileNotFoundError, errorName } from './errors';
import { webLocks, type LockManagerLike } from './locks';
import { scopedStore } from './scopedStore';
import type { FileStore, ProjectMeta, ProjectRecord, ProjectRegistry } from './types';

export type CreateProjectInput = {
  name: string;
  color: string;
  /** Keep this id instead of making one: migrated boards keep theirs. */
  id?: string;
};

export interface BrowserRegistry extends ProjectRegistry {
  create(input: CreateProjectInput): Promise<ProjectRecord>;
  /** The project's files, without recording it as opened: migration, the
   * sample, and downloading a project that isn't the current one. */
  files(id: string): Promise<FileStore>;
  /** The browser tier's own tree: registry.json, projects/, and the
   * migration's record (migration.json). For the migration; reach a
   * project's files through open() and files(). Optional, so a registry
   * wrapped by the app (src/app/keepOnEdit.ts) still type-checks. */
  readonly tree?: FileStore;
  /** True once registry.json turns out to be from a newer Nebula: this tab
   * then lists and opens projects but changes nothing in the registry. */
  readonly readOnly?: boolean;
}

export type BrowserRegistryOptions = {
  /** The store for one project's folder, `projects/<dir>` of `root`. Defaults
   * to a scoped view of `root`; OPFS gives each project a store of its own. */
  projectStore?: (dir: string, id: string) => FileStore | Promise<FileStore>;
  now?: () => Date;
  /** Web Locks name that serialises registry changes across tabs. */
  lockName?: string;
  /** Web Locks (navigator.locks) unless given; null queues in this page only. */
  locks?: LockManagerLike | null;
  /** The folder names under `projects/`, for finding projects registry.json
   * lacks. Defaults to reading them from root.list(); OPFS reads the one
   * folder instead of the whole tree. */
  projectDirs?: () => Promise<string[]>;
};

export class InvalidProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProjectError';
  }
}

export class ReadOnlyRegistryError extends Error {
  constructor(version: number) {
    super(`registry.json was written by a newer version of Nebula (version ${version}), so this tab only reads it. Reload to use the newer version.`);
    this.name = 'ReadOnlyRegistryError';
  }
}

type RegistryEntry = { id: string; dir: string; tier: 'browser'; lastOpened?: string };

/** registry.json as read. Each of its `projects` keeps its own JSON, with
 * the entry it is to this build: null for one this build doesn't understand
 * (another tier's, a newer shape), which writes carry through verbatim, as
 * they do every field this build doesn't know (review finding 12). */
type RegistryFile = {
  version: number;
  raw: Record<string, unknown>;
  items: Array<{ raw: unknown; entry: RegistryEntry | null }>;
  /** As written, even when it names a project of another tier. */
  current: string | null;
};

type ReadResult = { kind: 'file'; file: RegistryFile } | { kind: 'none' } | { kind: 'damaged'; text: string };

/** A project folder registry.json doesn't name, found by reconciling. */
type FoundFolder = { dir: string; id: string | null; created: string };

const REGISTRY = 'registry.json';
const REGISTRY_VERSION = 1;
const PROJECTS = 'projects';
const META = '.nebula/project.json';
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const COLOUR_PATTERN = /^#[0-9a-f]{6}$/i;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A short random id: ten characters of [a-z0-9], about 51 bits. */
export function newProjectId(): string {
  const id: string[] = [];
  while (id.length < 10) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // 252 is the largest multiple of 36 under 256: no bias.
    for (const byte of bytes) if (byte < 252 && id.length < 10) id.push(ID_ALPHABET[byte % 36]);
  }
  return id.join('');
}

export function isValidProjectId(id: string): boolean {
  return ID_PATTERN.test(id) && id !== '.' && id !== '..';
}

function cleanName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new InvalidProjectError('A project needs a name');
  return trimmed;
}

function cleanColour(color: unknown): string {
  if (typeof color !== 'string' || !COLOUR_PATTERN.test(color)) throw new InvalidProjectError(`A project colour is #rrggbb, not ${JSON.stringify(color)}`);
  return color.toLowerCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The browser project an item of registry.json's `projects` is, or null. */
function toEntry(value: unknown): RegistryEntry | null {
  if (!isObject(value)) return null;
  const { id, dir, tier, lastOpened } = value;
  if (typeof id !== 'string' || !isValidProjectId(id) || typeof dir !== 'string' || !isValidProjectId(dir) || tier !== 'browser') return null;
  if (lastOpened !== undefined && typeof lastOpened !== 'string') return null;
  return { id, dir, tier, ...(typeof lastOpened === 'string' ? { lastOpened } : {}) };
}

/** Empty counts as not written yet: a first write that hasn't landed (review finding 11). */
function parseRegistry(text: string): ReadResult {
  if (text.trim() === '') return { kind: 'none' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'damaged', text };
  }
  if (!isObject(parsed)) return { kind: 'damaged', text };
  const { version, projects, current } = parsed;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || !Array.isArray(projects)) return { kind: 'damaged', text };
  const seen = new Set<string>();
  const items = projects.map((raw: unknown) => {
    const entry = toEntry(raw);
    // A second entry with an id already listed is carried, not shown.
    if (!entry || seen.has(entry.id)) return { raw, entry: null };
    seen.add(entry.id);
    return { raw, entry };
  });
  return { kind: 'file', file: { version, raw: parsed, items, current: typeof current === 'string' ? current : null } };
}

function emptyRegistry(): RegistryFile {
  return { version: REGISTRY_VERSION, raw: {}, items: [], current: null };
}

function entriesOf(file: RegistryFile): RegistryEntry[] {
  return file.items.flatMap((item) => (item.entry ? [item.entry] : []));
}

/** Every id and folder name registry.json uses, whatever the tier. */
function namesIn(file: RegistryFile): Set<string> {
  const names = new Set<string>();
  for (const item of file.items) {
    if (!isObject(item.raw)) continue;
    if (typeof item.raw.id === 'string') names.add(item.raw.id);
    if (typeof item.raw.dir === 'string') names.add(item.raw.dir);
  }
  return names;
}

function withEntry(file: RegistryFile, entry: RegistryEntry): RegistryFile {
  return { ...file, items: [...file.items, { raw: entry, entry }] };
}

function withUpdated(file: RegistryFile, entry: RegistryEntry): RegistryFile {
  return { ...file, items: file.items.map((item) => (item.entry?.id === entry.id ? { raw: item.raw, entry } : item)) };
}

function without(file: RegistryFile, id: string): RegistryFile {
  return { ...file, items: file.items.filter((item) => item.entry?.id !== id), current: file.current === id ? null : file.current };
}

function serialise(file: RegistryFile): string {
  const projects = file.items.map((item) => (item.entry ? { ...(isObject(item.raw) ? item.raw : {}), ...item.entry } : item.raw));
  return json({ ...file.raw, version: file.version, projects, current: file.current });
}

/** The project's meta, with defaults for anything missing or malformed. */
function sanitiseMeta(raw: unknown, id: string): ProjectMeta {
  const meta = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    id,
    name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : id,
    color: typeof meta.color === 'string' && COLOUR_PATTERN.test(meta.color) ? meta.color.toLowerCase() : DEFAULT_PLANET_COLOUR,
    created: typeof meta.created === 'string' ? meta.created : new Date(0).toISOString(),
    createdBy: typeof meta.createdBy === 'string' ? meta.createdBy : 'nebula',
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Runs actions one at a time: across tabs with Web Locks, else in this page. */
function createLock(name: string, given: LockManagerLike | null | undefined): <T>(action: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(action: () => Promise<T>) => {
    const locks = given === undefined ? webLocks() : given;
    const run = async (): Promise<T> => (locks ? await locks.request(name, action) : action());
    const result = tail.then(run, run);
    tail = result.catch(() => {});
    return result;
  };
}

export function createBrowserRegistry(root: FileStore, options: BrowserRegistryOptions = {}): BrowserRegistry {
  const now = options.now ?? (() => new Date());
  const projectStore = options.projectStore ?? ((dir: string) => scopedStore(root, `${PROJECTS}/${dir}`));
  const locked = createLock(options.lockName ?? 'nebula:registry', options.locks);
  const projectDirs =
    options.projectDirs ??
    (async () => {
      const folder = new RegExp(`^${PROJECTS}/([^/]+)$`);
      return (await root.list()).flatMap((entry) => (entry.type === 'dir' ? (entry.path.match(folder)?.slice(1, 2) ?? []) : []));
    });
  // From the last read of registry.json: true when a newer Nebula wrote it.
  let readOnly = false;

  async function readMeta(entry: RegistryEntry): Promise<ProjectMeta | null> {
    // A project whose folder has gone is skipped. Check before asking for its
    // store, which in OPFS would make the folder again.
    if (!(await root.stat(`${PROJECTS}/${entry.dir}`))) return null;
    const store = await projectStore(entry.dir, entry.id);
    try {
      return sanitiseMeta(JSON.parse(await store.readText(META)), entry.id);
    } catch {
      // No readable project.json: show the project under its id.
      return sanitiseMeta(null, entry.id);
    }
  }

  async function readRaw(): Promise<ReadResult> {
    let text: string;
    try {
      text = await root.readText(REGISTRY);
    } catch (error) {
      if (errorName(error) === 'NotFoundError') return { kind: 'none' };
      throw error;
    }
    return parseRegistry(text);
  }

  function noted(file: RegistryFile): RegistryFile {
    readOnly = file.version > REGISTRY_VERSION;
    return file;
  }

  /** registry.json, holding the lock: a damaged one is rebuilt here, and only here. */
  async function readLocked(): Promise<RegistryFile> {
    const read = await readRaw();
    if (read.kind === 'file') return noted(read.file);
    if (read.kind === 'none') return noted(emptyRegistry());
    return noted(await rebuild(read.text));
  }

  /** registry.json, without the lock; a damaged one waits for the lock to be rebuilt (review finding 11). */
  async function read(): Promise<RegistryFile> {
    const result = await readRaw();
    if (result.kind === 'damaged') return locked(readLocked);
    return noted(result.kind === 'file' ? result.file : emptyRegistry());
  }

  /** Project folders that registry.json doesn't name, with what their project.json says. */
  async function unregistered(file: RegistryFile): Promise<FoundFolder[]> {
    const known = namesIn(file);
    const found: FoundFolder[] = [];
    for (const dir of await projectDirs()) {
      if (known.has(dir) || !isValidProjectId(dir)) continue;
      let text: string;
      try {
        text = await root.readText(`${PROJECTS}/${dir}/${META}`);
      } catch (error) {
        // No project.json: not a project (or not yet one). Leave it alone.
        if (errorName(error) === 'NotFoundError' || errorName(error) === 'TypeMismatchError') continue;
        found.push({ dir, id: null, created: '' });
        continue;
      }
      let meta: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(text);
        if (isObject(parsed)) meta = parsed;
      } catch {
        // Damaged project.json: the folder's name stands in for its id.
      }
      found.push({
        dir,
        id: typeof meta.id === 'string' && isValidProjectId(meta.id) ? meta.id : null,
        created: typeof meta.created === 'string' ? meta.created : '',
      });
    }
    return found;
  }

  /** `file` with an entry for each found folder. Oldest first, so of two
   * projects claiming one id the older keeps it; the other takes its
   * folder's name, or a fresh id, and both stay (review finding 24). */
  function adopt(file: RegistryFile, found: FoundFolder[]): RegistryFile {
    const taken = namesIn(file);
    let next = file;
    const oldestFirst = [...found].sort((a, b) => a.created.localeCompare(b.created) || a.dir.localeCompare(b.dir));
    for (const folder of oldestFirst) {
      let id = folder.id !== null && !taken.has(folder.id) ? folder.id : folder.dir;
      while (taken.has(id)) id = newProjectId();
      taken.add(id);
      taken.add(folder.dir);
      next = withEntry(next, { id, dir: folder.dir, tier: 'browser' });
    }
    return next;
  }

  /** Rebuilds a damaged registry.json from the projects' folders, keeping the damaged copy. */
  async function rebuild(damaged: string): Promise<RegistryFile> {
    await root.write(`registry.corrupt-${now().getTime()}.json`, damaged);
    const file = adopt(emptyRegistry(), await unregistered(emptyRegistry()));
    await root.write(REGISTRY, serialise(file));
    return file;
  }

  /** registry.json with every project folder in it: folders it lost (two
   * tabs writing at once, a crash) are adopted, under the lock (review finding 10). */
  async function reconciled(): Promise<RegistryFile> {
    const file = await read();
    if (readOnly || (await unregistered(file)).length === 0) return file;
    return locked(async () => {
      const fresh = await readLocked();
      if (readOnly) return fresh;
      const found = await unregistered(fresh);
      if (found.length === 0) return fresh;
      const adopted = adopt(fresh, found);
      await root.write(REGISTRY, serialise(adopted));
      return adopted;
    });
  }

  function entryFor(file: RegistryFile, id: string): RegistryEntry {
    const entry = entriesOf(file).find((project) => project.id === id);
    if (!entry) throw new FileNotFoundError(`project ${id}`);
    return entry;
  }

  function writable(file: RegistryFile): void {
    if (file.version > REGISTRY_VERSION) throw new ReadOnlyRegistryError(file.version);
  }

  function record(meta: ProjectMeta, entry: RegistryEntry): ProjectRecord {
    const result: ProjectRecord = { ...meta, id: entry.id, tier: 'browser' };
    if (entry.lastOpened) result.lastOpened = entry.lastOpened;
    return result;
  }

  async function list(): Promise<ProjectRecord[]> {
    const file = await reconciled();
    const records: ProjectRecord[] = [];
    for (const entry of entriesOf(file)) {
      const meta = await readMeta(entry);
      if (meta) records.push(record(meta, entry));
    }
    // Opened ones by most recent; the rest keep the order they were made in.
    const opened = records.filter((project) => project.lastOpened).sort((a, b) => (b.lastOpened ?? '').localeCompare(a.lastOpened ?? ''));
    return [...opened, ...records.filter((project) => !project.lastOpened)];
  }

  return {
    list,
    tree: root,
    get readOnly() {
      return readOnly;
    },

    async create(input) {
      const name = cleanName(input.name);
      const color = cleanColour(input.color);
      if (input.id !== undefined && !isValidProjectId(input.id)) throw new InvalidProjectError(`${JSON.stringify(input.id)} can't be a project id`);
      return locked(async () => {
        const file = await readLocked();
        writable(file);
        const taken = namesIn(file);
        if (input.id !== undefined && taken.has(input.id)) throw new FileExistsError(`project ${input.id}`);
        let id = input.id ?? newProjectId();
        while (input.id === undefined && taken.has(id)) id = newProjectId();
        taken.add(id);
        // Generated ids are safe folder names; a kept id gets a fresh folder,
        // since board ids may differ only in case.
        let dir = input.id === undefined ? id : newProjectId();
        while (taken.has(dir) || (await root.stat(`${PROJECTS}/${dir}`))) dir = newProjectId();

        const meta: ProjectMeta = { id, name, color, created: now().toISOString(), createdBy: 'nebula' };
        const entry: RegistryEntry = { id, dir, tier: 'browser' };
        try {
          await (await projectStore(dir, id)).write(META, json(meta));
          await root.write(REGISTRY, serialise(withEntry(file, entry)));
        } catch (error) {
          await root.remove(`${PROJECTS}/${dir}`).catch(() => {});
          throw error;
        }
        return record(meta, entry);
      });
    },

    async open(id) {
      const entry = await locked(async () => {
        const file = await readLocked();
        const found = entryFor(file, id);
        // A newer registry is only read: the project opens, unrecorded.
        if (file.version > REGISTRY_VERSION) return found;
        const opened: RegistryEntry = { ...found, lastOpened: now().toISOString() };
        await root.write(REGISTRY, serialise({ ...withUpdated(file, opened), current: id }));
        return opened;
      });
      return projectStore(entry.dir, entry.id);
    },

    async files(id) {
      const entry = entryFor(await read(), id);
      return projectStore(entry.dir, entry.id);
    },

    async update(id, patch) {
      const name = patch.name === undefined ? undefined : cleanName(patch.name);
      const color = patch.color === undefined ? undefined : cleanColour(patch.color);
      return locked(async () => {
        const file = await readLocked();
        writable(file);
        const entry = entryFor(file, id);
        const current = (await readMeta(entry)) ?? sanitiseMeta(null, id);
        const meta: ProjectMeta = { ...current, ...(name ? { name } : {}), ...(color ? { color } : {}) };
        await (await projectStore(entry.dir, entry.id)).write(META, json(meta));
        return record(meta, entry);
      });
    },

    async remove(id) {
      await locked(async () => {
        const file = await readLocked();
        writable(file);
        const entry = entryFor(file, id);
        try {
          await root.remove(`${PROJECTS}/${entry.dir}`);
        } catch (error) {
          if (errorName(error) !== 'NotFoundError') throw error;
        }
        await root.write(REGISTRY, serialise(without(file, id)));
      });
    },

    async current() {
      const file = await read();
      // The current project, unless it's one of another tier: this one can't open it.
      if (file.current !== null && entriesOf(file).some((entry) => entry.id === file.current)) return file.current;
      return (await list())[0]?.id ?? null;
    },
  };
}
