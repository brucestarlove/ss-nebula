/**
 * The behaviour every FileStore must show, written once and run against each
 * implementation: MemoryFileStore in vitest, OpfsFileStore in real browsers
 * (e2e/harness/files-opfs.html). It imports no test framework, so the same
 * cases run under vitest, in a plain page, or anywhere else.
 */
import { blobToBytes } from './bytes';
import { errorName } from './errors';
import { comparePaths } from './paths';
import type { FileChange, FileEntry, FileStore } from './types';

export type FileStoreFactory = () => FileStore | Promise<FileStore>;

export type ConformanceCase = {
  name: string;
  run: (store: FileStore) => Promise<void>;
  /** The case is about write options: every wrapper must pass it too. */
  writeOptions?: true;
};

export type ConformanceResult = { name: string; ok: boolean; error?: string };

/** The subset of vitest/jest/mocha the suite registers itself with. */
export type TestApi = {
  describe: (name: string, body: () => void) => void;
  it: (name: string, body: () => Promise<void>) => void;
};

class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceFailure';
  }
}

function show(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  } catch {
    return String(value);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceFailure(message);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a).filter((key) => (a as Record<string, unknown>)[key] !== undefined);
  const keysB = Object.keys(b).filter((key) => (b as Record<string, unknown>)[key] !== undefined);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!deepEqual(actual, expected)) {
    throw new ConformanceFailure(`${message}\n  expected: ${show(expected)}\n  actual:   ${show(actual)}`);
  }
}

async function assertRejects(action: () => Promise<unknown>, expectedName: string | null, message: string): Promise<void> {
  let rejected = false;
  let error: unknown;
  try {
    await action();
  } catch (caught) {
    rejected = true;
    error = caught;
  }
  assert(rejected, `${message}: expected a rejection, but it resolved`);
  if (expectedName) {
    assert(errorName(error) === expectedName, `${message}: expected ${expectedName}, got ${errorName(error)}: ${String(error)}`);
  }
}

/** Path, type and size: what every store must agree on (`modified` is optional). */
function shape(entry: FileEntry | null): Partial<FileEntry> | null {
  if (!entry) return null;
  return entry.type === 'file'
    ? { path: entry.path, name: entry.name, type: entry.type, size: entry.size }
    : { path: entry.path, name: entry.name, type: entry.type };
}

async function listed(store: FileStore): Promise<string[]> {
  return (await store.list()).map((entry) => (entry.type === 'dir' ? `${entry.path}/` : entry.path));
}

function bytesOf(length: number, seed = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + seed + (index >> 8)) % 256;
  return bytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

const utf8 = new TextEncoder();

/** Text big enough that a real store's write is still in flight when the
 * next call is made (OPFS takes milliseconds over a couple of megabytes). */
function inFlight(label: string): string {
  return `${label} ${'·'.repeat(2_000_000)}`;
}

export const fileStoreConformanceCases: ConformanceCase[] = [
  {
    name: 'lists nothing in a new store',
    async run(store) {
      assertEqual(await store.list(), [], 'list() of a new store');
    },
  },
  {
    name: 'round-trips text exactly',
    async run(store) {
      const samples = [
        'Hello',
        'Nébula 🌌 — “quotes”, ünïcödé and 漢字',
        'Windows\r\nline endings\r\n',
        '\uFEFFstarts with a byte-order mark',
        '',
        'a NUL \u0000 inside',
        'long '.repeat(40_000),
      ];
      for (const [index, text] of samples.entries()) {
        await store.write(`text-${index}.md`, text);
        assert((await store.readText(`text-${index}.md`)) === text, `text sample ${index} came back different`);
      }
    },
  },
  {
    name: 'round-trips binary data byte for byte',
    async run(store) {
      const every = new Uint8Array(256).map((_, index) => index);
      const big = bytesOf(300_000, 7);
      for (const [path, bytes] of [['every-byte.bin', every], ['big.bin', big], ['empty.bin', new Uint8Array(0)]] as const) {
        await store.write(path, new Blob([bytes]));
        const back = await blobToBytes(await store.readBlob(path));
        assert(sameBytes(back, bytes), `${path}: ${back.length} bytes came back for ${bytes.length} written, or they differ`);
        assertEqual((await store.stat(path))?.size, bytes.length, `${path}: stat size`);
      }
      await store.write('utf8.md', 'é🌌');
      assert(sameBytes(await blobToBytes(await store.readBlob('utf8.md')), utf8.encode('é🌌')), 'text is stored as UTF-8');
    },
  },
  {
    name: 'describes files and folders with stat, and returns null for nothing',
    async run(store) {
      await store.write('Guides/Orion.md', 'Orion');
      assertEqual(shape(await store.stat('Guides/Orion.md')), { path: 'Guides/Orion.md', name: 'Orion.md', type: 'file', size: 5 }, 'stat of a file');
      const modified = (await store.stat('Guides/Orion.md'))?.modified;
      assert(modified === undefined || (typeof modified === 'number' && modified > Date.UTC(2020, 0, 1)), `modified should be epoch milliseconds, got ${modified}`);
      assertEqual(shape(await store.stat('Guides')), { path: 'Guides', name: 'Guides', type: 'dir' }, 'stat of a folder');
      assertEqual(await store.stat('Guides/missing.md'), null, 'stat of a missing file');
      assertEqual(await store.stat('Nowhere/deeper.md'), null, 'stat under a missing folder');
      assertEqual(await store.stat('Guides/Orion.md/inside'), null, 'stat through a file');
    },
  },
  {
    name: 'lists every file and folder sorted by path, folder before its contents',
    async run(store) {
      for (const path of ['b.md', 'Guides 2/x.md', 'a/b/c.txt', 'Guides/Orion.md', 'Guides/Moon phases.md']) await store.write(path, path);
      await store.mkdir('Empty');
      assertEqual(
        await listed(store),
        ['Empty/', 'Guides/', 'Guides/Moon phases.md', 'Guides/Orion.md', 'Guides 2/', 'Guides 2/x.md', 'a/', 'a/b/', 'a/b/c.txt', 'b.md'],
        'list() order',
      );
      const entries = await store.list();
      assertEqual(shape(entries.find((entry) => entry.path === 'a/b/c.txt') ?? null), { path: 'a/b/c.txt', name: 'c.txt', type: 'file', size: 9 }, 'a listed file');
      assertEqual(shape(entries.find((entry) => entry.path === 'a/b') ?? null), { path: 'a/b', name: 'b', type: 'dir' }, 'a listed folder');
    },
  },
  {
    name: "hides the project's .nebula folder from list, but reaches it by path",
    async run(store) {
      await store.write('.nebula/project.json', '{"name":"Night Sky"}');
      await store.write('note.md', 'note');
      await store.write('Guides/.nebula/kept.md', 'only the root .nebula is hidden');
      assertEqual(await listed(store), ['Guides/', 'Guides/.nebula/', 'Guides/.nebula/kept.md', 'note.md'], 'list() with .nebula');
      assert((await store.readText('.nebula/project.json')) === '{"name":"Night Sky"}', '.nebula/project.json reads back');
      assertEqual(shape(await store.stat('.nebula')), { path: '.nebula', name: '.nebula', type: 'dir' }, 'stat of .nebula');
    },
  },
  {
    name: 'creates missing parent folders when writing',
    async run(store) {
      await store.write('a/b/c/d.txt', 'deep');
      assertEqual(await listed(store), ['a/', 'a/b/', 'a/b/c/', 'a/b/c/d.txt'], 'list() after a deep write');
      assert((await store.readText('a/b/c/d.txt')) === 'deep', 'the deep file reads back');
    },
  },
  {
    name: 'replaces the whole file when writing again, leaving nothing else behind',
    async run(store) {
      await store.write('n.md', 'the first version, which is longer');
      await store.write('n.md', 'second');
      assert((await store.readText('n.md')) === 'second', 'the second write wins');
      assertEqual((await store.stat('n.md'))?.size, 6, 'size after replacing');
      await store.write('n.md', new Blob([new Uint8Array([1, 2, 3])]));
      assertEqual(Array.from(await blobToBytes(await store.readBlob('n.md'))), [1, 2, 3], 'a blob replaces text');
      assertEqual(await listed(store), ['n.md'], 'no temporary files are left');
    },
  },
  {
    name: 'never shows a reader a half-written file',
    async run(store) {
      const before = 'a'.repeat(600_000);
      const after = 'b'.repeat(700_000);
      await store.write('big.txt', before);
      for (let round = 0; round < 3; round += 1) {
        const next = round % 2 === 0 ? after : before;
        const writing = store.write('big.txt', next);
        const reading = store.readText('big.txt');
        const [seen] = await Promise.all([reading, writing]);
        assert(seen === before || seen === after, `a read during a write saw ${seen.length} characters: a mix of versions`);
        assert((await store.readText('big.txt')) === next, 'the write completed');
      }
    },
  },
  {
    name: 'refuses to write over a folder or through a file',
    async run(store) {
      await store.mkdir('Guides');
      await store.write('README.md', 'readme');
      await assertRejects(() => store.write('Guides', 'x'), null, 'write over a folder');
      await assertRejects(() => store.write('README.md/child.txt', 'x'), null, 'write through a file');
      assertEqual(await listed(store), ['Guides/', 'README.md'], 'nothing changed');
      assert((await store.readText('README.md')) === 'readme', 'README.md is intact');
    },
  },
  {
    name: 'creates folders with their parents, accepts an existing folder, refuses a file',
    async run(store) {
      await store.mkdir('a/b');
      assertEqual(await listed(store), ['a/', 'a/b/'], 'list() after mkdir');
      await store.mkdir('a/b');
      await store.mkdir('a');
      assertEqual(await listed(store), ['a/', 'a/b/'], 'mkdir of an existing folder changes nothing');
      await store.write('a/file.md', 'x');
      await assertRejects(() => store.mkdir('a/file.md'), null, 'mkdir over a file');
      assert((await store.readText('a/file.md')) === 'x', 'the file survives');
    },
  },
  {
    name: 'renames a file, creating the folders it moves into',
    async run(store) {
      await store.write('Guides/Orion.md', 'Orion');
      await store.rename('Guides/Orion.md', 'Constellations/Winter/Orion.md');
      assert((await store.readText('Constellations/Winter/Orion.md')) === 'Orion', 'the content moved');
      assertEqual(await store.stat('Guides/Orion.md'), null, 'the old path is gone');
      assertEqual(await listed(store), ['Constellations/', 'Constellations/Winter/', 'Constellations/Winter/Orion.md', 'Guides/'], 'list() after rename');
      await store.rename('Constellations/Winter/Orion.md', 'Orion 2.md');
      assert((await store.readText('Orion 2.md')) === 'Orion', 'renamed again, to the root');
    },
  },
  {
    name: 'renames a folder with everything in it',
    async run(store) {
      await store.write('Guides/a.md', 'A');
      await store.write('Guides/sub/b.bin', new Blob([new Uint8Array([0, 255, 7])]));
      await store.mkdir('Guides/empty');
      await store.write('Guidesbook.md', 'not inside Guides');
      await store.rename('Guides', 'Notes/Guides');
      assertEqual(
        await listed(store),
        ['Guidesbook.md', 'Notes/', 'Notes/Guides/', 'Notes/Guides/a.md', 'Notes/Guides/empty/', 'Notes/Guides/sub/', 'Notes/Guides/sub/b.bin'],
        'list() after renaming a folder',
      );
      assert((await store.readText('Notes/Guides/a.md')) === 'A', 'a.md moved');
      assertEqual(Array.from(await blobToBytes(await store.readBlob('Notes/Guides/sub/b.bin'))), [0, 255, 7], 'b.bin moved intact');
      assertEqual(await store.stat('Guides'), null, 'the old folder is gone');
    },
  },
  {
    // New names are checked by newNameProblem() (review finding 22); files
    // that already have such names, from an older build or an unpacked zip,
    // must still work.
    name: 'keeps names a new file may not have: they list, open, rename and delete',
    async run(store) {
      const names = ['CON.txt', 'Plans: phase 1?.md', 'notes.', 'trailing ', 'report\u202Efdp.md', 'a\u2028b.md', 'pipe|star*.md', 'lt<gt>"q".md'];
      for (const name of names) await store.write(name, `contents of ${name}`);
      await store.write('Aux/inside.md', 'in a folder named like a device');

      assertEqual((await store.list()).map((entry) => entry.path), [...names, 'Aux', 'Aux/inside.md'].sort(comparePaths), 'list() shows every name');
      for (const name of names) assert((await store.readText(name)) === `contents of ${name}`, `${JSON.stringify(name)} opens`);
      await store.rename('CON.txt', 'Console.txt');
      await store.rename('notes.', 'notes');
      await store.rename('Aux', 'Auxiliary');
      assert((await store.readText('Console.txt')) === 'contents of CON.txt', 'CON.txt renamed');
      assert((await store.readText('Auxiliary/inside.md')) === 'in a folder named like a device', 'Aux renamed');
      for (const name of ['Console.txt', 'notes', 'trailing ', 'report\u202Efdp.md', 'a\u2028b.md', 'pipe|star*.md', 'lt<gt>"q".md', 'Plans: phase 1?.md', 'Auxiliary']) await store.remove(name);
      assertEqual((await store.list()).map((entry) => entry.path), [], 'everything deleted');
    },
  },
  {
    name: 'renames a folder only once a write in flight inside it has landed',
    async run(store) {
      await store.write('Old/c.md', 'v1');
      const v2 = inFlight('v2');
      const writing = store.write('Old/c.md', v2);
      const renaming = store.rename('Old', 'New');
      await Promise.all([writing, renaming]);
      assertEqual(await listed(store), ['New/', 'New/c.md'], 'list() after renaming the folder: nothing came back at the old path');
      assert((await store.readText('New/c.md')) === v2, 'the write in flight moved with its folder');
    },
  },
  {
    name: 'renames a file only once a write in flight to it has landed',
    async run(store) {
      await store.write('c.md', 'v1');
      await store.mkdir('Old');
      const v2 = inFlight('v2');
      const writing = store.write('c.md', v2);
      const renaming = store.rename('c.md', 'd.md');
      const fresh = inFlight('new file');
      const creating = store.write('Old/new.md', fresh);
      const moving = store.rename('Old', 'New');
      await Promise.all([writing, renaming, creating, moving]);
      assertEqual(await listed(store), ['New/', 'New/new.md', 'd.md'], 'list() after the renames');
      assert((await store.readText('d.md')) === v2, 'the write in flight landed before the rename');
      assert((await store.readText('New/new.md')) === fresh, 'a new file in flight moved with its folder');
    },
  },
  {
    name: 'applies a write made during a rename after the rename, at the path it names',
    async run(store) {
      await store.write('Old/c.md', 'v1');
      await store.write('Old/sub/d.md', 'd');
      const renaming = store.rename('Old', 'New');
      const writing = store.write('Old/c.md', 'v2');
      await Promise.all([renaming, writing]);
      assertEqual(await listed(store), ['New/', 'New/c.md', 'New/sub/', 'New/sub/d.md', 'Old/', 'Old/c.md'], 'list() after the rename and the write');
      assert((await store.readText('New/c.md')) === 'v1', 'the rename moved the file as it was');
      assert((await store.readText('Old/c.md')) === 'v2', 'the later write made a new file at its own path');
    },
  },
  {
    name: 'removes a folder only once a write in flight inside it has landed, so nothing comes back',
    async run(store) {
      await store.write('Old/c.md', 'v1');
      await store.write('Kept.md', 'kept');
      const writing = store.write('Old/c.md', inFlight('v2'));
      const creating = store.write('Old/Deeper/new.md', inFlight('new'));
      const removing = store.remove('Old');
      await Promise.all([writing, creating, removing]);
      assertEqual(await listed(store), ['Kept.md'], 'list() after removing the folder');
      assertEqual(await store.stat('Old'), null, 'the folder stays removed');
    },
  },
  {
    name: 'removes a file only once a write in flight to it has landed',
    async run(store) {
      await store.write('c.md', 'v1');
      const writing = store.write('c.md', inFlight('v2'));
      const creating = store.write('new.md', inFlight('new'));
      const removing = store.remove('c.md');
      const removingNew = store.remove('new.md');
      await Promise.all([writing, creating, removing, removingNew]);
      assertEqual(await listed(store), [], 'list() after removing both files');
    },
  },
  {
    name: 'writes new files at paths it removed or renamed away itself, making their folders again',
    async run(store) {
      // Upload a folder, delete it, upload it again; or rename it and reuse the name.
      await store.write('Gone/c.md', 'v1');
      await store.remove('Gone');
      await store.write('Gone/c.md', 'again');
      await store.write('Moved/c.md', 'v1');
      await store.rename('Moved', 'Elsewhere');
      await store.write('Moved/c.md', 'new');
      assertEqual(await listed(store), ['Elsewhere/', 'Elsewhere/c.md', 'Gone/', 'Gone/c.md', 'Moved/', 'Moved/c.md'], 'list()');
      assert((await store.readText('Gone/c.md')) === 'again', 'the file written again');
      assert((await store.readText('Moved/c.md')) === 'new', 'the new file at the old name');
      assert((await store.readText('Elsewhere/c.md')) === 'v1', 'the moved file as it was');
    },
  },
  {
    name: 'refuses an exclusive write where anything exists, and makes a new file with one',
    writeOptions: true,
    async run(store) {
      await store.write('a.md', 'A');
      await store.mkdir('F');
      await assertRejects(() => store.write('a.md', 'B', { exclusive: true }), 'FileExistsError', 'an exclusive write onto a file');
      await assertRejects(() => store.write('F', 'B', { exclusive: true }), 'FileExistsError', 'an exclusive write onto a folder');
      assert((await store.readText('a.md')) === 'A', 'the file as it was');
      await store.write('New/b.md', 'B', { exclusive: true });
      assert((await store.readText('New/b.md')) === 'B', 'a new file, folders and all');
      await store.write('a.md', 'A2', { exclusive: false });
      assert((await store.readText('a.md')) === 'A2', 'exclusive: false overwrites as before');
      assertEqual(await listed(store), ['F/', 'New/', 'New/b.md', 'a.md'], 'nothing else');
    },
  },
  {
    name: 'lets exactly one of two exclusive writes to one new path through',
    writeOptions: true,
    async run(store) {
      const results = await Promise.allSettled([
        store.write('c.md', inFlight('first'), { exclusive: true }),
        store.write('c.md', inFlight('second'), { exclusive: true }),
      ]);
      const won = results.flatMap((result, index) => (result.status === 'fulfilled' ? [index] : []));
      assertEqual(won.length, 1, 'writes that went through');
      const lost = results.find((result) => result.status === 'rejected');
      assert(lost && errorName(lost.reason) === 'FileExistsError', `the other fails as FileExistsError, got ${String(lost && lost.reason)}`);
      assert((await store.readText('c.md')) === inFlight(won[0] === 0 ? 'first' : 'second'), 'the file holds the write that went through');
    },
  },
  {
    name: 'writes with ifUnchanged only while the file holds exactly the text given, or nothing (round 5)',
    writeOptions: true,
    async run(store) {
      await store.write('a.md', 'v1');
      await store.write('a.md', 'v2', { ifUnchanged: { text: 'v1' } });
      assert((await store.readText('a.md')) === 'v2', 'the text expected: written');
      await assertRejects(() => store.write('a.md', 'v3', { ifUnchanged: { text: 'v1' } }), 'FileChangedError', 'an older text');
      await assertRejects(() => store.write('a.md', 'v3', { ifUnchanged: { text: 'v9' } }), 'FileChangedError', 'another text of the same size');
      await assertRejects(() => store.write('a.md', 'v3', { ifUnchanged: { text: 'v2 ' } }), 'FileChangedError', 'a longer text');
      await assertRejects(() => store.write('a.md', 'v3', { ifUnchanged: 'absent' }), 'FileChangedError', "'absent' onto a file");
      assert((await store.readText('a.md')) === 'v2', 'the file as it was after the refused writes');
      // Compared as bytes: multi-byte text, a byte-order mark and CRLF.
      await store.write('u.md', '\uFEFFé🌌\r\n');
      await store.write('u.md', 'next', { ifUnchanged: { text: '\uFEFFé🌌\r\n' } });
      await assertRejects(() => store.write('u.md', 'x', { ifUnchanged: { text: 'nexu' } }), 'FileChangedError', 'one byte different');
      // 'absent' creates, folders and all.
      await store.write('New/b.md', 'B', { ifUnchanged: 'absent' });
      assert((await store.readText('New/b.md')) === 'B', "'absent' where nothing is: written");
      // A text expected where nothing is: refused, and no folder made for it.
      await assertRejects(() => store.write('Gone/c.md', 'C', { ifUnchanged: { text: 'C0' } }), 'FileChangedError', 'a text expected where nothing is');
      await store.mkdir('F');
      await assertRejects(() => store.write('F', 'x', { ifUnchanged: { text: '' } }), 'FileChangedError', 'a text expected where a folder is');
      await assertRejects(() => store.write('F', 'x', { ifUnchanged: 'absent' }), 'FileChangedError', "'absent' onto a folder");
      assertEqual(await listed(store), ['F/', 'New/', 'New/b.md', 'a.md', 'u.md'], 'nothing else');
    },
  },
  {
    name: 'lets exactly one of two writes expecting the same text through, whatever their size and time (round 5)',
    writeOptions: true,
    async run(store) {
      // Same size, landing together: only the bytes tell them apart.
      await store.write('c.md', inFlight('base'));
      const results = await Promise.allSettled([
        store.write('c.md', inFlight('AAAA'), { ifUnchanged: { text: inFlight('base') } }),
        store.write('c.md', inFlight('BBBB'), { ifUnchanged: { text: inFlight('base') } }),
      ]);
      const won = results.flatMap((result, index) => (result.status === 'fulfilled' ? [index] : []));
      assertEqual(won.length, 1, 'writes that went through');
      const lost = results.find((result) => result.status === 'rejected');
      assert(lost && errorName(lost.reason) === 'FileChangedError', `the other fails as FileChangedError, got ${String(lost && lost.reason)}`);
      assert((await store.readText('c.md')) === inFlight(won[0] === 0 ? 'AAAA' : 'BBBB'), 'the file holds the write that went through');
      // One after the other, of one size, as fast as they go.
      await store.write('d.md', 'aaaa');
      await store.write('d.md', 'bbbb');
      await assertRejects(() => store.write('d.md', 'cccc', { ifUnchanged: { text: 'aaaa' } }), 'FileChangedError', 'a write expecting the text before the last');
      assert((await store.readText('d.md')) === 'bbbb', 'the last write kept');
    },
  },
  {
    name: 'refuses to rename onto anything that exists',
    async run(store) {
      await store.write('a.md', 'A');
      await store.write('b.md', 'B');
      await store.mkdir('F');
      await assertRejects(() => store.rename('a.md', 'b.md'), 'FileExistsError', 'file onto a file');
      await assertRejects(() => store.rename('a.md', 'F'), 'FileExistsError', 'file onto a folder');
      await assertRejects(() => store.rename('F', 'a.md'), 'FileExistsError', 'folder onto a file');
      await assertRejects(() => store.rename('a.md', 'a.md'), 'FileExistsError', 'onto itself');
      assertEqual(await listed(store), ['F/', 'a.md', 'b.md'], 'nothing moved');
      assert((await store.readText('a.md')) === 'A' && (await store.readText('b.md')) === 'B', 'contents unchanged');
    },
  },
  {
    name: 'refuses to rename what does not exist, or a folder into itself',
    async run(store) {
      await assertRejects(() => store.rename('missing.md', 'x.md'), 'NotFoundError', 'rename of a missing file');
      await store.write('F/inner.md', 'i');
      await assertRejects(() => store.rename('F', 'F/sub'), null, 'a folder into itself');
      assertEqual(await listed(store), ['F/', 'F/inner.md'], 'nothing moved');
    },
  },
  {
    name: 'removes a file',
    async run(store) {
      await store.write('Guides/a.md', 'A');
      await store.write('Guides/b.md', 'B');
      await store.remove('Guides/a.md');
      assertEqual(await listed(store), ['Guides/', 'Guides/b.md'], 'list() after remove');
      assertEqual(await store.stat('Guides/a.md'), null, 'stat after remove');
    },
  },
  {
    name: 'removes a folder and everything in it',
    async run(store) {
      await store.write('Guides/a.md', 'A');
      await store.write('Guides/sub/b.md', 'B');
      await store.write('Guidesbook.md', 'stays');
      await store.remove('Guides');
      assertEqual(await listed(store), ['Guidesbook.md'], 'list() after removing a folder');
      await assertRejects(() => store.readText('Guides/sub/b.md'), 'NotFoundError', 'a removed file');
    },
  },
  {
    name: 'rejects reading or removing what does not exist, and reading a folder',
    async run(store) {
      await assertRejects(() => store.readText('missing.md'), 'NotFoundError', 'readText of a missing file');
      await assertRejects(() => store.readBlob('missing.md'), 'NotFoundError', 'readBlob of a missing file');
      await assertRejects(() => store.readText('Nowhere/missing.md'), 'NotFoundError', 'readText under a missing folder');
      await assertRejects(() => store.remove('missing.md'), 'NotFoundError', 'remove of a missing file');
      await store.mkdir('Guides');
      await assertRejects(() => store.readText('Guides'), null, 'readText of a folder');
    },
  },
  {
    name: 'tells watchers about each change, once, as it completes',
    async run(store) {
      const changes: FileChange[] = [];
      const stop = store.watch((change) => changes.push(change));
      try {
        await store.write('a.md', 'A');
        assertEqual(changes, [{ type: 'write', path: 'a.md' }], 'after write');
        await store.write('Deep/er/b.md', 'B');
        assertEqual(changes.at(-1), { type: 'write', path: 'Deep/er/b.md' }, 'a write that creates folders');
        assertEqual(changes.length, 2, 'one event for a write that creates folders');
        await store.mkdir('F');
        assertEqual(changes.at(-1), { type: 'mkdir', path: 'F' }, 'after mkdir');
        await store.mkdir('F');
        assertEqual(changes.length, 3, 'mkdir of an existing folder is no change');
        await store.rename('a.md', 'F/a.md');
        assertEqual(changes.at(-1), { type: 'rename', from: 'a.md', to: 'F/a.md' }, 'after rename');
        await assertRejects(() => store.rename('F/a.md', 'Deep'), 'FileExistsError', 'a refused rename');
        assertEqual(changes.length, 4, 'a refused rename is no change');
        await store.remove('F');
        assertEqual(changes.at(-1), { type: 'remove', path: 'F' }, 'after remove');
        assertEqual(changes.length, 5, 'one event per change');
      } finally {
        stop();
      }
    },
  },
  {
    name: 'stops telling a watcher once it unsubscribes',
    async run(store) {
      const first: FileChange[] = [];
      const second: FileChange[] = [];
      const stopFirst = store.watch((change) => first.push(change));
      const stopSecond = store.watch((change) => second.push(change));
      await store.write('a.md', 'A');
      stopFirst();
      stopFirst();
      await store.write('b.md', 'B');
      assertEqual(first, [{ type: 'write', path: 'a.md' }], 'the unsubscribed watcher');
      assertEqual(second, [{ type: 'write', path: 'a.md' }, { type: 'write', path: 'b.md' }], 'the other watcher');
      stopSecond();
    },
  },
  {
    name: 'tells watchers about a write in flight before the rename that waited for it',
    async run(store) {
      await store.write('Old/c.md', 'v1');
      const changes: FileChange[] = [];
      const stop = store.watch((change) => changes.push(change));
      try {
        await Promise.all([store.write('Old/c.md', inFlight('v2')), store.rename('Old', 'New')]);
        assertEqual(changes, [{ type: 'write', path: 'Old/c.md' }, { type: 'rename', from: 'Old', to: 'New' }], 'the write, then the rename');
      } finally {
        stop();
      }
    },
  },
  {
    name: 'rejects invalid paths in every method, changing nothing',
    async run(store) {
      await store.write('ok.md', 'ok');
      const invalid = ['', '/abs.md', '../up.md', 'a//b.md', 'a\\b.md', 'a/./b.md', 'nul\u0000.md', 'trailing/'];
      for (const path of invalid) {
        const label = JSON.stringify(path);
        await assertRejects(() => store.stat(path), 'InvalidPathError', `stat(${label})`);
        await assertRejects(() => store.readText(path), 'InvalidPathError', `readText(${label})`);
        await assertRejects(() => store.readBlob(path), 'InvalidPathError', `readBlob(${label})`);
        await assertRejects(() => store.write(path, 'x'), 'InvalidPathError', `write(${label})`);
        await assertRejects(() => store.mkdir(path), 'InvalidPathError', `mkdir(${label})`);
        await assertRejects(() => store.remove(path), 'InvalidPathError', `remove(${label})`);
        await assertRejects(() => store.rename(path, 'moved.md'), 'InvalidPathError', `rename(${label}, …)`);
        await assertRejects(() => store.rename('ok.md', path), 'InvalidPathError', `rename(…, ${label})`);
      }
      assertEqual(await listed(store), ['ok.md'], 'nothing changed');
    },
  },
];

/** The cases about write options (`exclusive`, `ifUnchanged`): run them
 * through every store wrapper, so one that drops an option is caught
 * (round 5, G4). */
export const writeOptionCases: ConformanceCase[] = fileStoreConformanceCases.filter((testCase) => testCase.writeOptions);

/** Two stores over the same files, as two tabs have: what one changes, the
 * other sees, but neither knows what the other has in flight. */
export type FileStoreTwinFactory = () => [FileStore, FileStore] | Promise<[FileStore, FileStore]>;

export type TwinConformanceCase = {
  name: string;
  run: (here: FileStore, there: FileStore) => Promise<void>;
};

/** What a store must do when another store (another tab) changes the files
 * under it (re-review R4). A write never brings back a folder that went: a
 * file this store has read or written, whose folder is gone, was removed or
 * moved by someone else, and the write fails as not found (the sessions treat
 * that as removed). Only the first write of a new file makes its folders. */
export const fileStoreTwinCases: TwinConformanceCase[] = [
  {
    name: 'sees what the other store writes, and its watchers hear it',
    async run(here, there) {
      const changes: FileChange[] = [];
      const stop = here.watch((change) => changes.push(change));
      try {
        await there.write('Guides/Orion.md', 'Betelgeuse');
        assert((await here.readText('Guides/Orion.md')) === 'Betelgeuse', 'read through the other store');
        assertEqual(await listed(here), ['Guides/', 'Guides/Orion.md'], 'list() through the other store');
        for (let tries = 0; tries < 50 && changes.length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        assertEqual(changes, [{ type: 'write', path: 'Guides/Orion.md' }], 'heard the other store');
      } finally {
        stop();
      }
    },
  },
  {
    name: 'fails a write to a file whose folder the other store removed, and brings nothing back',
    async run(here, there) {
      await here.write('Old/c.md', 'v1');
      await there.write('Kept.md', 'kept');
      await there.remove('Old');
      await assertRejects(() => here.write('Old/c.md', 'v2'), 'NotFoundError', 'the write after the remove');
      assertEqual(await listed(there), ['Kept.md'], 'list() after the remove and the write');
    },
  },
  {
    name: 'fails a write to a file whose folder the other store renamed, leaving nothing at the old path',
    async run(here, there) {
      await here.write('Sketches/Deep/c.md', 'v1');
      await there.rename('Sketches', 'Drawings');
      await assertRejects(() => here.write('Sketches/Deep/c.md', 'v2'), 'NotFoundError', 'the write after the rename');
      assertEqual(await listed(there), ['Drawings/', 'Drawings/Deep/', 'Drawings/Deep/c.md'], 'list() after the rename and the write');
      assert((await there.readText('Drawings/Deep/c.md')) === 'v1', 'the moved file as it was');
    },
  },
  {
    name: 'treats a file it has only read the same way',
    async run(here, there) {
      await there.write('Old/c.md', 'v1');
      assert((await here.readText('Old/c.md')) === 'v1', 'read it first');
      await there.remove('Old');
      await assertRejects(() => here.write('Old/c.md', 'v2'), 'NotFoundError', 'the write after the remove');
      assertEqual(await listed(there), [], 'nothing came back');
    },
  },
  {
    name: 'still makes the folders for the first write of a new file, where the other store removed them',
    async run(here, there) {
      await there.write('Old/c.md', 'v1');
      await there.remove('Old');
      await here.write('Old/new.md', 'new');
      assertEqual(await listed(there), ['Old/', 'Old/new.md'], 'the new file and its folder');
    },
  },
  {
    name: 'lets exactly one of two exclusive writes, one from each store, through',
    async run(here, there) {
      const results = await Promise.allSettled([
        here.write('Notes/n (conflict).md', inFlight('here'), { exclusive: true }),
        there.write('Notes/n (conflict).md', inFlight('there'), { exclusive: true }),
      ]);
      const won = results.flatMap((result, index) => (result.status === 'fulfilled' ? [index] : []));
      assertEqual(won.length, 1, 'writes that went through');
      const lost = results.find((result) => result.status === 'rejected');
      assert(lost && errorName(lost.reason) === 'FileExistsError', `the other fails as FileExistsError, got ${String(lost && lost.reason)}`);
      const text = await there.readText('Notes/n (conflict).md');
      assert(text === inFlight(won[0] === 0 ? 'here' : 'there'), 'the file holds the write that went through');
    },
  },
  {
    name: 'refuses an exclusive write onto a file the other store wrote',
    async run(here, there) {
      await there.write('a.md', 'theirs');
      await assertRejects(() => here.write('a.md', 'mine', { exclusive: true }), 'FileExistsError', 'the exclusive write');
      assert((await there.readText('a.md')) === 'theirs', 'their file as it was');
    },
  },
  {
    name: 'refuses a write expecting the text it saw once the other store changed the file (round 5)',
    async run(here, there) {
      await here.write('a.md', 'v1');
      await there.write('a.md', 'v2');
      await assertRejects(() => here.write('a.md', 'mine', { ifUnchanged: { text: 'v1' } }), 'FileChangedError', 'the write over their change');
      assert((await there.readText('a.md')) === 'v2', 'their change as it was');
      await here.write('a.md', 'mine', { ifUnchanged: { text: 'v2' } });
      assert((await there.readText('a.md')) === 'mine', 'a write expecting their text goes through');
    },
  },
  {
    name: 'lets exactly one of two writes expecting the same text, one from each store, through (round 5)',
    async run(here, there) {
      await here.write('Notes/n.md', inFlight('base'));
      assert((await there.readText('Notes/n.md')) === inFlight('base'), 'read it first');
      const results = await Promise.allSettled([
        here.write('Notes/n.md', inFlight('here'), { ifUnchanged: { text: inFlight('base') } }),
        there.write('Notes/n.md', inFlight('xxxx'), { ifUnchanged: { text: inFlight('base') } }),
      ]);
      const won = results.flatMap((result, index) => (result.status === 'fulfilled' ? [index] : []));
      assertEqual(won.length, 1, 'writes that went through');
      const lost = results.find((result) => result.status === 'rejected');
      assert(lost && errorName(lost.reason) === 'FileChangedError', `the other fails as FileChangedError, got ${String(lost && lost.reason)}`);
      assert((await there.readText('Notes/n.md')) === inFlight(won[0] === 0 ? 'here' : 'xxxx'), 'the file holds the write that went through');
    },
  },
];

/** Registers every twin case, under one describe block, with a test framework. */
export function registerFileStoreTwinConformance(api: TestApi, label: string, factory: FileStoreTwinFactory): void {
  api.describe(`${label} (FileStore conformance, two stores)`, () => {
    for (const testCase of fileStoreTwinCases) {
      api.it(testCase.name, async () => testCase.run(...(await factory())));
    }
  });
}

/** Registers every case, under one describe block, with a test framework. */
export function registerFileStoreConformance(api: TestApi, label: string, factory: FileStoreFactory): void {
  api.describe(`${label} (FileStore conformance)`, () => {
    for (const testCase of fileStoreConformanceCases) {
      api.it(testCase.name, async () => testCase.run(await factory()));
    }
  });
}

/** Runs every case in order, each on a fresh store, and reports instead of throwing. */
export async function runFileStoreConformance(
  factory: FileStoreFactory,
  cleanup?: (store: FileStore) => Promise<void> | void,
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  for (const testCase of fileStoreConformanceCases) {
    let store: FileStore | undefined;
    try {
      store = await factory();
      await testCase.run(store);
      results.push({ name: testCase.name, ok: true });
    } catch (error) {
      results.push({ name: testCase.name, ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    } finally {
      if (store && cleanup) await cleanup(store);
    }
  }
  return results;
}
