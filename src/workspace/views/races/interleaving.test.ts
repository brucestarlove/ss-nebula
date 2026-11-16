import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import hexagonText from '../../../../sketches/workspace/assets/winter-hexagon.excalidraw?raw';
import { blobToText } from '../../../files/bytes';
import { MemoryFileStore } from '../../../files/memoryStore';
import { dirname, isInside } from '../../../files/paths';
import type { FileChange, FileStore } from '../../../files/types';
import { createEmptyNebulaMetadata } from '../../../nebula/excalidraw/metadata';
import type { ExcalidrawScene } from '../../../nebula/excalidraw/scene';
import { createFileSceneStore, serialize, type FileSceneStore } from '../canvas/fileSceneStore';
import { subscribeKeptCopies, type KeptCopy, type OpenFileSession } from '../shared/fileSessions';
import { createTextSession, type TextSession } from '../shared/textSession';

/**
 * A seeded, reproducible search for save races, in bulk (round 5, widened in
 * round 6 after the fifth review's H5).
 *
 * Two or three sessions of one file (each its own tab: a memory twin of one
 * store, its own scope) and a third tab with no session that writes blind,
 * renames, moves and deletes the file or its folder. Every store call, every
 * write as it lands, every change heard from another tab and every read of a
 * file's bytes is delayed by a seeded number of microtask hops, and the clock
 * the store stamps files with often stands still, so two writes land "in the
 * same millisecond". Nothing waits on a real timer (the sessions' own save
 * timers are set out of reach; saves come from flush), so a seed replays
 * exactly.
 *
 * The widenings (all on by default; NEBULA_INTERLEAVING_WIDEN=none is round
 * 5's test, or name the ones wanted, comma-separated):
 *
 *  - reads: Blob.arrayBuffer() resolves after seeded microtask hops. jsdom's
 *    Blob has none, so every read was a FileReader macrotask, after every
 *    seeded step, and nothing could land in the middle of one (H5a);
 *  - busy: a tab edits during its own Keep mine and Reload, and an edit is
 *    dropped only by a Reload that took the file (H5b);
 *  - sametab: two sessions of one file in one tab;
 *  - reopen: a view closed and its file opened again at once;
 *  - fail: 4% of session writes throw QuotaExceededError (H3);
 *  - settings: the canvas's background colour and grid change on their own,
 *    and go back (H6);
 *  - aba: a rename, then a new file with the same bytes at the old path;
 *  - strict: the stricter invariants marked (strict) below;
 *  - versions: element versions as Excalidraw makes them (the element's own
 *    version + 1 and a random versionNonce per change, not one global
 *    counter), so two tabs changing one element reach the same version with
 *    different drawings; a blind write sets its base version + 1..3 (N1);
 *  - shows: invariant 6 below (N2);
 *  - gone: H7's gone-check timer runs, driven by seeded microtask hops;
 *  - revert: another writer undoes a file's last change, back to exactly
 *    the text it replaced, over exactly the text it holds (secu's seventh
 *    review, R7-1).
 *
 * The canvas's shell is modelled as the real one behaves when a remount's
 * load fails: SHELL_SHOWS_LOAD_ERROR.
 *
 * After each run, with the seed in every message:
 *  1. the newest content the user made in each session is the last thing
 *     that session wrote (at the file, or as a conflict copy), or is still
 *     held unsaved, or was handed over as a download. Held counts only while
 *     the session is still registered and says it's unsaved, so the page
 *     warns (strict, H5c);
 *  2. no session's write replaced content of another writer that the session
 *     never took (shown) nor chose to write over with Keep mine. With
 *     revert, an undo counts as taken only once this tab took it after it
 *     landed (R7-1);
 *  3. no session wrote an older version of its own content after a newer one;
 *  4. (strict) each landed write is credited to the session whose store made
 *     it, not to whoever authored its content (H5d): a session writes only
 *     content its user made, never creates a file, and never lands in
 *     another file (one that took its path);
 *  5. nothing outlives its seed (see below);
 *  6. (shows) once settled, every open session with nothing unsaved, no
 *     conflict and its file not removed shows what its file holds.
 *
 * NEBULA_INTERLEAVING_RUNS=<n> runs n seeds per kind (default 1500);
 * NEBULA_INTERLEAVING_SEED=<s> runs only seed s and prints its trace.
 */

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(env.NEBULA_INTERLEAVING_RUNS ?? 1500);
const ONLY = env.NEBULA_INTERLEAVING_SEED;
/** With a single seed: print what happened, step by step. */
const TRACE = ONLY !== undefined;
const STEPS = 32;
/** Room for a long run: about 30 ms a seed, with plenty to spare. */
const seedsTimeout = RUNS * 120 + 60_000;
/**
 * Seeds that found a bug only in a long run, run every time beside 1..RUNS,
 * so the everyday suite keeps what a long run once caught. Round 6: note 3712
 * and 6342, a change heard during the session's own write; canvas 2612 and
 * 8321, a failed Reload on a file deleted elsewhere. Round 7 (25,000 seeds
 * with every widening): canvas 14946, Keep mine's write that failed, tried
 * again as an ordinary save and skipped. A seed replays its run exactly only
 * while the generator stays as it is: a change to the operation mix or the
 * delays changes what every seed does, so rerun the long run then, and
 * replace these with the seeds it finds. (Round 7's `versions` changed the
 * canvas's draws, so canvas 2612 and 8321 no longer replay round 6's runs;
 * their deterministic pins are races/longfix.test.ts.) Each seed here runs
 * with the widenings it was pinned under: `revert` came after all of them
 * (R7-1), so it's off for these seeds, and adding it changed none of them.
 */
const REGRESSION_SEEDS: Record<'note' | 'canvas', number[]> = { note: [3712, 6342], canvas: [2612, 8321, 14946] };

const WIDENINGS = ['reads', 'busy', 'sametab', 'reopen', 'fail', 'settings', 'aba', 'strict', 'versions', 'shows', 'gone', 'revert'] as const;
type Widening = (typeof WIDENINGS)[number];
const widenSpec = (env.NEBULA_INTERLEAVING_WIDEN ?? 'all').trim();
const WIDEN = new Set<Widening>(
  widenSpec === 'all' ? WIDENINGS : widenSpec === 'none' ? [] : (widenSpec.split(',').map((name) => name.trim()) as Widening[]),
);
for (const name of WIDEN) if (!WIDENINGS.includes(name)) throw new Error(`NEBULA_INTERLEAVING_WIDEN: no widening named ${name}`);
/** The widenings in force for the seed being run (see REGRESSION_SEEDS). */
let widenNow: ReadonlySet<Widening> = WIDEN;
const on = (name: Widening) => widenNow.has(name);
/** Widenings added after every regression seed was pinned. */
const AFTER_PINNED: readonly Widening[] = ['revert'];
const wideningFor = (seed: number, kind: 'note' | 'canvas'): ReadonlySet<Widening> =>
  REGRESSION_SEEDS[kind].includes(seed) ? new Set([...WIDEN].filter((name) => !AFTER_PINNED.includes(name))) : WIDEN;

/**
 * What the canvas's shell shows when a remount's load fails. Before round 7
 * (N3) it showed an empty canvas the user could draw on (`false`); since, a
 * file-backed canvas shows the error instead, with Try again (`true`): the
 * user can't draw until a load succeeds, and Try again loads once more.
 */
const SHELL_SHOWS_LOAD_ERROR = true;

/** Every session's handle, so held can be checked against the registry: the
 * page warns only while the session is registered and unsaved (H5c). */
const registry = vi.hoisted(() => ({ list: [] as Array<{ session: { path(): string; scope: unknown }; closed: boolean }> }));
vi.mock('../shared/fileSessions', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shared/fileSessions')>();
  return {
    ...original,
    openFileSession: (session: OpenFileSession) => {
      const entry = { session, closed: false };
      registry.list.push(entry);
      const handle = original.openFileSession(session);
      return {
        changed: handle.changed,
        close() {
          entry.closed = true;
          handle.close();
        },
      };
    },
  };
});

type Rng = { next(): number; int(min: number, max: number): number; pick<T>(items: readonly T[]): T; chance(p: number): boolean };

function rngFor(seed: number): Rng {
  let a = seed >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
  };
}

async function hops(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

/** H7's gone-check timer, driven by seeded microtask hops (widening 'gone'):
 * a timer for GONE_MS fires after a seeded number of hops, any other timer
 * is real. */
const GONE_MS = 777;
const GONE_HOPS = Number(env.NEBULA_INTERLEAVING_GONE_HOPS ?? 30);
let goneRng: Pick<Rng, 'int'> = { int: () => 0 };
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const fakeTimers = new Set<object>();
function installGoneTimers() {
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== GONE_MS) return realSetTimeout(fn, ms, ...(rest as []));
    const token = { fake: true };
    fakeTimers.add(token);
    void hops(goneRng.int(0, GONE_HOPS)).then(() => {
      if (!fakeTimers.delete(token)) return;
      tally.goneFired += 1;
      fn();
    });
    return token as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((token: unknown) => {
    if (token && typeof token === 'object' && fakeTimers.delete(token as object)) return;
    realClearTimeout(token as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
}

/** A Blob whose arrayBuffer() resolves after seeded microtask hops, so a
 * read can be overtaken by anything else the scheduler runs (H5a). */
const OriginalBlob = globalThis.Blob;
const BYTES = Symbol('bytes');
const encoder = new TextEncoder();
let blobRng: Pick<Rng, 'int'> = { int: () => 0 };
type Part = string | ArrayBuffer | ArrayBufferView | { [BYTES]?: Uint8Array };
function partBytes(part: Part): Uint8Array {
  if (typeof part === 'string') return encoder.encode(part);
  if (part instanceof ArrayBuffer) return new Uint8Array(part);
  if (ArrayBuffer.isView(part)) return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
  const bytes = (part as { [BYTES]?: Uint8Array })[BYTES];
  if (bytes) return bytes;
  throw new Error('HoppingBlob: a part it cannot read');
}
class HoppingBlob extends OriginalBlob {
  readonly [BYTES]: Uint8Array;
  constructor(parts: Part[] = [], options?: BlobPropertyBag) {
    const chunks = parts.map(partBytes);
    super(chunks as unknown as BlobPart[], options);
    const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      all.set(chunk, at);
      at += chunk.length;
    }
    this[BYTES] = all;
  }
  override async arrayBuffer(): Promise<ArrayBuffer> {
    await hops(blobRng.int(0, 12));
    return this[BYTES].slice().buffer;
  }
}

/** A tab's store: every call takes a random while before and after, and
 * every change heard reaches this tab late, in order. Arguments are
 * forwarded whole. */
function jittered(inner: FileStore, rng: Rng, onRead: (text: string) => void): FileStore {
  const hop = () => hops(rng.int(0, 6));
  const around =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await hop();
      try {
        return await call(...args);
      } finally {
        await hop();
      }
    };
  return {
    list: around(() => inner.list()),
    stat: around((path: string) => inner.stat(path)),
    readText: around(async (path: string) => {
      const text = await inner.readText(path);
      onRead(text);
      return text;
    }),
    readBlob: around((path: string) => inner.readBlob(path)),
    write: around((...args: Parameters<FileStore['write']>) => inner.write(...args)),
    mkdir: around((path: string) => inner.mkdir(path)),
    rename: around((from: string, to: string) => inner.rename(from, to)),
    remove: around((path: string) => inner.remove(path)),
    watch(listener) {
      let heard = Promise.resolve();
      return inner.watch((change) => {
        const late = rng.int(0, 8);
        heard = heard.then(() => hops(late)).then(() => listener(change));
      });
    },
  };
}

/** One session's view of its tab's store: each write's data goes in as a
 * Blob of its own, which the memory store keeps as the file's data, so the
 * watcher can tell which session made each write (strict, H5d). */
function credited(inner: FileStore, writers: WeakMap<Blob, number>, index: number): FileStore {
  return {
    list: () => inner.list(),
    stat: (path) => inner.stat(path),
    readText: (path) => inner.readText(path),
    readBlob: (path) => inner.readBlob(path),
    write: (path, data, ...rest) => {
      const blob = typeof data === 'string' ? new Blob([data]) : data;
      writers.set(blob, index);
      return inner.write(path, blob, ...rest);
    },
    mkdir: (path) => inner.mkdir(path),
    rename: (from, to) => inner.rename(from, to),
    remove: (path) => inner.remove(path),
    watch: (listener) => inner.watch(listener),
  };
}

type Kind = 'note' | 'canvas';

const hexagon = JSON.parse(hexagonText) as ExcalidrawScene;
const baseScene: ExcalidrawScene = { ...hexagon, elements: hexagon.elements.slice(0, 3) };
const SEED_X = Number(baseScene.elements[0].x);
const EXTERNAL = 9;
const BACKGROUNDS = ['#ffffff', '#ffc9c9', '#a5d8ff'];

const docOf = (scene: ExcalidrawScene) => ({
  type: 'starscape.nebula.excalidraw' as const,
  version: 1 as const,
  boardId: 'p',
  canvasId: 'c',
  name: 'c',
  updatedAt: '',
  scene,
  nebula: createEmptyNebulaMetadata(),
});

/** Who made a file's content and which of their versions it is: a session
 * (0, 1, 2, ...), the blind tab (EXTERNAL), or the seed (-1). `key` is the
 * whole content, a canvas's kept settings included; `id` its drawing. */
type Content = { id: string; key: string; author: number; seq: number };

type Settings = { background: string; grid: boolean };
const settingsOf = (scene: ExcalidrawScene): Settings => {
  const appState = (scene.appState ?? {}) as Record<string, unknown>;
  const background = appState.viewBackgroundColor;
  return { background: typeof background === 'string' && background !== 'transparent' ? background : '#ffffff', grid: appState.gridModeEnabled === true };
};
const settingsKey = (settings: Settings) => (on('settings') ? `/${settings.background}/${settings.grid ? 'grid' : 'plain'}` : '');

function contentOf(kind: Kind, text: string): Content | null {
  if (kind === 'note') {
    if (text === 'seed') return { id: 'seed', key: 'seed', author: -1, seq: 0 };
    const match = /^(\d):(\d+)$/.exec(text);
    return match ? { id: text, key: text, author: Number(match[1]), seq: Number(match[2]) } : null;
  }
  try {
    const scene = JSON.parse(text) as ExcalidrawScene;
    const x = Number(scene.elements[0].x);
    const suffix = settingsKey(settingsOf(scene));
    if (x === SEED_X) return { id: 'seed', key: `seed${suffix}`, author: -1, seq: 0 };
    const id = `${Math.floor(x / 1000) - 1}:${x % 1000}`;
    return { id, key: `${id}${suffix}`, author: Math.floor(x / 1000) - 1, seq: x % 1000 };
  } catch {
    return null;
  }
}

type Tab = {
  index: number;
  scope: string;
  /** The tab's store, which sessions sharing the tab share. */
  tabStore: FileStore;
  note?: TextSession;
  canvas?: FileSceneStore;
  /** The canvas as the shell shows it: the revision it loaded, and what
   * the user has made of it since. */
  shell: { revision: number; loading: boolean; scene: ExcalidrawScene | null; settings: Settings; previous: Settings | null; failed: boolean; firstLoadFailed: boolean };
  seq: number;
  /** Counts every edit (a drawing or a setting). */
  edits: number;
  /** The newest content the user made here (null: none, or dropped by Reload). */
  latest: string | null;
  latestEdit: number;
  /** Every content the user made here. */
  made: Set<string>;
  /** What the session took from the file and showed (load, Reload, a change heard). */
  taken: Set<string>;
  /** When it last took each: how many writes had landed then. */
  takenAt: Map<string, number>;
  /** Every take, in order, with how many writes had landed then (N6). */
  takes: Array<{ key: string; at: number }>;
  /** What it read. Keep mine writes over what it had read when the user
   * chose it (the change the bar showed), and nothing newer. */
  reads: Set<string>;
  keptOver: Set<string>;
  keptMine: number;
  busy: boolean;
  reloading: boolean;
  /** A Reload took the file at this edit: edits up to it are dropped. */
  reloadTook: number | null;
  disposed: boolean;
  entry?: { session: { path(): string; scope: unknown }; closed: boolean };
  /** The file it opened (strict, 4). */
  lineage: number;
};

type Landed = { path: string; before: Promise<Blob> | null; after: Promise<Blob>; lineage: number };

const isCopy = (path: string) => path.includes('(conflict ');

/** What the runs exercised, so a pass means something: summed per kind. */
const TALLIES = [
  'conflicts',
  'copies',
  'downloads',
  'keptMine',
  'reloads',
  'reloadsFailed',
  'busyEdits',
  'settings',
  'renames',
  'abas',
  'deletes',
  'blindWrites',
  'sessionWrites',
  'refused',
  'failedWrites',
  'sameTabRuns',
  'reopens',
  'abaLandings',
  'ownBytesOverwritten',
  'loadsFailed',
  'goneFired',
  'reverts',
  'revertsOverwritten',
] as const;
type Tally = Record<(typeof TALLIES)[number], number>;
const emptyTally = (): Tally => Object.fromEntries(TALLIES.map((name) => [name, 0])) as Tally;
let tally = emptyTally();

/** The clock the store stamps files with: it often stands still, so two
 * writes of one size can land in the same millisecond. Each seed starts it
 * afresh, so a seed replays alone as it ran among others. */
let clock = 0;
let calls = 0;
/** The running seed's trace, for a seed that hangs. */
let currentTrace: string[] = [];

async function runSeed(seed: number, kind: Kind): Promise<string[]> {
  clock = 1_700_000_000_000;
  calls = 0;
  const rng = rngFor(seed * 2 + (kind === 'note' ? 0 : 1));
  if (on('reads')) blobRng = rngFor(seed * 7 + 3);
  if (on('gone')) goneRng = rngFor(seed * 11 + 5);
  const ext = kind === 'note' ? 'md' : 'excalidraw';
  const problems: string[] = [];
  const trace: string[] = (currentTrace = []);
  const note = (line: string) => {
    if (TRACE) trace.push(line);
  };
  const disk = new MemoryFileStore();
  const first = `F/doc.${ext}`;
  const seedText = kind === 'note' ? 'seed' : serialize(null, baseScene, 'json');
  await disk.write(first, seedText);

  // Every write as it lands, with what it replaced: the store's watchers hear
  // a change inside the step that makes it, so this sees each in order. Each
  // file keeps a lineage through renames; a new file at a path gets a new one.
  const shadow = new Map<string, Promise<Blob>>();
  const lineageOf = new Map<string, number>();
  let nextLineage = 1;
  shadow.set(first, disk.readBlob(first));
  lineageOf.set(first, 0);
  const landed: Landed[] = [];
  const writers = new WeakMap<Blob, number>();
  /** Files made by the ABA op: a new file with the old one's bytes. */
  const abaLineages = new Set<number>();
  /** Blobs of the revert op's writes (secu, round 7). */
  const reverts = new WeakSet<Blob>();
  disk.watch((change: FileChange) => {
    if (change.type === 'write') {
      // readBlob takes the file's data before its first await.
      const after = disk.readBlob(change.path);
      if (!shadow.has(change.path) || !lineageOf.has(change.path)) lineageOf.set(change.path, nextLineage++);
      landed.push({ path: change.path, before: shadow.get(change.path) ?? null, after, lineage: lineageOf.get(change.path)! });
      note(`  landed #${landed.length - 1} at ${change.path}`);
      shadow.set(change.path, after);
    } else if (change.type === 'rename') {
      note(`  renamed ${change.from} -> ${change.to}`);
      for (const map of [shadow, lineageOf] as Array<Map<string, unknown>>) {
        const moved = [...map].filter(([path]) => isInside(path, change.from));
        for (const [path] of moved) map.delete(path);
        for (const [path, value] of moved) map.set(change.to + path.slice(change.from.length), value);
      }
    } else if (change.type === 'remove') {
      note(`  removed ${change.path}`);
      for (const map of [shadow, lineageOf] as Array<Map<string, unknown>>) for (const path of [...map.keys()]) if (isInside(path, change.path)) map.delete(path);
    }
  });

  const kept: KeptCopy[] = [];
  const stopKept = subscribeKeptCopies((copy) => {
    kept.push(copy);
    if (copy.copy === null) tally.downloads += 1;
  });
  // Writes take longest, as on a real disk.
  const twinDelay = (change: FileChange) => hops(change.type === 'write' ? rng.int(0, 40) : rng.int(0, 4));
  const other = jittered(disk.twin({ delay: twinDelay }), rng, () => {});

  const count = rng.int(2, 3);
  const tabs: Tab[] = [];
  const sameTab = on('sametab') && count === 3 && rng.chance(0.5);
  if (sameTab) tally.sameTabRuns += 1;

  const took = (tab: Tab, key: string) => {
    tab.taken.add(key);
    tab.takenAt.set(key, landed.length);
    tab.takes.push({ key, at: landed.length });
  };

  const subscribeTab = (tab: Tab) => {
    const session = tab.note ?? tab.canvas!;
    let last = '';
    let revision = -1;
    session.subscribe(() => {
      const now = session.getState() as unknown as Record<string, unknown>;
      const line = `conflict=${String(now.conflict)} removed=${String(now.removed)} unsaved=${String(now.dirty ?? now.pending)} revision=${String(now.revision)}`;
      if (line !== last) note(`  tab ${tab.index}: ${line}`);
      if (now.conflict === true && !last.startsWith('conflict=true')) tally.conflicts += 1;
      last = line;
      if (now.revision !== revision) {
        revision = now.revision as number;
        // The file replaced what this tab showed: in a Reload, every edit up
        // to now is dropped.
        if (tab.reloading) tab.reloadTook = tab.edits;
        if (tab.note) {
          const content = contentOf(kind, tab.note.getState().text);
          if (content) took(tab, content.key);
        }
      }
    });
  };

  const makeTab = async (index: number, path: string, share?: Tab) => {
    const scope = share ? share.scope : `interleaving-${kind}-${seed}-${index}`;
    const tab: Tab = {
      index,
      scope,
      tabStore: null as unknown as FileStore,
      shell: { revision: -1, loading: false, scene: null, settings: { background: '#ffffff', grid: false }, previous: null, failed: false, firstLoadFailed: false },
      seq: 0,
      edits: 0,
      latest: null,
      latestEdit: 0,
      made: new Set(),
      taken: new Set(),
      takenAt: new Map(),
      takes: [],
      reads: new Set(),
      keptOver: new Set(),
      keptMine: 0,
      busy: false,
      reloading: false,
      reloadTook: null,
      disposed: false,
      lineage: lineageOf.get(path) ?? -1,
    };
    if (share) tab.tabStore = share.tabStore;
    else {
      const twin = disk.twin({ delay: twinDelay });
      const write = twin.write.bind(twin);
      twin.write = async (...args) => {
        try {
          if (on('fail') && rng.chance(0.04)) {
            tally.failedWrites += 1;
            throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
          }
          await write(...args);
          if (isCopy(args[0])) tally.copies += 1;
          else tally.sessionWrites += 1;
        } catch (error) {
          if ((error as Error).name === 'FileChangedError') tally.refused += 1;
          throw error;
        }
      };
      tab.tabStore = jittered(twin, rng, (text) => {
        const content = contentOf(kind, text);
        if (!content) return;
        for (const t of tabs) if (t.tabStore === tab.tabStore) t.reads.add(content.key);
        tab.reads.add(content.key);
      });
    }
    const store = on('strict') ? credited(tab.tabStore, writers, index) : tab.tabStore;
    if (kind === 'note') {
      tab.note = createTextSession(store, path, { saveDelayMs: 2 ** 30, scope, ...(on('gone') ? { goneCheckMs: GONE_MS } : {}) });
      tab.entry = registry.list[registry.list.length - 1];
      subscribeTab(tab);
      tabs.push(tab);
      await tab.note.ready;
      const content = contentOf(kind, tab.note.getState().text);
      if (content) took(tab, content.key);
    } else {
      tab.canvas = createFileSceneStore({ store, path, intervalMs: 2 ** 30, scope, ...(on('gone') ? { goneCheckMs: GONE_MS } : {}) });
      tab.entry = registry.list[registry.list.length - 1];
      subscribeTab(tab);
      tabs.push(tab);
    }
    return tab;
  };
  let nextIndex = count;
  for (let index = 0; index < count; index += 1) await makeTab(index, first, sameTab && index === 2 ? tabs[1] : undefined);

  /** The canvas remounts when the session takes the file (a change heard,
   * Reload): it loads again and Excalidraw echoes the scene. */
  const resync = async (tab: Tab) => {
    const canvas = tab.canvas;
    // A first load that failed is CanvasView's: it shows the file's info
    // card and the error, never the shell, until the view is opened again.
    if (!canvas || tab.shell.loading || tab.disposed || tab.shell.firstLoadFailed) return;
    const revision = canvas.getState().revision;
    // A shell showing a failed load loads again on Try again.
    if (revision === tab.shell.revision && !tab.shell.failed) return;
    tab.shell.loading = true;
    note(`  tab ${tab.index} ${tab.shell.failed && revision === tab.shell.revision ? 'tries again' : 'remounts'} for revision ${revision}`);
    try {
      const loaded = (await canvas.load({ boardId: 'p', canvasId: 'c' }))!;
      tab.shell.scene = loaded.scene;
      tab.shell.settings = settingsOf(loaded.scene);
      tab.shell.previous = null;
      tab.shell.revision = revision;
      tab.shell.failed = false;
      const content = contentOf(kind, serialize(null, loaded.scene, 'json'));
      if (content) took(tab, content.key);
      note(`  tab ${tab.index} loaded ${content?.key} and echoes it`);
      await canvas.save(docOf(loaded.scene));
    } catch {
      tally.loadsFailed += 1;
      if (tab.shell.revision === -1) {
        tab.shell.firstLoadFailed = true;
        tab.shell.failed = true;
        note(`  tab ${tab.index}'s first load failed: the view shows the error`);
        return;
      }
      tab.shell.revision = revision;
      tab.shell.previous = null;
      if (SHELL_SHOWS_LOAD_ERROR) {
        // The error, and Try again: nothing to draw on.
        tab.shell.failed = true;
        tab.shell.scene = null;
        note(`  tab ${tab.index}'s load failed: the shell shows the error`);
      } else {
        // The shell's fallback: an empty canvas the user can draw on, which
        // Excalidraw echoes as it mounts.
        tab.shell.failed = false;
        const empty: ExcalidrawScene = { ...baseScene, elements: [], files: {} };
        tab.shell.scene = empty;
        tab.shell.settings = settingsOf(empty);
        note(`  tab ${tab.index}'s load failed: the shell shows an empty canvas`);
        await canvas.save(docOf(empty));
      }
    } finally {
      tab.shell.loading = false;
    }
  };
  for (const tab of tabs) await resync(tab);

  let version = 1000;
  let external = 0;
  let renames = 0;
  const running: Array<Promise<unknown>> = [];
  const run = (work: () => Promise<unknown>) => running.push(work().catch(() => {}));
  const state = (tab: Tab) => (tab.note ? tab.note.getState() : tab.canvas!.getState());
  const open = () => tabs.filter((tab) => !tab.disposed);
  const files = async () => (await disk.list()).filter((entry) => entry.type === 'file' && !isCopy(entry.path)).map((entry) => entry.path);

  const made = (tab: Tab, key: string) => {
    tab.edits += 1;
    tab.latest = key;
    tab.latestEdit = tab.edits;
    tab.made.add(key);
    if (tab.busy) tally.busyEdits += 1;
  };

  /** A canvas edit: a new drawing (`draw`), or only a kept setting. */
  const canvasEdit = (tab: Tab, draw: boolean) => {
    const canvas = tab.canvas!;
    const now = canvas.getState();
    // A failed load shows the error: the user's way on is Try again.
    if (tab.shell.loading || now.revision !== tab.shell.revision || !tab.shell.scene || tab.shell.failed) {
      run(() => resync(tab));
      return;
    }
    if (now.removed) return;
    let scene = tab.shell.scene;
    // Only a drawing can be told apart: an empty canvas gets one drawn.
    if (!draw && scene.elements.length === 0) return;
    if (draw) {
      tab.seq += 1;
      const x = 1000 * (tab.index + 1) + tab.seq;
      version += 1;
      const changed = (element: ExcalidrawScene['elements'][number]) =>
        on('versions') ? { ...element, x, version: Number(element.version ?? 0) + 1, versionNonce: rng.int(1, 2 ** 30) } : { ...element, x, version };
      scene =
        scene.elements.length === 0
          ? { ...scene, elements: [changed({ ...baseScene.elements[0], version: 0 })] }
          : { ...scene, elements: scene.elements.map((element, index) => (index === 0 ? changed(element) : element)) };
    } else {
      // A setting changed, or changed back (an undo), with no element touched.
      const back = tab.shell.previous !== null && rng.chance(0.5);
      const next: Settings = back
        ? tab.shell.previous!
        : rng.chance(0.5)
          ? { ...tab.shell.settings, background: rng.pick(BACKGROUNDS.filter((colour) => colour !== tab.shell.settings.background)) }
          : { ...tab.shell.settings, grid: !tab.shell.settings.grid };
      tab.shell.previous = tab.shell.settings;
      tab.shell.settings = next;
      tally.settings += 1;
    }
    if (on('settings')) scene = { ...scene, appState: { ...scene.appState, viewBackgroundColor: tab.shell.settings.background, gridModeEnabled: tab.shell.settings.grid } };
    tab.shell.scene = scene;
    const content = contentOf(kind, serialize(null, scene, 'json'))!;
    made(tab, content.key);
    note(`  tab ${tab.index} ${draw ? 'draws' : 'sets'} ${content.key}${tab.busy ? ' (busy)' : ''}`);
    void canvas.save(docOf(scene));
  };

  const edit = (tab: Tab) => {
    if (tab.busy && !on('busy')) return;
    if (tab.note) {
      const content = `${tab.index}:${tab.seq + 1}`;
      tab.note.edit(content);
      if (tab.note.getState().text !== content) return;
      tab.seq += 1;
      made(tab, content);
      note(`  tab ${tab.index} types ${content}${tab.busy ? ' (busy)' : ''}`);
      return;
    }
    canvasEdit(tab, true);
  };

  const keepMine = async (tab: Tab) => {
    tab.busy = true;
    for (const key of tab.reads) tab.keptOver.add(key);
    tab.keptMine += 1;
    tally.keptMine += 1;
    try {
      await (tab.note ?? tab.canvas!).keepMine();
    } finally {
      tab.busy = false;
    }
  };

  const reload = async (tab: Tab) => {
    tally.reloads += 1;
    tab.busy = true;
    tab.reloading = true;
    tab.reloadTook = null;
    try {
      await (tab.note ?? tab.canvas!).reload();
    } finally {
      tab.busy = false;
      tab.reloading = false;
      if (on('busy')) {
        // Dropped only by a Reload that took the file, and only the edits
        // made before it did.
        if (tab.reloadTook !== null && tab.latestEdit <= tab.reloadTook) tab.latest = null;
        if (tab.reloadTook === null) tally.reloadsFailed += 1;
      } else tab.latest = null;
    }
  };

  const ops: Array<[string, number, () => void]> = [
    ['edit', 5, () => {
      const tab = rng.pick(open());
      if (tab) edit(tab);
    }],
    ['flush', 3, () => {
      const tab = rng.pick(open());
      if (!tab) return;
      note(`  tab ${tab.index} flushes`);
      run(() => (tab.note ?? tab.canvas!).flush());
    }],
    ['external write', 1, () => run(async () => {
      const path = rng.pick(await files());
      if (!path) return;
      external += 1;
      tally.blindWrites += 1;
      if (kind === 'note') await other.write(path, `${EXTERNAL}:${external}`);
      else {
        version += 1;
        const x = 1000 * (EXTERNAL + 1) + external;
        const scene = {
          ...baseScene,
          elements: baseScene.elements.map((element, index) =>
            index === 0
              ? on('versions')
                ? { ...element, x, version: Number(element.version ?? 0) + rng.int(1, 3), versionNonce: rng.int(1, 2 ** 30) }
                : { ...element, x, version }
              : element,
          ),
        };
        await other.write(path, serialize(null, scene, 'json'));
      }
    })],
    ['rename file', 1, () => run(async () => {
      const path = rng.pick(await files());
      if (!path) return;
      renames += 1;
      tally.renames += 1;
      const to = rng.chance(0.5) ? `${dirname(path) || 'F'}/r${renames}.${ext}` : `G${renames}/r${renames}.${ext}`;
      await other.rename(path, to);
    })],
    ['rename folder', 0.7, () => run(async () => {
      const path = rng.pick(await files());
      const folder = path ? dirname(path) : '';
      if (!folder) return;
      renames += 1;
      tally.renames += 1;
      await other.rename(folder, `${folder.split('/')[0]}-${renames}`);
    })],
    ['delete', 0.25, () => run(async () => {
      const path = rng.pick(await files());
      if (!path) return;
      tally.deletes += 1;
      await other.remove(rng.chance(0.5) || !dirname(path) ? path : dirname(path));
    })],
    ['reload', 0.8, () => {
      const tab = rng.pick(open());
      if (tab && !tab.busy && (state(tab).conflict || rng.chance(0.3))) {
        note(`  tab ${tab.index} reloads`);
        run(() => reload(tab));
      }
    }],
    ['keep mine', 1.2, () => {
      const tab = rng.pick(open());
      if (tab && !tab.busy && state(tab).conflict) {
        note(`  tab ${tab.index} keeps mine`);
        run(() => keepMine(tab));
      }
    }],
    ['dispose', 0.25, () => {
      const tab = rng.pick(open());
      if (!tab || tab.busy) return;
      tab.disposed = true;
      note(`  tab ${tab.index} closes`);
      run(() => (tab.note ?? tab.canvas!).dispose());
    }],
    ['reopen', on('reopen') ? 0.4 : 0, () => {
      const tab = rng.pick(open());
      if (!tab || tab.busy || nextIndex >= 9 || !tab.entry) return;
      const freshIndex = nextIndex++;
      tab.disposed = true;
      tally.reopens += 1;
      const path = tab.entry.session.path();
      note(`  tab ${tab.index} closes and reopens ${path} as tab ${freshIndex}`);
      run(() => (tab.note ?? tab.canvas!).dispose());
      run(async () => {
        const fresh = await makeTab(freshIndex, path, tab);
        if (fresh.canvas) await resync(fresh);
      });
    }],
    ['setting', on('settings') && kind === 'canvas' ? 1.5 : 0, () => {
      const tab = rng.pick(open());
      if (tab && (!tab.busy || on('busy'))) canvasEdit(tab, false);
    }],
    ['revert', on('revert') ? 1 : 0, () => run(async () => {
      // Another writer undoes the file's last change: exactly the text it
      // replaced, over exactly the text it holds now.
      const path = rng.pick(await files());
      if (!path) return;
      const last = [...landed].reverse().find((entry) => entry.path === path);
      if (!last || !last.before) return;
      const now = await blobToText(await last.after);
      const back = await blobToText(await last.before);
      if (now === back) return;
      const blob = new Blob([back]);
      reverts.add(blob);
      tally.reverts += 1;
      note(`  revert at ${path}`);
      await other.write(path, blob, { ifUnchanged: { text: now } });
    })],
    ['aba', on('aba') ? 0.5 : 0, () => run(async () => {
      const path = rng.pick(await files());
      if (!path) return;
      const text = await other.readText(path);
      renames += 1;
      tally.renames += 1;
      tally.abas += 1;
      await other.rename(path, `${dirname(path) || 'F'}/aba${renames}.${ext}`);
      await other.write(path, text, { exclusive: true });
      const made = lineageOf.get(path);
      if (made !== undefined) abaLineages.add(made);
    })],
  ];
  const total = ops.reduce((sum, [, weight]) => sum + weight, 0);

  for (let step = 0; step < STEPS; step += 1) {
    let roll = rng.next() * total;
    for (const [name, weight, op] of ops) {
      roll -= weight;
      if (roll < 0) {
        note(`step ${step}: ${name}`);
        op();
        break;
      }
    }
    await hops(rng.int(0, 30));
  }

  note('settling');
  // The user settles up: every conflict is resolved one way or the other,
  // and every view closes (a conflict left open goes to a copy).
  for (let round = 0; round < 4; round += 1) {
    await Promise.allSettled(running.splice(0));
    for (const tab of open()) {
      await resync(tab);
      if (state(tab).conflict && rng.chance(0.5)) await keepMine(tab).catch(() => {});
      await (tab.note ?? tab.canvas!).flush().catch(() => {});
    }
  }
  await Promise.allSettled(running.splice(0));
  if (on('shows')) {
    // 6. A clean session shows what its file holds. Every heard change and
    // check has run by now (each is a chain of microtasks).
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => realSetTimeout(resolve, 1));
    for (const tab of open()) {
      await resync(tab);
      const now = state(tab) as unknown as Record<string, unknown>;
      if (now.conflict || now.removed || now.dirty || now.pending || now.status === 'error') continue;
      if (tab.canvas && tab.shell.failed) continue;
      const at = tab.entry?.session.path();
      if (!at) continue;
      const onDisk = await disk.readText(at).catch(() => null);
      if (onDisk === null) continue;
      const diskKey = contentOf(kind, onDisk)?.key;
      const shownText = tab.note ? tab.note.getState().text : tab.shell.scene ? serialize(null, tab.shell.scene, 'json') : null;
      if (shownText === null) continue;
      const shownKey = contentOf(kind, shownText)?.key;
      if (diskKey !== shownKey) problems.push(`tab ${tab.index}: shows ${shownKey} with nothing unsaved, but ${at} holds ${diskKey}${abaLineages.size > 0 ? ' (an ABA ran this seed)' : ''}`);
    }
  }
  for (const tab of open()) {
    tab.disposed = true;
    await (tab.note ?? tab.canvas!).dispose().catch(() => {});
  }
  await hops(400);
  stopKept();

  // What landed, decoded, with who wrote it.
  const decoded = await Promise.all(
    landed.map(async (entry, at) => {
      const before = entry.before ? await entry.before : null;
      const after = await entry.after;
      return {
        at,
        path: entry.path,
        before: before ? contentOf(kind, await blobToText(before)) : null,
        beforeWriter: before ? writers.get(before) : undefined,
        beforeBlob: before,
        afterBlob: after,
        after: contentOf(kind, await blobToText(after)),
        writer: writers.get(after),
        lineage: entry.lineage,
      };
    }),
  );

  if (TRACE) {
    const named = trace.map((line) =>
      line.replace(/#(\d+)/, (_, at: string) => {
        const entry = decoded[Number(at)];
        return `${entry.after?.key} over ${entry.before?.key ?? 'nothing'}${entry.writer !== undefined ? ` by tab ${entry.writer}` : ''}`;
      }),
    );
    console.log(named.join('\n'));
  }

  const strict = on('strict');
  const landedAt = new Map<Blob, number>();
  for (const entry of decoded) landedAt.set(entry.afterBlob, entry.at);
  for (const tab of tabs) {
    const mine = decoded.filter((entry) => (strict ? entry.writer === tab.index : entry.after?.author === tab.index));
    // 1. The newest content isn't lost.
    if (tab.latest !== null) {
      // Written last, or what it took and showed, with nothing written since.
      const takenAt = tab.takenAt.get(tab.latest);
      const reached = strict
        ? mine.at(-1)?.after?.key === tab.latest || (takenAt !== undefined && !mine.some((entry) => entry.at >= takenAt))
        : mine.some((entry) => entry.after?.key === tab.latest);
      const unsaved = tab.note ? tab.note.getState().dirty : tab.canvas!.getState().pending;
      const held = unsaved && (!strict || (!!tab.entry && !tab.entry.closed));
      if (strict && unsaved && !held) problems.push(`tab ${tab.index}: still unsaved, but its session closed, so the page no longer warns - ${tab.latest}`);
      const downloaded = kept.some((copy) => copy.scope === tab.scope && copy.copy === null && contentOf(kind, copy.download.text)?.key === tab.latest);
      if (!reached && !held && !downloaded) {
        const last = mine.at(-1)?.after?.key;
        problems.push(`tab ${tab.index}: its newest content ${tab.latest} was lost (not the last it wrote${last ? `, ${last}` : ''}; not held; no download)`);
      }
    }
    // 2. Never over content it didn't see.
    const seen = new Set([...tab.taken, ...tab.keptOver]);
    /** What the session expected the file to hold when it made this write:
     * the last thing it wrote itself, or the last content it took, whichever
     * came later (N6). */
    const baselineAt = (entry: (typeof mine)[number]): string | undefined => {
      const ownBefore = mine.filter((other) => other.at < entry.at && !isCopy(other.path)).at(-1);
      const takeBefore = tab.takes.filter((take) => take.at <= entry.at).at(-1);
      if (takeBefore && (!ownBefore || takeBefore.at >= ownBefore.at + 1)) return takeBefore.key;
      return ownBefore?.after?.key;
    };
    for (const entry of mine) {
      const before = entry.before;
      if (!before) continue;
      // 2b (revert). Over another writer's undo: only once this tab took it
      // after it landed, kept mine over it, or found there exactly what it
      // expected (its baseline: the undo put back what this tab knew, so the
      // write keeps the undo's intent, as any conditional write does). N5's
      // rewrite wrote over an undo it took for its own write's leftover
      // (R7-1). The baseline is the test's own record, never the session's.
      if (entry.beforeBlob && reverts.has(entry.beforeBlob) && !isCopy(entry.path)) {
        const at = landedAt.get(entry.beforeBlob) ?? -1;
        const tookIt = tab.takes.some((take) => take.key === before.key && take.at > at);
        if (!tookIt && !tab.keptOver.has(before.key) && baselineAt(entry) !== before.key) {
          tally.revertsOverwritten += 1;
          problems.push(`tab ${tab.index}: wrote ${entry.after?.key} over another writer's undo (${before.key}, #${at}) at ${entry.path}, which it never took after it landed`);
        }
        continue;
      }
      if (strict ? entry.beforeWriter === tab.index : before.author === tab.index) continue;
      if (seen.has(before.key)) continue;
      // Bytes this tab made itself, written there by someone else (a new file
      // made with them at the old path, or another tab's identical change),
      // and exactly what this tab expected there at this write: what the
      // precondition checks is the content, and replacing them loses no
      // one's work. Counted, like ABA landings (seeds 19602, 24558 and 24849
      // of the 25,000-seed run, round 6). Only the expected baseline, not any
      // content the tab ever made (N6).
      if (strict && tab.made.has(before.key) && baselineAt(entry) === before.key) {
        tally.ownBytesOverwritten += 1;
        continue;
      }
      problems.push(`tab ${tab.index}: wrote ${entry.after?.key} over ${before.key} at ${entry.path}, which it never took or kept over${tab.keptMine ? ' (it kept mine)' : ''}`);
    }
    if (strict) {
      // 4. Only what its user made; never a new file; never another file.
      for (const entry of mine) {
        if (!entry.after || !tab.made.has(entry.after.key)) problems.push(`tab ${tab.index}: wrote ${entry.after?.key ?? 'something unreadable'} at ${entry.path}, which its user never made`);
        if (isCopy(entry.path)) continue;
        if (!entry.before) problems.push(`tab ${tab.index}: wrote ${entry.after?.key} at ${entry.path}, where nothing was (made a file)`);
        // A new file with exactly the bytes the session expected, at the path
        // it hasn't heard has moved, is beyond a content precondition: the
        // write lands there. Counted, not a problem.
        else if (tab.lineage !== -1 && entry.lineage !== tab.lineage && abaLineages.has(entry.lineage)) tally.abaLandings += 1;
        else if (tab.lineage !== -1 && entry.lineage !== tab.lineage) problems.push(`tab ${tab.index}: wrote ${entry.after?.key} at ${entry.path}, another file (lineage ${entry.lineage}, opened ${tab.lineage})`);
      }
    }
    // 3. Never an older version of its own after a newer one.
    let newest = 0;
    for (const entry of mine) {
      if (isCopy(entry.path) || entry.after?.author !== tab.index) continue;
      if (entry.after.seq < newest) problems.push(`tab ${tab.index}: wrote ${entry.after.key} at ${entry.path} after its newer ${tab.index}:${newest}`);
      newest = Math.max(newest, entry.after.seq);
    }
  }
  // 5. Nothing outlives its seed. Every download offer is let go, as the user
  // dismissing its notice would; then no session of this seed may still be
  // open. One that is would keep the page warning with nothing on screen to
  // resolve it. Its registry entries go too, so a long run holds only the
  // seed it's on (they held every store and drawing of every seed before).
  for (const copy of kept) if (copy.copy === null) copy.release();
  const ours = (entry: (typeof registry.list)[number]) => typeof entry.session.scope === 'string' && entry.session.scope.startsWith(`interleaving-${kind}-${seed}-`);
  for (const entry of registry.list) {
    if (ours(entry) && !entry.closed) problems.push(`a session of ${entry.session.path()} is still open after every tab closed and every offer was let go`);
  }
  registry.list = registry.list.filter((entry) => !ours(entry));
  return problems.map((problem) => `seed ${seed} (${kind}): ${problem}`);
}

async function withWatchdog(seed: number, kind: Kind): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => {
      if (TRACE) console.log(currentTrace.join('\n'));
      resolve([`seed ${seed} (${kind}): didn't finish in 10 s (a save that never settles)`]);
    }, 10_000);
  });
  try {
    return await Promise.race([runSeed(seed, kind), hung]);
  } finally {
    clearTimeout(timer);
  }
}

describe('randomized interleavings of saves, renames, deletes and conflicts across tabs (rounds 5 to 7)', () => {
  beforeAll(() => {
    if (on('reads')) globalThis.Blob = HoppingBlob as typeof Blob;
    if (on('gone')) installGoneTimers();
    vi.spyOn(Date, 'now').mockImplementation(() => {
      calls += 1;
      if (calls % 4 === 0) clock += 1;
      return clock;
    });
  });
  afterAll(() => {
    globalThis.Blob = OriginalBlob;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    vi.restoreAllMocks();
  });

  for (const kind of ['note', 'canvas'] as const) {
    it(`${kind}: no seed loses the newest content, overwrites unseen content or writes an older version`, async () => {
      const seeds = ONLY !== undefined ? [Number(ONLY)] : [...new Set([...Array.from({ length: RUNS }, (_, index) => index + 1), ...REGRESSION_SEEDS[kind]])];
      const problems: string[] = [];
      tally = emptyTally();
      const started = performance.now();
      for (const seed of seeds) {
        widenNow = wideningFor(seed, kind);
        problems.push(...(await withWatchdog(seed, kind)));
      }
      widenNow = WIDEN;
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const failing = [...new Set(problems.map((problem) => Number(/^seed (\d+)/.exec(problem)![1])))];
      // Straight to stdout: vitest shows a passing test's console only on failure.
      const stdout = (globalThis as { process?: { stdout?: { write(text: string): void } } }).process?.stdout;
      stdout?.write(
        `interleavings, ${kind} [${[...WIDEN].join(',') || 'none'}]: ${seeds.length} seeds in ${seconds} s, ${problems.length} problems in ${failing.length} seeds${failing.length ? ` (${failing.slice(0, 30).join(', ')})` : ''}; exercised ${JSON.stringify(tally)}\n`,
      );
      if (problems.length) console.log(`${problems.length} problems in ${seeds.length} ${kind} seeds:\n${problems.join('\n')}`);
      expect(problems.slice(0, 40)).toEqual([]);
    }, Math.max(120_000, seedsTimeout));
  }
});
