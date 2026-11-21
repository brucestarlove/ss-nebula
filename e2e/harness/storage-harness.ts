// Served by the Vite dev server for e2e/storage-*.spec.ts: the storage lane's
// browser checks, driven from Playwright through
// window.storageHarness. Everything lives under nebula/ in OPFS, as in the app.
import { OPFS_TREE, openBrowserRegistry } from '../../src/files/opfsRegistry';
import { OpfsFileStore } from '../../src/files/opfsStore';
import type { BrowserRegistry } from '../../src/files/registry';
import { fileStoreTwinCases, type ConformanceResult } from '../../src/files/storeConformance';

let registry: BrowserRegistry | null = null;

function opened(): BrowserRegistry {
  if (!registry) throw new Error('Call open() first');
  return registry;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function walk(folder: FileSystemDirectoryHandle, prefix: string, into: string[]): Promise<string[]> {
  for await (const handle of (folder as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> }).values()) {
    const path = prefix ? `${prefix}/${handle.name}` : handle.name;
    into.push(handle.kind === 'directory' ? `${path}/` : path);
    if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, path, into);
  }
  return into;
}

async function tree(): Promise<string[]> {
  const root = await navigator.storage.getDirectory();
  try {
    return (await walk(await root.getDirectoryHandle(OPFS_TREE), '', [])).sort();
  } catch {
    return [];
  }
}

async function settle(work: Array<Promise<unknown>>): Promise<string[]> {
  return (await Promise.allSettled(work)).map((result) => (result.status === 'fulfilled' ? 'ok' : describe(result.reason)));
}

type MovableHandle = FileSystemFileHandle & { move?: unknown };

/** Two stores over one fresh folder, as two tabs of one project have. */
async function twinStores(name: string): Promise<{ here: OpfsFileStore; there: OpfsFileStore; folder: FileSystemDirectoryHandle; drop: () => Promise<void> }> {
  const root = await navigator.storage.getDirectory();
  const tree = await root.getDirectoryHandle(OPFS_TREE, { create: true });
  const folderName = `${name}-${crypto.randomUUID()}`;
  const folder = await tree.getDirectoryHandle(folderName, { create: true });
  return {
    here: new OpfsFileStore(folder, { channel: `storage-harness:${folderName}` }),
    there: new OpfsFileStore(folder, { channel: `storage-harness:${folderName}` }),
    folder,
    drop: () => tree.removeEntry(folderName, { recursive: true }).catch(() => {}),
  };
}

type HeldChange = 'rename-file' | 'rename-folder' | 'remove-file' | 'remove-folder';

const harness = {
  /** Writes a new file of `chars` characters through one store while a
   * second store over the same folder (as another tab would) looks at it as
   * often as it can: the sizes it saw, the names its list() gave, and
   * whether this engine has FileSystemHandle.move(). */
  async watchNewFile(chars: number): Promise<{ sizes: number[]; listed: string[]; final: number; looks: number; move: boolean; leftover: string[] }> {
    const root = await navigator.storage.getDirectory();
    const tree = await root.getDirectoryHandle(OPFS_TREE, { create: true });
    await tree.removeEntry('watch-new-file', { recursive: true }).catch(() => {});
    const folder = await tree.getDirectoryHandle('watch-new-file', { create: true });
    const writer = new OpfsFileStore(folder);
    const reader = new OpfsFileStore(folder);
    const sizes = new Set<number>();
    const listed = new Set<string>();
    let done = false;
    let looks = 0;
    const writing = writer.write('Big file.md', 'x'.repeat(chars)).finally(() => {
      done = true;
    });
    while (!done) {
      looks += 1;
      const entry = await reader.stat('Big file.md').catch(() => null);
      if (entry?.type === 'file') sizes.add(entry.size ?? -1);
      for (const listedEntry of await reader.list().catch(() => [])) listed.add(listedEntry.name);
    }
    await writing;
    const final = (await reader.stat('Big file.md'))?.size ?? -1;
    const probe = await folder.getFileHandle('probe', { create: true });
    const move = typeof (probe as MovableHandle).move === 'function';
    await folder.removeEntry('probe');
    const leftover = (await walk(folder, '', [])).filter((name) => name !== 'Big file.md');
    return { sizes: [...sizes].sort((a, b) => a - b), listed: [...listed].sort(), final, looks, move, leftover };
  },

  /** Overwrites a file through one store, back and forth between two
   * versions, while a second store over the same folder (as another tab
   * would) reads it each time: how many reads came back as neither version,
   * a mix of both. WebKit's getFile() isn't a snapshot, so a read during a
   * writable's close() can see old and new bytes together. */
  async watchOverwrite(rounds: number): Promise<{ reads: number; torn: number; lengths: number[] }> {
    const root = await navigator.storage.getDirectory();
    const tree = await root.getDirectoryHandle(OPFS_TREE, { create: true });
    await tree.removeEntry('watch-overwrite', { recursive: true }).catch(() => {});
    const folder = await tree.getDirectoryHandle('watch-overwrite', { create: true });
    const writer = new OpfsFileStore(folder);
    const reader = new OpfsFileStore(folder);
    const before = 'a'.repeat(600_000);
    const after = 'b'.repeat(700_000);
    await writer.write('Plan.md', before);
    let torn = 0;
    const lengths = new Set<number>();
    for (let round = 0; round < rounds; round += 1) {
      const next = round % 2 === 0 ? after : before;
      const [seen] = await Promise.all([reader.readText('Plan.md'), writer.write('Plan.md', next)]);
      lengths.add(seen.length);
      if (seen !== before && seen !== after) torn += 1;
    }
    await tree.removeEntry('watch-overwrite', { recursive: true }).catch(() => {});
    return { reads: rounds, torn, lengths: [...lengths].sort((a, b) => a - b) };
  },

  /** A case of the two-store conformance suite (fileStoreTwinCases) on real OPFS. */
  async runTwinCase(name: string): Promise<ConformanceResult> {
    const testCase = fileStoreTwinCases.find((candidate) => candidate.name === name);
    if (!testCase) return { name, ok: false, error: `No twin case named ${JSON.stringify(name)}` };
    const { here, there, drop } = await twinStores('twin-case');
    try {
      await testCase.run(here, there);
      return { name, ok: true };
    } catch (error) {
      return { name, ok: false, error: describe(error) };
    } finally {
      await drop();
    }
  },

  /** Re-review R4. Store A's write of Sketches/plan.md is held inside A's
   * write (past its locks, before it touches the file), and store B, as
   * another tab, renames or removes the file or its folder. Says whether B
   * finished while A's write was held, what each returned, and what's left. */
  async heldWriteThen(change: HeldChange): Promise<{ wentAhead: boolean; results: string[]; files: string[]; text: string | null }> {
    const { here, there, folder, drop } = await twinStores('held-write');
    try {
      await here.write('Sketches/plan.md', 'v1');
      await here.write('Sketches/other.md', 'other');
      let release = () => {};
      let entered = () => {};
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      type WriteNow = (path: string, data: string | Blob) => Promise<void>;
      const held = here as unknown as { writeNow: WriteNow };
      const writeNow = held.writeNow.bind(here);
      held.writeNow = async (path, data) => {
        entered();
        await gate;
        return writeNow(path, data);
      };
      const writing = here.write('Sketches/plan.md', 'v2');
      await inside;
      const changing =
        change === 'rename-file' ? there.rename('Sketches/plan.md', 'Drawings/plan.md')
        : change === 'rename-folder' ? there.rename('Sketches', 'Drawings')
        : change === 'remove-file' ? there.remove('Sketches/plan.md')
        : there.remove('Sketches');
      let settled = false;
      void changing.then(() => (settled = true), () => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 150));
      const wentAhead = settled;
      release();
      const results = await settle([writing, changing]);
      const files = await walk(folder, '', []);
      const target = change === 'rename-file' ? 'Drawings/plan.md' : change === 'rename-folder' ? 'Drawings/plan.md' : null;
      const text = target ? await there.readText(target).catch((error) => describe(error)) : null;
      return { wentAhead, results, files: files.sort(), text };
    } finally {
      await drop();
    }
  },

  /** Removes the whole browser tier and the localStorage keys, for a clean start. */
  async wipe(): Promise<void> {
    registry = null;
    await (await navigator.storage.getDirectory()).removeEntry(OPFS_TREE, { recursive: true }).catch(() => {});
    localStorage.clear();
  },
  async open(options: { withoutWebLocks?: boolean } = {}): Promise<{ persistent: boolean; reason?: string }> {
    // As in an engine without Web Locks: navigator.locks reads undefined.
    if (options.withoutWebLocks) Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined, configurable: true });
    const handle = await openBrowserRegistry();
    registry = handle.registry;
    return { persistent: handle.persistent, ...(handle.reason ? { reason: handle.reason } : {}) };
  },
  tree,
  async create(name: string): Promise<string> {
    return (await opened().create({ name, color: '#7c8cff' })).id;
  },
  /** Writes a file of the tree directly, as another tab or an older build would. */
  async writeTree(path: string, text: string): Promise<void> {
    let folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_TREE, { create: true });
    const segments = path.split('/');
    for (const segment of segments.slice(0, -1)) folder = await folder.getDirectoryHandle(segment, { create: true });
    const writable = await (await folder.getFileHandle(segments[segments.length - 1], { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  },
  async readTree(path: string): Promise<string> {
    let folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_TREE);
    const segments = path.split('/');
    for (const segment of segments.slice(0, -1)) folder = await folder.getDirectoryHandle(segment);
    return (await (await folder.getFileHandle(segments.at(-1) as string)).getFile()).text();
  },
  seedLocalStorage(entries: Record<string, string>): void {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  },
  localStorage: () => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])),
  async projects(): Promise<Array<{ id: string; name: string }>> {
    return (await opened().list()).map(({ id, name }) => ({ id, name }));
  },
  async paths(id: string): Promise<string[]> {
    return (await (await opened().files(id)).list()).map((entry) => entry.path);
  },
  /** Removes a project while one of its files is still being written. */
  async removeWhileWriting(): Promise<{ results: string[]; tree: string[] }> {
    const project = await opened().create({ name: 'Doomed', color: '#7c8cff' });
    const store = await opened().open(project.id);
    await store.write('Sketches/plan.md', 'v1');
    const results = await settle([store.write('Sketches/plan.md', `v2 ${'·'.repeat(4_000_000)}`), opened().remove(project.id)]);
    return { results, tree: await tree() };
  },
};

Object.assign(window, { storageHarness: harness, filesHarnessReady: true });
