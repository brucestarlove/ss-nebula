import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import hexagonText from '../../../../sketches/workspace/assets/winter-hexagon.excalidraw?raw';
import { blobToText } from '../../../files/bytes';
import { MemoryFileStore } from '../../../files/memoryStore';
import { dirname, isInside } from '../../../files/paths';
import type { FileChange, FileStore } from '../../../files/types';
import { createEmptyNebulaMetadata } from '../../../nebula/excalidraw/metadata';
import type { ExcalidrawScene } from '../../../nebula/excalidraw/scene';
import { createFileSceneStore, serialize, type FileSceneStore } from '../canvas/fileSceneStore';
import { subscribeKeptCopies, type KeptCopy } from '../shared/fileSessions';
import { createTextSession, type TextSession } from '../shared/textSession';

/**
 * Round 5: a seeded, reproducible search for save races, in bulk.
 *
 * Two or three sessions of one file (each its own tab: a memory twin of one
 * store, its own scope) and a third tab with no session that writes blind,
 * renames, moves and deletes the file or its folder. Every store call, every
 * write as it lands and every change heard from another tab is delayed by a
 * random number of microtask hops, and the clock the store stamps files with
 * often stands still, so two writes land "in the same millisecond". Nothing
 * waits on a real timer (the sessions' own save timers are set out of reach;
 * saves come from flush), so a seed replays exactly.
 *
 * After each run, with the seed in every message:
 *  1. the newest content the user made in each session reached the disk (at
 *     the file, or as a conflict copy), or is still held unsaved, or was
 *     handed over as a download;
 *  2. no session's write replaced content of another writer that the session
 *     never took (shown) nor chose to write over with Keep mine;
 *  3. no session wrote an older version of its own content after a newer one.
 *
 * NEBULA_INTERLEAVING_RUNS=<n> runs n seeds per kind (default 500);
 * NEBULA_INTERLEAVING_SEED=<s> runs only seed s.
 */

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(env.NEBULA_INTERLEAVING_RUNS ?? 500);
const ONLY = env.NEBULA_INTERLEAVING_SEED;
/** With a single seed: print what happened, step by step. */
const TRACE = ONLY !== undefined;
const STEPS = 32;
/** Room for a long run: about 10 ms a seed, with plenty to spare. */
const seedsTimeout = RUNS * 50 + 60_000;

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

/** A tab's store: every call takes a random while before and after, and
 * every change heard reaches this tab late, in order. Arguments are
 * forwarded whole. */
function jittered(inner: FileStore, rng: Rng, onRead: (text: string) => void): FileStore {
  const hop = () => hops(rng.int(0, 6));
  const around = <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
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

type Kind = 'note' | 'canvas';

const hexagon = JSON.parse(hexagonText) as ExcalidrawScene;
const baseScene: ExcalidrawScene = { ...hexagon, elements: hexagon.elements.slice(0, 3) };
const SEED_X = Number(baseScene.elements[0].x);
const EXTERNAL = 9;

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
 * (0, 1, 2), the blind tab (EXTERNAL), or the seed (-1). */
type Content = { id: string; author: number; seq: number };

function contentOf(kind: Kind, text: string): Content | null {
  if (kind === 'note') {
    if (text === 'seed') return { id: 'seed', author: -1, seq: 0 };
    const match = /^(\d):(\d+)$/.exec(text);
    return match ? { id: text, author: Number(match[1]), seq: Number(match[2]) } : null;
  }
  try {
    const x = Number((JSON.parse(text) as ExcalidrawScene).elements[0].x);
    if (x === SEED_X) return { id: 'seed', author: -1, seq: 0 };
    return { id: `${Math.floor(x / 1000) - 1}:${x % 1000}`, author: Math.floor(x / 1000) - 1, seq: x % 1000 };
  } catch {
    return null;
  }
}

type Tab = {
  index: number;
  scope: string;
  store: FileStore;
  note?: TextSession;
  canvas?: FileSceneStore;
  /** The canvas as the shell shows it: the revision it loaded, and that scene. */
  shell: { revision: number; base: ExcalidrawScene | null; loading: boolean };
  seq: number;
  /** The newest content the user made here (null: none, or dropped by Reload). */
  latest: string | null;
  /** What the session took from the file and showed (load, Reload, a change heard). */
  taken: Set<string>;
  /** What it read. Keep mine writes over what it had read when the user
   * chose it (the change the bar showed), and nothing newer. */
  reads: Set<string>;
  keptOver: Set<string>;
  keptMine: number;
  busy: boolean;
  disposed: boolean;
};

type Landed = { path: string; before: Promise<Blob> | null; after: Promise<Blob> };

const isCopy = (path: string) => path.includes('(conflict ');

/** What the runs exercised, so a pass means something: summed per kind. */
type Tally = Record<'conflicts' | 'copies' | 'keptMine' | 'reloads' | 'renames' | 'deletes' | 'blindWrites' | 'sessionWrites' | 'refused', number>;
const emptyTally = (): Tally => ({ conflicts: 0, copies: 0, keptMine: 0, reloads: 0, renames: 0, deletes: 0, blindWrites: 0, sessionWrites: 0, refused: 0 });
let tally = emptyTally();

/** The clock the store stamps files with: it often stands still, so two
 * writes of one size can land in the same millisecond. Each seed starts it
 * afresh, so a seed replays alone as it ran among others. */
let clock = 0;
let calls = 0;

async function runSeed(seed: number, kind: Kind): Promise<string[]> {
  clock = 1_700_000_000_000;
  calls = 0;
  const rng = rngFor(seed * 2 + (kind === 'note' ? 0 : 1));
  const ext = kind === 'note' ? 'md' : 'excalidraw';
  const problems: string[] = [];
  const trace: string[] = [];
  const note = (line: string) => {
    if (TRACE) trace.push(line);
  };
  const disk = new MemoryFileStore();
  const first = `F/doc.${ext}`;
  const seedText = kind === 'note' ? 'seed' : serialize(null, baseScene, 'json');
  await disk.write(first, seedText);

  // Every write as it lands, with what it replaced: the store's watchers hear
  // a change inside the step that makes it, so this sees each in order.
  const shadow = new Map<string, Promise<Blob>>();
  shadow.set(first, disk.readBlob(first));
  const landed: Landed[] = [];
  disk.watch((change: FileChange) => {
    if (change.type === 'write') {
      // readBlob takes the file's data before its first await.
      const after = disk.readBlob(change.path);
      landed.push({ path: change.path, before: shadow.get(change.path) ?? null, after });
      note(`  landed #${landed.length - 1} at ${change.path}`);
      shadow.set(change.path, after);
    } else if (change.type === 'rename') {
      note(`  renamed ${change.from} -> ${change.to}`);
      for (const [path, blob] of [...shadow]) {
        if (!isInside(path, change.from)) continue;
        shadow.delete(path);
        shadow.set(change.to + path.slice(change.from.length), blob);
      }
    } else if (change.type === 'remove') {
      note(`  removed ${change.path}`);
      for (const path of [...shadow.keys()]) if (isInside(path, change.path)) shadow.delete(path);
    }
  });

  const kept: KeptCopy[] = [];
  const stopKept = subscribeKeptCopies((copy) => kept.push(copy));
  // Writes take longest, as on a real disk.
  const twinDelay = (change: FileChange) => hops(change.type === 'write' ? rng.int(0, 40) : rng.int(0, 4));
  const other = jittered(disk.twin({ delay: twinDelay }), rng, () => {});

  const count = rng.int(2, 3);
  const tabs: Tab[] = [];
  for (let index = 0; index < count; index += 1) {
    const scope = `interleaving-${kind}-${seed}-${index}`;
    const tab: Tab = {
      index,
      scope,
      store: null as unknown as FileStore,
      shell: { revision: -1, base: null, loading: false },
      seq: 0,
      latest: null,
      taken: new Set(),
      reads: new Set(),
      keptOver: new Set(),
      keptMine: 0,
      busy: false,
      disposed: false,
    };
    const twin = disk.twin({ delay: twinDelay });
    const write = twin.write.bind(twin);
    twin.write = async (...args) => {
      try {
        await write(...args);
        if (isCopy(args[0])) tally.copies += 1;
        else tally.sessionWrites += 1;
      } catch (error) {
        if ((error as Error).name === 'FileChangedError') tally.refused += 1;
        throw error;
      }
    };
    tab.store = jittered(twin, rng, (text) => {
      const content = contentOf(kind, text);
      if (content) tab.reads.add(content.id);
    });
    if (kind === 'note') {
      const note = createTextSession(tab.store, first, { saveDelayMs: 2 ** 30, scope });
      tab.note = note;
      let revision = -1;
      note.subscribe(() => {
        const state = note.getState();
        if (state.revision === revision) return;
        revision = state.revision;
        const content = contentOf(kind, state.text);
        if (content) tab.taken.add(content.id);
      });
      await note.ready;
    } else {
      tab.canvas = createFileSceneStore({ store: tab.store, path: first, intervalMs: 2 ** 30, scope });
    }
    const session = tab.note ?? tab.canvas!;
    let last = '';
    session.subscribe(() => {
      const now = session.getState() as unknown as Record<string, unknown>;
      const line = `conflict=${String(now.conflict)} removed=${String(now.removed)} dirty=${String(now.dirty ?? now.pending)} revision=${String(now.revision)}`;
      if (line !== last) note(`  tab ${index}: ${line}`);
      if (now.conflict === true && !last.startsWith('conflict=true')) tally.conflicts += 1;
      last = line;
    });
    tabs.push(tab);
  }

  /** The canvas remounts when the session takes the file (a change heard,
   * Reload): it loads again and Excalidraw echoes the scene. */
  const resync = async (tab: Tab) => {
    const canvas = tab.canvas;
    if (!canvas || tab.shell.loading || tab.disposed) return;
    const revision = canvas.getState().revision;
    if (revision === tab.shell.revision) return;
    tab.shell.loading = true;
    try {
      const loaded = (await canvas.load({ boardId: 'p', canvasId: 'c' }))!;
      tab.shell.base = loaded.scene;
      tab.shell.revision = revision;
      const content = contentOf(kind, serialize(null, loaded.scene, 'json'));
      if (content) tab.taken.add(content.id);
      await canvas.save(docOf(loaded.scene));
    } catch {
      // Unreadable or gone: the next resync tries again.
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

  const edit = (tab: Tab) => {
    if (tab.busy) return;
    const seq = tab.seq + 1;
    if (tab.note) {
      const content = `${tab.index}:${seq}`;
      tab.note.edit(content);
      if (tab.note.getState().text !== content) return;
      tab.seq = seq;
      tab.latest = content;
      note(`  tab ${tab.index} types ${content}`);
      return;
    }
    const canvas = tab.canvas!;
    const now = canvas.getState();
    if (tab.shell.loading || now.revision !== tab.shell.revision || !tab.shell.base) {
      run(() => resync(tab));
      return;
    }
    if (now.removed) return;
    tab.seq = seq;
    tab.latest = `${tab.index}:${seq}`;
    const x = 1000 * (tab.index + 1) + seq;
    version += 1;
    const scene = { ...tab.shell.base, elements: tab.shell.base.elements.map((element, index) => (index === 0 ? { ...element, x, version } : element)) };
    note(`  tab ${tab.index} draws ${tab.latest}`);
    void canvas.save(docOf(scene));
  };

  const keepMine = async (tab: Tab) => {
    tab.busy = true;
    for (const id of tab.reads) tab.keptOver.add(id);
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
    tab.latest = null;
    try {
      await (tab.note ?? tab.canvas!).reload();
    } finally {
      tab.busy = false;
    }
  };

  const ops: Array<[number, () => void]> = [
    [5, () => {
      const tab = rng.pick(open());
      if (tab) edit(tab);
    }],
    [3, () => {
      const tab = rng.pick(open());
      if (!tab) return;
      note(`  tab ${tab.index} flushes`);
      run(() => (tab.note ?? tab.canvas!).flush());
    }],
    [1, () => run(async () => {
      const path = rng.pick(await files());
      if (!path) return;
      external += 1;
      tally.blindWrites += 1;
      if (kind === 'note') await other.write(path, `${EXTERNAL}:${external}`);
      else {
        version += 1;
        const scene = { ...baseScene, elements: baseScene.elements.map((element, index) => (index === 0 ? { ...element, x: 1000 * (EXTERNAL + 1) + external, version } : element)) };
        await other.write(path, serialize(null, scene, 'json'));
      }
    })],
    [1, () => run(async () => {
      const path = rng.pick(await files());
      if (!path) return;
      renames += 1;
      tally.renames += 1;
      const to = rng.chance(0.5) ? `${dirname(path) || 'F'}/r${renames}.${ext}` : `G${renames}/r${renames}.${ext}`;
      await other.rename(path, to);
    })],
    [0.7, () => run(async () => {
      const path = rng.pick(await files());
      const folder = path ? dirname(path) : '';
      if (!folder) return;
      renames += 1;
      tally.renames += 1;
      await other.rename(folder, `${folder.split('/')[0]}-${renames}`);
    })],
    [0.25, () => run(async () => {
      const path = rng.pick(await files());
      if (!path) return;
      tally.deletes += 1;
      await other.remove(rng.chance(0.5) || !dirname(path) ? path : dirname(path));
    })],
    [0.8, () => {
      const tab = rng.pick(open());
      if (tab && !tab.busy && (state(tab).conflict || rng.chance(0.3))) {
        note(`  tab ${tab.index} reloads`);
        run(() => reload(tab));
      }
    }],
    [1.2, () => {
      const tab = rng.pick(open());
      if (tab && !tab.busy && state(tab).conflict) {
        note(`  tab ${tab.index} keeps mine`);
        run(() => keepMine(tab));
      }
    }],
    [0.25, () => {
      const tab = rng.pick(open());
      if (!tab || tab.busy) return;
      tab.disposed = true;
      note(`  tab ${tab.index} closes`);
      run(() => (tab.note ?? tab.canvas!).dispose());
    }],
  ];
  const total = ops.reduce((sum, [weight]) => sum + weight, 0);

  for (let step = 0; step < STEPS; step += 1) {
    let roll = rng.next() * total;
    for (const [index, [weight, op]] of ops.entries()) {
      roll -= weight;
      if (roll < 0) {
        note(`step ${step}: ${['edit', 'flush', 'external write', 'rename file', 'rename folder', 'delete', 'reload', 'keep mine', 'dispose'][index]}`);
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
  for (const tab of open()) {
    tab.disposed = true;
    await (tab.note ?? tab.canvas!).dispose().catch(() => {});
  }
  await hops(400);
  stopKept();


  // What landed, decoded.
  const decoded = await Promise.all(
    landed.map(async (entry) => ({
      path: entry.path,
      before: entry.before ? contentOf(kind, await blobToText(await entry.before)) : null,
      after: contentOf(kind, await blobToText(await entry.after)),
    })),
  );

  if (TRACE) {
    const named = trace.map((line) => line.replace(/#(\d+)/, (_, at: string) => `${decoded[Number(at)].after?.id} over ${decoded[Number(at)].before?.id ?? 'nothing'}`));
    console.log(named.join('\n'));
  }

  for (const tab of tabs) {
    const mine = decoded.filter((entry) => entry.after?.author === tab.index);
    // 1. The newest content isn't lost.
    if (tab.latest !== null) {
      const reached = mine.some((entry) => entry.after?.id === tab.latest);
      const held = tab.note ? tab.note.getState().dirty : tab.canvas!.getState().pending;
      const downloaded = kept.some((copy) => copy.scope === tab.scope && copy.copy === null && contentOf(kind, copy.download.text)?.id === tab.latest);
      if (!reached && !held && !downloaded) problems.push(`tab ${tab.index}: its newest content ${tab.latest} was lost (not written, not held, no copy)`);
    }
    // 2. Never over content it didn't see.
    const seen = new Set([...tab.taken, ...tab.keptOver]);
    for (const entry of mine) {
      const before = entry.before;
      if (!before || before.author === tab.index || seen.has(before.id)) continue;
      problems.push(`tab ${tab.index}: wrote ${entry.after!.id} over ${before.id} at ${entry.path}, which it never took or kept over${tab.keptMine ? ' (it kept mine)' : ''}`);
    }
    // 3. Never an older version of its own after a newer one.
    let newest = 0;
    for (const entry of mine) {
      if (isCopy(entry.path)) continue;
      if (entry.after!.seq < newest) problems.push(`tab ${tab.index}: wrote ${entry.after!.id} at ${entry.path} after its newer ${tab.index}:${newest}`);
      newest = Math.max(newest, entry.after!.seq);
    }
  }
  return problems.map((problem) => `seed ${seed} (${kind}): ${problem}`);
}

async function withWatchdog(seed: number, kind: Kind): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve([`seed ${seed} (${kind}): didn't finish in 5 s (a save that never settles)`]), 5000);
  });
  try {
    return await Promise.race([runSeed(seed, kind), hung]);
  } finally {
    clearTimeout(timer);
  }
}

describe('randomized interleavings of saves, renames, deletes and conflicts across tabs (round 5)', () => {
  beforeAll(() => {
    vi.spyOn(Date, 'now').mockImplementation(() => {
      calls += 1;
      if (calls % 4 === 0) clock += 1;
      return clock;
    });
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  for (const kind of ['note', 'canvas'] as const) {
    it(`${kind}: no seed loses the newest content, overwrites unseen content or writes an older version`, async () => {
      const seeds = ONLY !== undefined ? [Number(ONLY)] : Array.from({ length: RUNS }, (_, index) => index + 1);
      const problems: string[] = [];
      tally = emptyTally();
      for (const seed of seeds) problems.push(...(await withWatchdog(seed, kind)));
      // Straight to stdout: vitest shows a passing test's console only on failure.
      const stdout = (globalThis as { process?: { stdout?: { write(text: string): void } } }).process?.stdout;
      stdout?.write(`interleavings, ${kind}: ${seeds.length} seeds, ${problems.length} problems; exercised ${JSON.stringify(tally)}\n`);
      if (problems.length) console.log(`${problems.length} problems in ${seeds.length} ${kind} seeds:\n${problems.join('\n')}`);
      expect(problems.slice(0, 12)).toEqual([]);
    }, Math.max(120_000, seedsTimeout));
  }
});
