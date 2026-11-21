/**
 * The browser tier's registry: a JSON file in
 * the same tree as the projects, so one FileStore implementation reads it all
 * and the memory store tests it.
 *
 *   registry.json                 { version: 1, projects: [{ id, dir, tier, lastOpened }], current }
 *   projects/<dir>/               one project's files
 *   projects/<dir>/.nebula/project.json   its ProjectMeta: the source of truth for name and colour
 *
 * In OPFS the tree is `nebula/` under the origin's root (see opfsRegistry.ts).
 *
 * A folder project is an entry with no `dir`:
 *
 *   { id, tier: 'folder', folder, name, color, created, lastOpened }
 *
 * Its files are in the folder the person picked, whose handle the folder
 * tier keeps by id (folderHandles.ts), and its `.nebula/project.json` is in
 * that folder. The entry remembers the folder's name and the project's name,
 * colour and creation time, so the list can show it while the browser waits
 * for the person's OK to open the folder. Builds before slice 7 carry these
 * entries through untouched (they aren't browser entries to them).
 */
import { sameBlobs } from './bytes';
import { DEFAULT_PLANET_COLOUR } from './palette';
import { FileExistsError, FileNotFoundError, errorName } from './errors';
import { FolderUnavailableError, folderAccess, folderExists, isSkippedPathInFolder, type FolderTier } from './folderTier';
import { ancestors, caseCollisions, isInside } from './paths';
import type { HoldableLocks } from './fileLocks';
import { webLocks, type LockManagerLike } from './locks';
import { scopedStore } from './scopedStore';
import type { FileEntry, FileStore, FolderAccess, FolderHandle, ProjectMeta, ProjectRecord, ProjectRegistry } from './types';

export type CreateProjectInput = {
  name: string;
  color: string;
  /** Keep this id instead of making one. */
  id?: string;
  /** The project lives in this folder (the folder tier). */
  folder?: FolderHandle;
  /** With `folder`: move this browser project there (see moveToFolder). */
  from?: string;
  /** Make it on the server that served the page (src/files/serverRegistry.ts);
   * the browser's own registry refuses it. */
  where?: 'server';
};

export interface BrowserRegistry extends ProjectRegistry {
  create(input: CreateProjectInput): Promise<ProjectRecord>;
  /** The project's files, without recording it as opened: the sample, and
   * downloading a project that isn't the current one. */
  files(id: string): Promise<FileStore>;
  /** The browser tier's own tree: registry.json, projects/ and appearance/.
   * For the app's own device files; reach a project's files through open()
   * and files(). Optional, so a registry
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
  /** The folder tier: without it, folder projects are listed as missing and
   * no new one can be made (a browser that keeps nothing). */
  folders?: FolderTier;
  /** The locks the root store asks for its files (OPFS: a HoldableLocks over
   * navigator.locks). Move to a folder… holds the browser project's files
   * through it (S3). Without it the move takes no file locks. */
  fileLocks?: HoldableLocks | null;
  /** Says a move on the project's channel (`nebula:project:<id>`), so its
   * other tabs pause and follow (S3). Defaults to a BroadcastChannel post. */
  announceMove?: (id: string, state: MoveState) => void;
};

/** What Move to a folder… says to the project's other tabs. */
export type MoveState = 'moving' | 'moved' | 'move-failed';
/** The message on the project's channel (OpfsFileStore hears it). */
export type MoveMessage = { nebulaMove: 1; state: MoveState };

/** A folder holding a move a closed tab left unfinished (S11). */
export class FolderUnfinishedMoveError extends Error {
  constructor(folder: string, project: string) {
    super(`‘${folder}’ holds an unfinished move of ‘${project}’. The project is still in this browser: choose Move to a folder… again to finish it.`);
    this.name = 'FolderUnfinishedMoveError';
  }
}

/** Move to a folder…: another tab changed the project while it moved. */
export class FolderMoveChangedError extends Error {
  constructor(project: string) {
    super(`Something changed in ‘${project}’ while it was moving, so it stays in this browser. Try again.`);
    this.name = 'FolderMoveChangedError';
  }
}

/** Move to a folder…: the folder picked has something in it. */
export class FolderNotEmptyError extends Error {
  constructor(folder: string) {
    super(`The folder ‘${folder}’ isn’t empty. Choose an empty folder, so nothing in it is mixed up with the project or written over.`);
    this.name = 'FolderNotEmptyError';
  }
}

/** Move to a folder…: two paths of the project differ only by case, so a
 * disk that ignores case (macOS, Windows) would make them one (S13). */
export class FolderCaseCollisionError extends Error {
  constructor(project: string, groups: string[][]) {
    const named = groups.slice(0, 3).map((group) => group.map((path) => `‘${path}’`).join(' and '));
    const more = groups.length > 3 ? `, and ${groups.length - 3} more` : '';
    super(`‘${project}’ has names that differ only by capital letters: ${named.join('; ')}${more}. A folder on this computer may treat each pair as one, merging them. Rename one of each pair, then move the project again.`);
    this.name = 'FolderCaseCollisionError';
  }
}

/** Move to a folder…: a file didn't read back from the folder as it was. */
export class FolderMoveError extends Error {
  constructor(path: string) {
    super(`“${path}” didn’t read back from the folder as it was written, so the project stays in this browser.`);
    this.name = 'FolderMoveError';
  }
}

export class NoFolderTierError extends Error {
  constructor() {
    super('This browser can’t keep projects in a folder.');
    this.name = 'NoFolderTierError';
  }
}

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

type BrowserEntry = { id: string; dir: string; tier: 'browser'; lastOpened?: string };
/** A folder project, with what it remembers of the folder's project.json. */
type FolderEntry = { id: string; tier: 'folder'; folder: string; name: string; color: string; created: string; lastOpened?: string };
type RegistryEntry = BrowserEntry | FolderEntry;

/** registry.json as read. Each of its `projects` keeps its own JSON, with
 * the entry it is to this build: null for one this build doesn't understand
 * (another tier's, a newer shape), which writes carry through verbatim, as
 * they do every field this build doesn't know. */
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
/** Written first by Move to a folder… and removed last (S11). */
const MOVING = '.nebula/moving.json';
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

/** The project an item of registry.json's `projects` is, or null. */
function toEntry(value: unknown): RegistryEntry | null {
  if (!isObject(value)) return null;
  const { id, dir, tier, lastOpened } = value;
  if (typeof id !== 'string' || !isValidProjectId(id)) return null;
  if (lastOpened !== undefined && typeof lastOpened !== 'string') return null;
  const opened = typeof lastOpened === 'string' ? { lastOpened } : {};
  if (tier === 'folder') {
    const { folder, name, color, created } = value;
    if (typeof folder !== 'string' || typeof name !== 'string' || !name.trim() || typeof color !== 'string' || !COLOUR_PATTERN.test(color) || typeof created !== 'string') return null;
    return { id, tier, folder, name, color: color.toLowerCase(), created, ...opened };
  }
  if (typeof dir !== 'string' || !isValidProjectId(dir) || tier !== 'browser') return null;
  return { id, dir, tier, ...opened };
}

/** Empty counts as not written yet: a first write that hasn't landed. */
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

/** `file` with the project `id` now `entry`, of whatever tier. */
function withReplaced(file: RegistryFile, id: string, entry: RegistryEntry): RegistryFile {
  return {
    ...file,
    items: file.items.map((item) => {
      if (item.entry?.id !== id) return item;
      // The fields of either tier are the new entry's to say (a browser
      // project's `dir` goes); every field this build doesn't know stays, as
      // it does through every other write (S15).
      const unknown = isObject(item.raw) ? Object.entries(item.raw).filter(([key]) => !ENTRY_FIELDS.has(key)) : [];
      return { raw: { ...Object.fromEntries(unknown), ...entry }, entry };
    }),
  };
}

/** The fields a registry entry of either tier is made of. */
const ENTRY_FIELDS = new Set(['id', 'tier', 'dir', 'lastOpened', 'folder', 'name', 'color', 'created']);

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

function folderEntry(meta: ProjectMeta, folder: string, lastOpened?: string): FolderEntry {
  return { id: meta.id, tier: 'folder', folder, name: meta.name, color: meta.color, created: meta.created, ...(lastOpened ? { lastOpened } : {}) };
}

/** What a folder entry remembers, as the project's meta. */
function rememberedMeta(entry: FolderEntry): ProjectMeta {
  return { id: entry.id, name: entry.name, color: entry.color, created: entry.created, createdBy: 'nebula' };
}

/** A project.json's text, as meta for `id`; null when it isn't one. */
function parseMeta(text: string, id: string): ProjectMeta | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? sanitiseMeta(parsed, id) : null;
  } catch {
    return null;
  }
}

export function createBrowserRegistry(root: FileStore, options: BrowserRegistryOptions = {}): BrowserRegistry {
  const now = options.now ?? (() => new Date());
  const folders = options.folders ?? null;
  const exists = folders?.exists ?? folderExists;
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
  const fileLocks = options.fileLocks ?? null;
  const announceMove =
    options.announceMove ??
    ((id: string, state: MoveState) => {
      if (typeof BroadcastChannel !== 'function') return;
      const channel = new BroadcastChannel(`nebula:project:${id}`);
      channel.postMessage({ nebulaMove: 1, state } satisfies MoveMessage);
      channel.close();
    });

  /** A folder project's folder, if Nebula can open it now. */
  async function reach(entry: FolderEntry): Promise<{ handle: FolderHandle | null; access: FolderAccess }> {
    if (!folders) return { handle: null, access: 'missing' };
    const handle = await folders.handles.get(entry.id).catch(() => null);
    return { handle, access: await folderAccess(handle, exists) };
  }

  /** A folder project's files, or FolderUnavailableError. */
  async function folderStore(entry: FolderEntry): Promise<{ store: FileStore; handle: FolderHandle }> {
    const { handle, access } = await reach(entry);
    if (!folders || !handle || access !== 'granted') throw new FolderUnavailableError(entry.folder, access === 'granted' ? 'missing' : access);
    return { store: await folders.store(handle, entry.id), handle };
  }

  /** What the folder's project.json says, or null when it can't be read. */
  async function folderMeta(store: FileStore, id: string): Promise<ProjectMeta | null> {
    try {
      return parseMeta(await store.readText(META), id);
    } catch (error) {
      if (errorName(error) === 'NotFoundError' || errorName(error) === 'TypeMismatchError') return null;
      throw error;
    }
  }

  /** A folder project as listed: what its folder says when Nebula can open
   * it, else what the entry remembers. */
  async function folderRecord(entry: FolderEntry): Promise<ProjectRecord> {
    const { handle, access } = await reach(entry);
    let meta = rememberedMeta(entry);
    if (folders && handle && access === 'granted') {
      const read = await folderMeta(await folders.store(handle, entry.id), entry.id).catch(() => null);
      if (read) meta = read;
    }
    return record(meta, entry, { name: handle?.name ?? entry.folder, access });
  }

  async function readMeta(entry: BrowserEntry): Promise<ProjectMeta | null> {
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

  /** registry.json, without the lock; a damaged one waits for the lock to be rebuilt. */
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
   * folder's name, or a fresh id, and both stay. */
  function adopt(file: RegistryFile, found: FoundFolder[]): RegistryFile {
    const taken = namesIn(file);
    let next = file;
    const oldestFirst = [...found].sort((a, b) => a.created.localeCompare(b.created) || a.dir.localeCompare(b.dir));
    for (const folder of oldestFirst) {
      let id = folder.id !== null && !taken.has(folder.id) ? folder.id : folder.dir;
      while (taken.has(id)) id = newProjectId();
      taken.add(id);
      taken.add(folder.dir);
      next = withEntry(next, { id, dir: folder.dir, tier: 'browser' } satisfies BrowserEntry);
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
   * tabs writing at once, a crash) are adopted, under the lock. */
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

  function record(meta: ProjectMeta, entry: RegistryEntry, folder?: ProjectRecord['folder']): ProjectRecord {
    const result: ProjectRecord = { ...meta, id: entry.id, tier: entry.tier };
    if (entry.lastOpened) result.lastOpened = entry.lastOpened;
    if (folder) result.folder = folder;
    return result;
  }

  async function list(): Promise<ProjectRecord[]> {
    const file = await reconciled();
    const records: ProjectRecord[] = [];
    for (const entry of entriesOf(file)) {
      if (entry.tier === 'folder') {
        records.push(await folderRecord(entry));
        continue;
      }
      const meta = await readMeta(entry);
      if (meta) records.push(record(meta, entry));
    }
    // Opened ones by most recent; the rest keep the order they were made in.
    const opened = records.filter((project) => project.lastOpened).sort((a, b) => (b.lastOpened ?? '').localeCompare(a.lastOpened ?? ''));
    return [...opened, ...records.filter((project) => !project.lastOpened)];
  }

  /** Whether `old` is the folder `picked` is, or is gone, so the project
   * can follow the folder picked: a folder picked again, one moved, or one
   * this browser forgot. A different folder that still opens is a copy. */
  async function follows(old: FolderHandle | null, picked: FolderHandle): Promise<boolean> {
    if (!old) return true;
    if (typeof old.isSameEntry === 'function' && (await old.isSameEntry(picked).catch(() => false))) return true;
    // Only a folder that's gone is followed (S7): one that needs an OK, or
    // was refused, is still there, and a different folder is a copy.
    return (await folderAccess(old, exists).catch(() => 'missing' as const)) === 'missing';
  }

  /** Makes, or finds again, the project in a folder the person picked
   * (holding the registry lock). The folder's own project.json says which
   * project it is: the same folder opened on another day is never a second
   * project. */
  async function createInFolder(handle: FolderHandle, name: string, color: string): Promise<ProjectRecord> {
    if (!folders) throw new NoFolderTierError();
    const file = await readLocked();
    writable(file);
    const probe = await folders.store(handle, '');
    // One walk first: a folder over the cap is refused here (S8), with
    // FolderTooBigError's sentence, before anything is written into it.
    await probe.list();
    const unfinished = await readMoving(probe);
    if (unfinished) {
      const from = entriesOf(file).find((entry) => entry.id === unfinished.from);
      const name = from?.tier === 'browser' ? ((await readMeta(from))?.name ?? from.id) : (from?.name ?? unfinished.from);
      throw new FolderUnfinishedMoveError(handle.name, name);
    }
    let found: ProjectMeta | null = null;
    try {
      const text = await probe.readText(META);
      const parsed: unknown = JSON.parse(text);
      if (isObject(parsed) && typeof parsed.id === 'string' && isValidProjectId(parsed.id)) found = sanitiseMeta(parsed, parsed.id);
    } catch (error) {
      // No project.json, or one that isn't JSON: the folder becomes a new project.
      if (errorName(error) !== 'NotFoundError' && errorName(error) !== 'TypeMismatchError' && !(error instanceof SyntaxError)) throw error;
    }

    if (found) {
      const foundId = found.id;
      const known = entriesOf(file).find((entry) => entry.id === foundId);
      if (known?.tier === 'folder' && (await follows(await folders.handles.get(known.id).catch(() => null), handle))) {
        await folders.handles.put(known.id, handle);
        const remembered = folderEntry(found, handle.name, known.lastOpened);
        await root.write(REGISTRY, serialise(withUpdated(file, remembered)));
        return record(found, remembered, { name: handle.name, access: await folderAccess(handle, exists) });
      }
    }

    // No project.json: a folder a project knows (its .nebula/ went: git
    // clean, a sync that skips dot-folders) is that project again, and its
    // project.json is written back (S6).
    if (!found) {
      for (const known of entriesOf(file)) {
        if (known.tier !== 'folder') continue;
        const stored = await folders.handles.get(known.id).catch(() => null);
        if (!stored || typeof stored.isSameEntry !== 'function' || !(await stored.isSameEntry(handle).catch(() => false))) continue;
        const meta = rememberedMeta(known);
        await (await folders.store(handle, known.id)).write(META, json(meta));
        await folders.handles.put(known.id, handle);
        const remembered = folderEntry(meta, handle.name, known.lastOpened);
        await root.write(REGISTRY, serialise(withUpdated(file, remembered)));
        return record(meta, remembered, { name: handle.name, access: await folderAccess(handle, exists) });
      }
    }

    const taken = namesIn(file);
    // The folder's own id, unless another project here has it (a copy of a
    // folder, or a downloaded project unpacked into one): then a new one.
    const keep = found !== null && !taken.has(found.id);
    let id = keep && found ? found.id : newProjectId();
    while (!keep && taken.has(id)) id = newProjectId();
    const meta: ProjectMeta = found ? { ...found, id } : { id, name, color, created: now().toISOString(), createdBy: 'nebula' };
    const store = await folders.store(handle, id);
    if (!keep) await store.write(META, json(meta));
    const entry = folderEntry(meta, handle.name);
    await folders.handles.put(id, handle);
    try {
      await root.write(REGISTRY, serialise(withEntry(file, entry)));
    } catch (error) {
      await folders.handles.delete(id).catch(() => {});
      throw error;
    }
    return record(meta, entry, { name: handle.name, access: await folderAccess(handle, exists) });
  }

  /**
   * Move to a folder… (holding the registry lock): a browser project's every
   * file, `.nebula/` included, is copied into an empty folder, read back and
   * compared byte for byte; only then does the project become a folder
   * project, with the same id, and its browser copy go. Any failure before
   * that removes what was copied and leaves the browser project exactly as
   * it was.
   *
   * Another tab's save never falls between the copies (S3): from before the
   * copy until the browser copy is deleted, every file of the browser
   * project is held under its own Web Lock, by the names its store uses, so
   * a save waiting for one finds it gone and fails visibly (its session
   * keeps the edit). The browser copy is listed again under the locks right
   * before the switch: a file that wasn't copied stops the move. The other
   * tabs hear `moving`, then `moved` or `move-failed`.
   */
  async function moveToFolder(id: string, handle: FolderHandle): Promise<ProjectRecord> {
    if (!folders) throw new NoFolderTierError();
    const tier = folders;
    const file = await readLocked();
    writable(file);
    const entry = entryFor(file, id);
    if (entry.tier !== 'browser') throw new InvalidProjectError(`${id} isn’t in this browser`);
    const target = await tier.store(handle, id);
    const projectName = (await readMeta(entry))?.name ?? id;

    const base = `${PROJECTS}/${entry.dir}/`;
    const browserCopy = async () => (await root.list()).filter((item) => item.path.startsWith(base));
    // The names the project's own store gives its files' locks (opfsRegistry:
    // prefix `projects/<dir>`, the root store's own places for them too).
    const places = async () => (await browserCopy()).filter((item) => item.type === 'file').map((item) => item.path);

    // What the folder holds, but the system's own files (S5): .DS_Store,
    // Thumbs.db, desktop.ini and other dot-entries are never touched.
    const present = async () => (await target.list()).filter((item) => !isSkippedPathInFolder(item.path));
    const unfinished = await readMoving(target);
    if (unfinished?.from !== id && ((await present()).length > 0 || (await target.stat('.nebula')))) throw new FolderNotEmptyError(handle.name);

    // A disk that ignores case would merge such paths: refused before
    // anything is written (S13).
    const refuseCollisions = (items: FileEntry[]) => {
      const groups = caseCollisions(items.map((item) => item.path.slice(base.length)));
      if (groups.length > 0) throw new FolderCaseCollisionError(projectName, groups);
    };
    refuseCollisions(await browserCopy());

    let switched = false;
    const run = async (): Promise<ProjectRecord> => {
      const inside = await browserCopy();
      refuseCollisions(inside);
      // A move of this project a closed tab left halfway (S11): what it
      // copied goes, if it's exactly the browser copy's; anything else
      // there and the folder isn't empty.
      if (unfinished?.from === id) await clearUnfinished(target, inside, base, handle.name);

      // Every file this move wrote, with its bytes, and every folder it made
      // (S4): a failure removes only those files still holding those bytes,
      // then those folders if they're empty. Never anything recursively.
      const wrote: Array<{ path: string; blob: Blob }> = [];
      const madeDirs: string[] = [];
      const seenDirs = new Set<string>();
      const makeDirsFor = async (path: string) => {
        for (const folder of ancestors(path)) {
          if (seenDirs.has(folder)) continue;
          if (!(await target.stat(folder))) madeDirs.push(folder);
          seenDirs.add(folder);
        }
      };
      const put = async (path: string, blob: Blob) => {
        await makeDirsFor(path);
        await target.write(path, blob, { exclusive: true });
        wrote.push({ path, blob });
      };
      const undo = async () => {
        for (const { path, blob } of [...wrote].reverse()) {
          const now = await target.readBlob(path).catch(() => null);
          if (now && (await sameBlobs(now, blob))) await target.remove(path).catch(() => {});
        }
        const left = await target.list().catch(() => []);
        const deepestFirst = [...madeDirs].sort((a, b) => b.split('/').length - a.split('/').length);
        for (const folder of deepestFirst) {
          if (folder === '.nebula') {
            // list() can't see into .nebula: it goes once every file the
            // move wrote there is gone.
            const still = await Promise.all(wrote.filter((item) => isInside(item.path, '.nebula')).map((item) => target.stat(item.path).catch(() => null)));
            if (still.every((item) => item === null)) await target.remove('.nebula').catch(() => {});
            continue;
          }
          if (left.some((item) => item.path !== folder && isInside(item.path, folder))) continue;
          if ((await target.stat(folder))?.type === 'dir') await target.remove(folder).catch(() => {});
        }
      };

      let moved: FolderEntry;
      let meta: ProjectMeta;
      try {
        // The marker first, project.json last (S11): a folder a closed tab
        // left halfway says so, and isn't a project yet.
        await put(MOVING, new Blob([json({ from: id, started: now().toISOString() })]));
        const metaItem = inside.find((item) => item.path === base + META);
        for (const item of inside) {
          if (item === metaItem) continue;
          const path = item.path.slice(base.length);
          if (item.type === 'dir') {
            await makeDirsFor(`${path}/x`);
            await target.mkdir(path);
          } else await put(path, await root.readBlob(item.path));
        }
        if (metaItem) await put(META, await root.readBlob(metaItem.path));
        for (const item of inside) {
          if (item.type !== 'file') continue;
          const path = item.path.slice(base.length);
          const back = await target.readBlob(path);
          if (!(await sameBlobs(back, await root.readBlob(item.path)))) {
            // What landed is this move's own, if not what it meant to write.
            const written = wrote.find((candidate) => candidate.path === path);
            if (written) written.blob = back;
            throw new FolderMoveError(path);
          }
        }
        // The last look, under the locks: nothing new since the copy.
        const copied = new Set(inside.map((item) => item.path));
        if ((await browserCopy()).some((item) => !copied.has(item.path))) throw new FolderMoveChangedError(projectName);
        meta = (await folderMeta(target, id)) ?? sanitiseMeta(null, id);
        moved = folderEntry(meta, handle.name, entry.lastOpened);
        await tier.handles.put(id, handle);
        try {
          await root.write(REGISTRY, serialise(withReplaced(file, id, moved)));
        } catch (error) {
          await tier.handles.delete(id).catch(() => {});
          throw error;
        }
      } catch (error) {
        await undo();
        throw error;
      }
      switched = true;
      await target.remove(MOVING).catch((error: unknown) => console.warn('Nebula could not remove .nebula/moving.json', error));
      // The project is the folder's now; the browser copy goes. If it can't,
      // nothing is lost: it shows again as a browser project.
      await deleteBrowserCopy(entry.dir, inside).catch((error: unknown) => console.warn('Nebula could not delete the browser copy', error));
      return record(meta, moved, { name: handle.name, access: await folderAccess(handle, exists) });
    };

    announceMove(id, 'moving');
    try {
      const result = fileLocks ? await fileLocks.hold(places, run) : await run();
      announceMove(id, 'moved');
      return result;
    } catch (error) {
      announceMove(id, switched ? 'moved' : 'move-failed');
      throw error;
    }
  }

  /** What `.nebula/moving.json` says, or null (S11). */
  async function readMoving(store: FileStore): Promise<{ from: string } | null> {
    try {
      const parsed: unknown = JSON.parse(await store.readText(MOVING));
      return isObject(parsed) && typeof parsed.from === 'string' ? { from: parsed.from } : { from: '' };
    } catch (error) {
      if (error instanceof SyntaxError) return { from: '' };
      return null;
    }
  }

  /** Takes away a move of this project a closed tab left halfway: each file
   * whose path and bytes are the browser copy's, then the folders that
   * leaves empty, then the marker. Anything else there: not empty. */
  async function clearUnfinished(target: FileStore, inside: Array<{ path: string; type: string }>, base: string, folder: string): Promise<void> {
    const ours = new Map(inside.map((item) => [item.path.slice(base.length), item]));
    const there = (await target.list()).filter((item) => !isSkippedPathInFolder(item.path));
    for (const item of there) {
      const mine = ours.get(item.path);
      if (!mine || mine.type !== item.type) throw new FolderNotEmptyError(folder);
      if (item.type === 'file' && !(await sameBlobs(await target.readBlob(item.path), await root.readBlob(base + item.path)))) throw new FolderNotEmptyError(folder);
    }
    for (const item of there) if (item.type === 'file') await target.remove(item.path);
    const deepestFirst = there.filter((item) => item.type === 'dir').sort((a, b) => b.path.split('/').length - a.path.split('/').length);
    const left = await target.list();
    for (const item of deepestFirst) if (!left.some((other) => other.path !== item.path && isInside(other.path, item.path))) await target.remove(item.path).catch(() => {});
    for (const known of inside) {
      const path = known.path.slice(base.length);
      if (known.type === 'file' && isInside(path, '.nebula') && (await target.stat(path))) {
        if (!(await sameBlobs(await target.readBlob(path), await root.readBlob(known.path)))) throw new FolderNotEmptyError(folder);
        await target.remove(path);
      }
    }
    await target.remove(MOVING);
  }

  /** Deletes a moved project's browser copy: each file that was copied, one
   * by one (their locks are held), and then the folder, only if nothing
   * else came meanwhile. A file another tab made after the last look stays,
   * with project.json, and shows again as a browser project: never deleted
   * unseen. */
  async function deleteBrowserCopy(dir: string, copied: Array<{ path: string; type: string }>): Promise<void> {
    const base = `${PROJECTS}/${dir}/`;
    for (const item of copied) {
      if (item.type === 'file' && item.path !== base + META) await root.remove(item.path);
    }
    const left = (await root.list()).filter((item) => item.path.startsWith(base) && item.type === 'file' && item.path !== base + META);
    if (left.length > 0) {
      console.warn('Nebula kept the browser copy of files made while the project moved', left.map((item) => item.path));
      return;
    }
    await root.remove(`${PROJECTS}/${dir}`);
  }

  /** Opens a folder project: only once Nebula may open its folder, and
   * never by making an empty one in its place. */
  async function openFolder(id: string): Promise<FileStore> {
    return locked(async () => {
      const file = await readLocked();
      const entry = entryFor(file, id);
      if (entry.tier !== 'folder') throw new FileNotFoundError(`project ${id}`);
      const { store, handle } = await folderStore(entry);
      let meta = await folderMeta(store, id);
      // The folder lost its project.json (deleted, or never synced here):
      // put back what the entry remembers, so the folder says who it is.
      if (!meta) {
        meta = rememberedMeta(entry);
        await store.write(META, json(meta));
      }
      if (file.version > REGISTRY_VERSION) return store;
      const opened = folderEntry(meta, handle.name, now().toISOString());
      await root.write(REGISTRY, serialise({ ...withUpdated(file, opened), current: id }));
      return store;
    });
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
      if (input.where === 'server') throw new InvalidProjectError('There’s no server here to make the project on');
      if (input.folder) {
        const folder = input.folder;
        const from = input.from;
        return locked(() => (from === undefined ? createInFolder(folder, name, color) : moveToFolder(from, folder)));
      }
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
        const entry: BrowserEntry = { id, dir, tier: 'browser' };
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
      const listed = entryFor(await read(), id);
      if (listed.tier === 'folder') return openFolder(id);
      const entry = await locked(async () => {
        const file = await readLocked();
        const found = entryFor(file, id);
        if (found.tier !== 'browser') throw new FileNotFoundError(`project ${id}`);
        // A newer registry is only read: the project opens, unrecorded.
        if (file.version > REGISTRY_VERSION) return found;
        const opened: BrowserEntry = { ...found, lastOpened: now().toISOString() };
        await root.write(REGISTRY, serialise({ ...withUpdated(file, opened), current: id }));
        return opened;
      });
      return projectStore(entry.dir, entry.id);
    },

    async files(id) {
      const entry = entryFor(await read(), id);
      if (entry.tier === 'folder') return (await folderStore(entry)).store;
      return projectStore(entry.dir, entry.id);
    },

    async update(id, patch) {
      const name = patch.name === undefined ? undefined : cleanName(patch.name);
      const color = patch.color === undefined ? undefined : cleanColour(patch.color);
      return locked(async () => {
        const file = await readLocked();
        writable(file);
        const entry = entryFor(file, id);
        if (entry.tier === 'folder') {
          const { store, handle } = await folderStore(entry);
          const current = (await folderMeta(store, id)) ?? rememberedMeta(entry);
          const meta: ProjectMeta = { ...current, ...(name ? { name } : {}), ...(color ? { color } : {}) };
          await store.write(META, json(meta));
          const remembered = folderEntry(meta, handle.name, entry.lastOpened);
          await root.write(REGISTRY, serialise(withUpdated(file, remembered)));
          return record(meta, remembered, { name: handle.name, access: 'granted' });
        }
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
        if (entry.tier === 'folder') {
          // Forget it: the folder and every file in it stay where they are.
          await root.write(REGISTRY, serialise(without(file, id)));
          await folders?.handles.delete(id).catch(() => {});
          return;
        }
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
