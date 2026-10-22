/**
 * Moves Nebula 1.x canvases from localStorage into projects (docs/slice-3.md,
 * decisions 3, 4 and 8; PLAN §7). One project per board, one compressed
 * `.excalidraw.md` per canvas at the project's root. It copies and never
 * deletes: the legacy keys stay exactly as they were. Every file is read back
 * and compared before the migration counts as done.
 *
 * Safe to interrupt and to run in two tabs at once (review finding 5):
 *
 * - It runs under the Web Lock `nebula:migration` and looks for its record
 *   again once it holds the lock, so a second tab finds the work done.
 * - Its record, `migration.json` in the browser tier's tree (next to
 *   registry.json), lists each project and library copy before it's made.
 *   A tab closed part-way leaves the record 'in-progress'; the next run takes
 *   back what it lists, then starts again.
 * - Any failure takes back everything this run made. What it can't take back
 *   is reported, and the record stays, so the next run tries again first.
 *
 * The Excalidraw modules load only when there is something to migrate: the
 * build puts them in the canvas chunk, which a first visit shouldn't fetch.
 */
import { errorName } from './errors';
import { withLock, type LockManagerLike } from './locks';
import { PLANET_COLOURS } from './palette';
import { uniqueName } from './paths';
import { isValidProjectId, newProjectId, type BrowserRegistry } from './registry';
import type { ExcalidrawElementLike, ExcalidrawScene } from '../nebula/excalidraw/scene';
import type { NebulaExcalidrawDocument } from '../nebula/storage/types';
import { FIRST_PROJECT_NAME, type FileStore } from './types';

/** localStorage's copy of the marker, kept for a quick look at startup
 * (src/app/boot.ts). The record in the tree is what counts. */
export const MIGRATION_MARKER = 'nebula:migration:v2';
/** The migration's record, in the browser tier's tree next to registry.json:
 * `nebula/migration.json` in OPFS. */
export const MIGRATION_RECORD = 'migration.json';
/** The Web Lock the migration runs under. */
export const MIGRATION_LOCK = 'nebula:migration';

const LEGACY_PREFIX = 'nebula:excalidraw:';
const LIBRARY_PREFIXES = ['nebula:excalidraw-libraries:', 'nebula:excalidraw-library:'];
const DEFAULT_BOARD = 'ss-nebula';
const LEGACY_METADATA = '.nebula/legacy-metadata.json';
const CANVAS_EXTENSION = '.excalidraw.md';
const MAX_STEM_BYTES = 200;

export type MigratedFile = { key: string; canvasId: string; path: string };
export type MigratedProject = { boardId: string; projectId: string; name: string; files: MigratedFile[] };

/** Where one Nebula 1.x canvas went: `migration.json`'s map, for old links. */
export type MigratedCanvas = {
  /** The localStorage key it was copied from. */
  key: string;
  boardId: string;
  canvasId: string;
  projectId: string;
  /** Its file in the project, as the migration wrote it. */
  path: string;
  /** The legacy document's `updatedAt`: the version that moved. */
  updatedAt: string;
};

/** A Nebula 1.x canvas in localStorage that isn't in a project as saved. */
export type LegacyCanvasUpdate = {
  key: string;
  boardId: string;
  canvasId: string;
  name: string;
  /** When it was last saved in localStorage. */
  updatedAt: string;
  /** Where its earlier version went; null when it never moved. */
  migrated: { projectId: string; path: string; updatedAt: string } | null;
};

/** A canvas the migration left in localStorage because its file didn't read
 * back the same (review finding 9). */
export type FailedCanvas = { key: string; boardId: string; canvasId: string; name: string; error: string };

export type MigrationReport = {
  status: 'migrated' | 'nothing-to-migrate' | 'already-done' | 'not-persistent' | 'failed';
  /** Projects made by this run (none unless it migrated). */
  projects: MigratedProject[];
  /** Legacy keys copied by this run. */
  keys: string[];
  /** Keys under the legacy prefix that held no valid document. */
  skipped: string[];
  /** Why nothing ran, for 'not-persistent'. */
  reason?: string;
  /** What went wrong, for 'failed'. No marker was set, and everything this
   * run made was taken back, unless `rollbackErrors` says otherwise. */
  error?: string;
  /** For 'failed': what couldn't be taken back. The next run tries again
   * before it migrates. */
  rollbackErrors?: string[];
  /** For 'migrated': what didn't go as it should without stopping the move,
   * such as a library copy that didn't fit in localStorage. */
  warnings?: string[];
  /** For 'migrated': canvases left out because their file didn't read back
   * the same. Each stays in localStorage, and newerLegacyCanvases() lists it.
   * The other canvases of its board still moved; a board with none left gets
   * no project. */
  failed?: FailedCanvas[];
};

export type MigrationInput = {
  storage: Storage | null | undefined;
  registry: BrowserRegistry;
  /** From openBrowserRegistry(): migrate only when the files will be kept. */
  persistent: boolean;
  now?: () => Date;
  /** Where the record lives: the registry's tree unless given. */
  tree?: FileStore;
  /** Web Locks (navigator.locks) unless given; null runs without them,
   * queued in this page only. */
  locks?: LockManagerLike | null;
};

/** `migration.json`. */
type MigrationRecord = {
  version: 1;
  status: 'in-progress' | 'done';
  /** When the run started (ISO 8601). */
  started: string;
  /** When it finished, once it's done. */
  at?: string;
  /** Projects the run made, each listed before it was made. */
  projects: string[];
  /** localStorage keys it added (library copies), each listed before it was added. */
  libraries: string[];
  /** The legacy keys it copied. */
  keys: string[];
  /** Where each canvas went, once it's done. */
  canvases: MigratedCanvas[];
  /** Canvases left in localStorage because they didn't read back the same. */
  failed?: Array<{ key: string; error: string }>;
};

type Legacy = { key: string; boardId: string; canvasId: string; document: NebulaExcalidrawDocument };

class VerificationError extends Error {
  constructor(path: string, what: string) {
    super(`${path} did not read back the same: ${what}`);
    this.name = 'VerificationError';
  }
}

class DamagedRecordError extends Error {
  constructor(what: string) {
    super(`${MIGRATION_RECORD} is damaged (${what}), so Nebula left everything as it is`);
    this.name = 'DamagedRecordError';
  }
}

function report(status: MigrationReport['status'], extra: Partial<MigrationReport> = {}): MigrationReport {
  return { status, projects: [], keys: [], skipped: [], ...extra };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** The record, or null when there's none. An empty file counts as none: a
 * first write that never finished made nothing yet. */
async function readRecord(tree: FileStore): Promise<MigrationRecord | null> {
  let text: string;
  try {
    text = await tree.readText(MIGRATION_RECORD);
  } catch (error) {
    if (errorName(error) === 'NotFoundError') return null;
    throw error;
  }
  if (text.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DamagedRecordError('not JSON');
  }
  const record = parsed as Partial<MigrationRecord> | null;
  if (!record || typeof record !== 'object' || (record.status !== 'in-progress' && record.status !== 'done')) throw new DamagedRecordError('no status');
  return {
    version: 1,
    status: record.status,
    started: typeof record.started === 'string' ? record.started : new Date(0).toISOString(),
    ...(typeof record.at === 'string' ? { at: record.at } : {}),
    projects: isStrings(record.projects) ? record.projects : [],
    libraries: isStrings(record.libraries) ? record.libraries : [],
    keys: isStrings(record.keys) ? record.keys : [],
    canvases: Array.isArray(record.canvases) ? record.canvases.filter(isMigratedCanvas) : [],
    ...(Array.isArray(record.failed) ? { failed: record.failed.filter((entry) => typeof entry?.key === 'string' && typeof entry.error === 'string') } : {}),
  };
}

function isMigratedCanvas(value: unknown): value is MigratedCanvas {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return ['key', 'boardId', 'canvasId', 'projectId', 'path', 'updatedAt'].every((field) => typeof entry[field] === 'string');
}

async function writeRecord(tree: FileStore, record: MigrationRecord): Promise<void> {
  await tree.write(MIGRATION_RECORD, `${JSON.stringify(record, null, 2)}\n`);
}

async function removeRecord(tree: FileStore): Promise<void> {
  try {
    await tree.remove(MIGRATION_RECORD);
  } catch (error) {
    if (errorName(error) !== 'NotFoundError') throw error;
  }
}

/** localStorage's copy of the marker, `{ at, projects, keys }`, when there's
 * room for it. A full localStorage changes nothing: the record counts. */
function setMarker(storage: Storage, record: MigrationRecord): void {
  try {
    storage.setItem(MIGRATION_MARKER, JSON.stringify({ at: record.at, projects: record.projects, keys: record.keys }));
  } catch {
    // The 1.x users with the most canvases are the ones whose localStorage is full.
  }
}

/** Takes back what a run made, as its record lists it: its projects (only
 * those made since it started) and its library copies. Returns what it
 * couldn't take back. */
async function takeBack(registry: BrowserRegistry, storage: Storage, record: MigrationRecord): Promise<string[]> {
  const problems: string[] = [];
  let listed: Map<string, string>;
  try {
    listed = new Map((await registry.list()).map((project) => [project.id, project.created]));
  } catch (error) {
    return [`the project list: ${describe(error)}`];
  }
  for (const id of [...record.projects].reverse()) {
    const created = listed.get(id);
    // Never touch a project that was there before this run began.
    if (created !== undefined && created < record.started) continue;
    try {
      await registry.remove(id);
    } catch (error) {
      if (errorName(error) !== 'NotFoundError') problems.push(`project ${id}: ${describe(error)}`);
    }
  }
  for (const key of record.libraries) {
    try {
      storage.removeItem(key);
    } catch (error) {
      problems.push(`${key}: ${describe(error)}`);
    }
  }
  return problems;
}

function storageKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const name = storage.key(index);
    if (name !== null) keys.push(name);
  }
  return keys;
}

function parseKey(key: string): { boardId: string; canvasId: string } | null {
  const parts = key.slice(LEGACY_PREFIX.length).split(':');
  if (parts.length !== 2) return null;
  try {
    return { boardId: decodeURIComponent(parts[0]), canvasId: decodeURIComponent(parts[1]) };
  } catch {
    return null;
  }
}

/** A file name from a canvas name: no separators, reserved or control
 * characters, no leading dots, trimmed, and short enough to number. */
function canvasStem(name: string, fallback: string): string {
  const encoder = new TextEncoder();
  const clean = (value: string) =>
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .replace(/[/\\:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .replace(/[. ]+$/, '');
  let stem = clean(name) || clean(fallback) || 'Untitled';
  while (encoder.encode(stem).length > MAX_STEM_BYTES) stem = Array.from(stem).slice(0, -1).join('');
  return stem;
}

function isEmptyMetadata(metadata: NebulaExcalidrawDocument['nebula']): boolean {
  return (
    metadata.ticketLinks.length === 0 &&
    metadata.missionFrames.length === 0 &&
    metadata.artifactRefs.length === 0 &&
    Object.keys(metadata.semanticIndex).length === 0
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** An element as the Obsidian format writes it. These are the only changes
 * toObsidianExcalidrawMarkdown makes to elements, and real Excalidraw data
 * meets the first one: `boundElements: null` becomes []. Anything else that
 * differs fails the migration. */
function asWritten(element: ExcalidrawElementLike): ExcalidrawElementLike {
  const written: ExcalidrawElementLike = { ...element };
  written.groupIds = Array.isArray(written.groupIds) ? written.groupIds : [];
  written.boundElements = Array.isArray(written.boundElements) ? written.boundElements : [];
  if (!('frameId' in written)) written.frameId = null;
  if (!('link' in written)) written.link = null;
  if (!('locked' in written)) written.locked = false;
  if (written.type === 'text') {
    if (!('containerId' in written)) written.containerId = null;
    if (!('originalText' in written) && typeof written.text === 'string') written.originalText = written.text;
    if (!('lineHeight' in written)) written.lineHeight = 1.25;
  }
  return written;
}

function verifyScene(path: string, source: ExcalidrawScene, back: ExcalidrawScene): void {
  const expected = source.elements.map(asWritten);
  if (back.elements.length !== expected.length) throw new VerificationError(path, `${back.elements.length} elements for ${expected.length}`);
  expected.forEach((element, index) => {
    if (!deepEqual(back.elements[index], element)) throw new VerificationError(path, `element ${element.id} changed`);
  });
  if (!deepEqual(back.files ?? {}, source.files ?? {})) throw new VerificationError(path, 'embedded files changed');
}

/** Why `check` threw, or null when it didn't. */
function differs(check: () => void): string | null {
  try {
    check();
    return null;
  } catch (error) {
    return describe(error);
  }
}

/** First planet colour no project has yet; round the palette again after that. */
function nextColour(used: Set<string>, index: number): string {
  const free = PLANET_COLOURS.find((colour) => !used.has(colour.value));
  return (free ?? PLANET_COLOURS[index % PLANET_COLOURS.length]).value;
}

function findLegacy(storage: Storage, isDocument: (value: unknown) => value is NebulaExcalidrawDocument): { found: Legacy[]; skipped: string[] } {
  const found: Legacy[] = [];
  const skipped: string[] = [];
  for (const key of storageKeys(storage).filter((name) => name.startsWith(LEGACY_PREFIX))) {
    const ids = parseKey(key);
    let document: unknown = null;
    try {
      document = JSON.parse(storage.getItem(key) ?? 'null');
    } catch {
      document = null;
    }
    if (ids && isDocument(document)) found.push({ key, ...ids, document });
    else skipped.push(key);
  }
  return { found, skipped };
}

/** The default board first, then the rest by id; within a board 'main' first, then by canvas id. */
function byBoard(found: Legacy[]): Array<[string, Legacy[]]> {
  const boards = new Map<string, Legacy[]>();
  for (const legacy of found) boards.set(legacy.boardId, [...(boards.get(legacy.boardId) ?? []), legacy]);
  const order = (a: string, b: string, first: string) => (a === first ? -1 : b === first ? 1 : a < b ? -1 : a > b ? 1 : 0);
  return [...boards.entries()]
    .sort(([a], [b]) => order(a, b, DEFAULT_BOARD))
    .map(([boardId, canvases]) => [boardId, canvases.sort((a, b) => order(a.canvasId, b.canvasId, 'main'))]);
}

/** A project id no project has: the board's own when it can be one and is free. */
function plannedId(boardId: string, taken: Set<string>): string {
  if (isValidProjectId(boardId) && !taken.has(boardId)) return boardId;
  let id = newProjectId();
  while (taken.has(id)) id = newProjectId();
  return id;
}

export async function migrateLegacyCanvases(input: MigrationInput): Promise<MigrationReport> {
  const { storage, registry, persistent } = input;
  if (!persistent) {
    return report('not-persistent', { reason: 'This browser can’t keep files, so old canvases stay in localStorage for one that can.' });
  }
  if (!storage) return report('nothing-to-migrate');
  const tree = input.tree ?? registry.tree;
  if (!tree) return report('failed', { error: 'TypeError: the registry has no tree to keep the migration’s record in' });
  const run = () => migrateHoldingTheLock({ storage, registry, tree, now: input.now ?? (() => new Date()) });
  try {
    return await withLock(MIGRATION_LOCK, run, input.locks);
  } catch (error) {
    // It reports; it never throws into the app's startup.
    return report('failed', { error: describe(error) });
  }
}

async function migrateHoldingTheLock(input: { storage: Storage; registry: BrowserRegistry; tree: FileStore; now: () => Date }): Promise<MigrationReport> {
  const { storage, registry, tree, now } = input;

  // Look again now that this tab holds the lock: another may have finished.
  let previous: MigrationRecord | null;
  try {
    previous = await readRecord(tree);
  } catch (error) {
    return report('failed', { error: describe(error) });
  }
  if (previous?.status === 'done') return report('already-done');
  // A marker without a record: moved by a build that kept its marker only in localStorage.
  if (!previous && storage.getItem(MIGRATION_MARKER) !== null) return report('already-done');
  if (previous?.status === 'in-progress') {
    // A run stopped part-way (its tab closed, or it couldn't clean up): take back what it made first.
    const leftovers = await takeBack(registry, storage, previous);
    if (leftovers.length > 0) {
      return report('failed', {
        error: `An earlier migration stopped part-way, and Nebula couldn’t take back what it made: ${leftovers.join('; ')}`,
        rollbackErrors: leftovers,
      });
    }
    await removeRecord(tree);
  }

  const hasLegacy = storageKeys(storage).some((name) => name.startsWith(LEGACY_PREFIX));
  const { found, skipped } = hasLegacy
    ? findLegacy(storage, (await import('../nebula/storage/types')).isNebulaExcalidrawDocument)
    : { found: [], skipped: [] };
  const record: MigrationRecord = { version: 1, status: 'in-progress', started: now().toISOString(), projects: [], libraries: [], keys: [], canvases: [] };
  if (found.length === 0) {
    const done: MigrationRecord = { ...record, status: 'done', at: now().toISOString() };
    // Nothing was made, so a record that can't be written just means looking again next time.
    await writeRecord(tree, done).catch(() => {});
    setMarker(storage, done);
    return report('nothing-to-migrate', { skipped });
  }

  const { toObsidianExcalidrawMarkdown, readObsidianExcalidrawMarkdown } = await import('../nebula/excalidraw/obsidianMarkdown');
  const projects: MigratedProject[] = [];
  const warnings: string[] = [];
  const failed: FailedCanvas[] = [];

  try {
    // Written before anything is made, so a tab closed from here on leaves a record to clean up after.
    await writeRecord(tree, record);
    const boards = byBoard(found);
    for (const [index, [boardId, canvases]] of boards.entries()) {
      const existing = await registry.list();
      const id = plannedId(boardId, new Set(existing.map((project) => project.id)));
      const name = boardId === DEFAULT_BOARD ? FIRST_PROJECT_NAME : boardId;
      const color = nextColour(new Set(existing.map((project) => project.color)), index);
      record.projects.push(id);
      await writeRecord(tree, record);
      const project = await registry.create({ name, color, id });

      // A board that couldn't keep its id takes copies of its libraries. A
      // full localStorage keeps the project and says so: the library is still
      // there under the old board's key.
      const copies: string[] = [];
      let libraryLost = false;
      if (project.id !== boardId) {
        for (const prefix of LIBRARY_PREFIXES) {
          const value = storage.getItem(`${prefix}${boardId}`);
          const target = `${prefix}${project.id}`;
          if (value === null || storage.getItem(target) !== null) continue;
          record.libraries.push(target);
          await writeRecord(tree, record);
          try {
            storage.setItem(target, value);
            copies.push(target);
          } catch {
            record.libraries.pop();
            libraryLost = true;
          }
        }
      }

      const store: FileStore = await registry.files(project.id);
      const names: string[] = [];
      const files: MigratedFile[] = [];
      const metadata: Record<string, { key: string; boardId: string; canvasId: string; nebula: NebulaExcalidrawDocument['nebula'] }> = {};
      for (const legacy of canvases) {
        const path = uniqueName(names, `${canvasStem(legacy.document.name, legacy.canvasId)}${CANVAS_EXTENSION}`);
        const source = legacy.document.scene;
        await store.write(path, toObsidianExcalidrawMarkdown(source, { compressed: true }));
        // A file that can't be written or read fails the run (and it's taken
        // back); one that reads back different fails this canvas only.
        const written = await store.readText(path);
        const problem = differs(() => verifyScene(path, source, readObsidianExcalidrawMarkdown(written)));
        if (problem !== null) {
          await store.remove(path);
          failed.push({ key: legacy.key, boardId, canvasId: legacy.canvasId, name: legacy.document.name, error: problem });
          record.failed = [...(record.failed ?? []), { key: legacy.key, error: problem }];
          warnings.push(`“${legacy.document.name}” (board ${boardId}) didn’t read back the same once written, so it stays where Nebula 1.x kept it: ${problem}`);
          continue;
        }
        names.push(path);
        files.push({ key: legacy.key, canvasId: legacy.canvasId, path });
        record.canvases.push({ key: legacy.key, boardId, canvasId: legacy.canvasId, projectId: project.id, path, updatedAt: legacy.document.updatedAt });
        if (!isEmptyMetadata(legacy.document.nebula)) {
          metadata[path] = { key: legacy.key, boardId, canvasId: legacy.canvasId, nebula: legacy.document.nebula };
        }
      }
      if (files.length === 0) {
        // Nothing of this board moved: give back its project and library copies.
        await registry.remove(project.id);
        for (const target of copies) storage.removeItem(target);
        record.projects = record.projects.filter((made) => made !== project.id);
        record.libraries = record.libraries.filter((key) => !copies.includes(key));
        await writeRecord(tree, record);
        continue;
      }
      if (libraryLost) {
        warnings.push(`The Excalidraw library of board ${boardId} didn’t fit in this browser’s storage, so “${name}” starts without it. It’s still saved under the old board.`);
      }
      if (Object.keys(metadata).length > 0) {
        await store.write(LEGACY_METADATA, `${JSON.stringify(metadata, null, 2)}\n`);
        if (!deepEqual(JSON.parse(await store.readText(LEGACY_METADATA)), metadata)) throw new VerificationError(LEGACY_METADATA, 'metadata changed');
      }
      projects.push({ boardId, projectId: project.id, name, files });
    }

    if (projects.length === 0) {
      // Nothing could move: fail, so nothing claims the canvases moved, and
      // the next start tries again (perhaps with a build that can).
      throw new Error(`No canvas read back the same once written, so none moved: ${failed.map((canvas) => canvas.error).join('; ')}`);
    }
    const keys = projects.flatMap((project) => project.files.map((file) => file.key));
    const done: MigrationRecord = { ...record, status: 'done', at: now().toISOString(), keys };
    await writeRecord(tree, done);
    setMarker(storage, done);
    return report('migrated', { projects, keys, skipped, ...(warnings.length > 0 ? { warnings } : {}), ...(failed.length > 0 ? { failed } : {}) });
  } catch (error) {
    // Take back everything this run made; the legacy keys were never touched.
    const problems = await takeBack(registry, storage, record);
    const left = failed.length > 0 ? { failed } : {};
    if (problems.length === 0) {
      await removeRecord(tree).catch(() => {});
      return report('failed', { skipped, error: describe(error), ...left });
    }
    return report('failed', {
      skipped,
      error: `${describe(error)}. Nebula couldn’t take back everything it made, and will try again next time: ${problems.join('; ')}`,
      rollbackErrors: problems,
      ...left,
    });
  }
}

/** Every canvas the migration moved, and where to ([] before it has run). */
export async function migratedCanvases(registry: BrowserRegistry): Promise<MigratedCanvas[]> {
  if (!registry.tree) return [];
  try {
    const record = await readRecord(registry.tree);
    return record?.status === 'done' ? record.canvases : [];
  } catch {
    return [];
  }
}

/** The project and file a Nebula 1.x canvas became, for old
 * `/b/<board>/c/<canvas>` links: where the migration put it. The file may
 * have been renamed or deleted since, so check before opening it. */
export async function findMigratedCanvas(registry: BrowserRegistry, ref: { boardId: string; canvasId: string }): Promise<{ projectId: string; path: string } | null> {
  const found = (await migratedCanvases(registry)).find((canvas) => canvas.boardId === ref.boardId && canvas.canvasId === ref.canvasId);
  return found ? { projectId: found.projectId, path: found.path } : null;
}

function savedAfter(later: string, earlier: string): boolean {
  const a = Date.parse(later);
  const b = Date.parse(earlier);
  return Number.isNaN(a) || Number.isNaN(b) ? later > earlier : a > b;
}

/** Canvases still in localStorage that aren't in a project as saved: saved
 * again by a Nebula 1.x tab after they moved, or never moved (made after the
 * migration, or left behind by it). Empty until the migration has run. For
 * the UI to offer them; nothing here imports them. */
export async function newerLegacyCanvases(input: { storage: Storage | null | undefined; registry: BrowserRegistry }): Promise<LegacyCanvasUpdate[]> {
  const { storage, registry } = input;
  if (!storage || !registry.tree) return [];
  let record: MigrationRecord | null;
  try {
    record = await readRecord(registry.tree);
  } catch {
    return [];
  }
  if (record?.status !== 'done') return [];
  if (!storageKeys(storage).some((name) => name.startsWith(LEGACY_PREFIX))) return [];
  const { found } = findLegacy(storage, (await import('../nebula/storage/types')).isNebulaExcalidrawDocument);
  const moved = new Map(record.canvases.map((canvas) => [canvas.key, canvas]));
  const updates: LegacyCanvasUpdate[] = [];
  for (const [, canvases] of byBoard(found)) {
    for (const legacy of canvases) {
      const entry = moved.get(legacy.key);
      if (entry && !savedAfter(legacy.document.updatedAt, entry.updatedAt)) continue;
      updates.push({
        key: legacy.key,
        boardId: legacy.boardId,
        canvasId: legacy.canvasId,
        name: legacy.document.name,
        updatedAt: legacy.document.updatedAt,
        migrated: entry ? { projectId: entry.projectId, path: entry.path, updatedAt: entry.updatedAt } : null,
      });
    }
  }
  return updates;
}
