// Round 4, F5 (heldHere) and F2 (download when the copy can't be written).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import hexagonText from '../../../../sketches/workspace/assets/winter-hexagon.excalidraw?raw';
import busText from '../../../../src/files/fixtures/obsidian/Edraw - Bus timetable.md?raw';
import { MemoryFileStore } from '../../../../src/files/memoryStore';
import { scopedStore } from '../../../../src/files/scopedStore';
import type { FileStore } from '../../../../src/files/types';
import { readObsidianExcalidrawMarkdown } from '../../../../src/nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawScene } from '../../../../src/nebula/excalidraw/scene';
import { createEmptyNebulaMetadata } from '../../../../src/nebula/excalidraw/metadata';
import { createFileSceneStore } from '../../../../src/workspace/views/canvas/fileSceneStore';
import { createTextSession } from '../../../../src/workspace/views/shared/textSession';
import { hasUnsavedChanges, holdWrites, subscribeKeptCopies, type KeptCopy } from '../../../../src/workspace/views/shared/fileSessions';

/** Kept from the reviewer's probes; prints nothing. */
const log = (...args: unknown[]): void => void args;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const doc = (s: ExcalidrawScene) => ({ type: 'starscape.nebula.excalidraw' as const, version: 1 as const, boardId: 'p', canvasId: 'x', name: 'x', updatedAt: '', scene: s, nebula: createEmptyNebulaMetadata() });
const bump = (s: ExcalidrawScene, x: number, dv: number): ExcalidrawScene => ({ ...s, elements: s.elements.map((e, i) => (i === 0 ? { ...e, x, version: Number(e.version ?? 1) + dv } : e)) });
const paths = async (store: FileStore) => (await store.list()).map((e) => e.path);
const bytes = (s: string) => new TextEncoder().encode(s).length;

let kept: KeptCopy[] = [];
let stop: () => void = () => {};
beforeEach(() => {
  kept = [];
  stop = subscribeKeptCopies((c) => kept.push(c));
});
afterEach(() => stop());

describe('F5: heldHere never keeps a change the user deleted here', () => {
  it('a folder deleted here (note pending in the save delay)', async () => {
    const disk = new MemoryFileStore();
    await disk.write('F/n.md', 'v1');
    const s = createTextSession(disk, 'F/n.md', { saveDelayMs: 1000, scope: 'f5a' });
    await s.ready;
    s.edit('typed');
    const release = await holdWrites('f5a', 'F', { flush: false });
    try { await disk.remove('F'); } finally { release(); }
    await s.dispose();
    expect(await paths(disk)).toEqual([]);
    expect(kept).toEqual([]);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('a canvas in a folder renamed here, then deleted here', async () => {
    const disk = new MemoryFileStore();
    await disk.write('F/c.excalidraw', hexagonText);
    const s = createFileSceneStore({ store: disk, path: 'F/c.excalidraw', intervalMs: 1000, scope: 'f5b' });
    const loaded = (await s.load({ boardId: 'p', canvasId: 'c' }))!;
    await s.save(doc(loaded.scene));
    let release = await holdWrites('f5b', 'F');
    try { await disk.rename('F', 'G'); } finally { release(); }
    await s.save(doc(bump(loaded.scene, 555, 3)));
    release = await holdWrites('f5b', 'G/c.excalidraw', { flush: false });
    try { await disk.remove('G/c.excalidraw'); } finally { release(); }
    await s.dispose();
    log('f5b files', await paths(disk));
    expect((await paths(disk)).filter((p) => p.includes('(conflict'))).toEqual([]);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('the project removed (scoped store: remove of "")', async () => {
    const root = new MemoryFileStore();
    await root.write('projects/p1/n.md', 'v1');
    const store = scopedStore(root, 'projects/p1');
    const s = createTextSession(store, 'n.md', { saveDelayMs: 1000, scope: 'f5c' });
    await s.ready;
    s.edit('typed');
    await root.twin().remove('projects/p1');
    await s.dispose();
    log('f5c root', await paths(root));
    expect((await paths(root)).filter((p) => p.startsWith('projects/p1'))).toEqual([]);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('two tabs delete the file at once: this tab, which deleted it, keeps nothing', async () => {
    const disk = new MemoryFileStore({ delay: (c) => (c.type === 'remove' ? wait(15) : undefined) });
    await disk.write('n.md', 'v1');
    const s = createTextSession(disk, 'n.md', { saveDelayMs: 1000, scope: 'f5d' });
    await s.ready;
    s.edit('typed');
    const release = await holdWrites('f5d', 'n.md', { flush: false });
    const other = disk.twin();
    const results = await Promise.allSettled([disk.remove('n.md'), other.remove('n.md')]);
    release();
    log('f5d results', results.map((r) => r.status));
    await s.dispose();
    expect(await paths(disk)).toEqual([]);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('deleted in another tab, .excalidraw JSON: the copy is valid JSON with the change', async () => {
    const disk = new MemoryFileStore();
    await disk.write('F/c.excalidraw', hexagonText);
    const s = createFileSceneStore({ store: disk, path: 'F/c.excalidraw', intervalMs: 1000, scope: 'f5e' });
    const loaded = (await s.load({ boardId: 'p', canvasId: 'c' }))!;
    await s.save(doc(loaded.scene));
    await s.save(doc(bump(loaded.scene, 555, 3)));
    await disk.twin().remove('F');
    expect(hasUnsavedChanges()).toBe(true);
    await s.dispose();
    const files = await paths(disk);
    log('f5e', files, kept);
    const copy = files.find((p) => p.includes('(conflict'))!;
    expect(copy).toMatch(/^F\/c \(conflict .*\)\.excalidraw$/);
    expect(JSON.parse(await disk.readText(copy)).elements[0].x).toBe(555);
    expect(kept.at(-1)).toMatchObject({ deleted: true, copy });
    expect(hasUnsavedChanges()).toBe(false);
  });
});

/** Refuses conflict copies, as a full store would; forwards every argument otherwise. */
function refusing(inner: FileStore): FileStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      if (prop === 'write') return async (...args: unknown[]) => {
        if (String(args[0]).includes('(conflict ')) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
      return (...args: unknown[]) => (v as (...a: unknown[]) => unknown).apply(target, args);
    },
  }) as FileStore;
}

describe('F2: a copy that cannot be written is offered as a download in the file\'s own format', () => {
  async function canvasFail(path: string, text: string, scope: string) {
    const disk = new MemoryFileStore();
    await disk.write(path, text);
    const s = createFileSceneStore({ store: refusing(disk), path, intervalMs: 1000, scope });
    const loaded = (await s.load({ boardId: 'p', canvasId: 'c' }))!;
    await s.save(doc(loaded.scene));
    await s.save(doc(bump(loaded.scene, 555, 3)));
    await disk.twin().remove(path);
    await s.dispose();
    const failed = kept.at(-1)!;
    if (failed.copy !== null) throw new Error('expected a failed copy');
    return { disk, failed };
  }

  it('.excalidraw.md (Obsidian envelope) keeps its envelope; unsaved until release', async () => {
    const long = 'Edraw ' + 'é'.repeat(115) + '.md'; // 6 + 230 + 3 = 239 bytes
    expect(bytes(long)).toBeLessThanOrEqual(255);
    const { failed } = await canvasFail(long, busText, 'f2a');
    log('f2a filename', failed.download.filename, bytes(failed.download.filename));
    expect(bytes(failed.download.filename)).toBeLessThanOrEqual(255);
    expect(failed.download.filename).toMatch(/ \(conflict \d{4}-\d\d-\d\d \d\d\.\d\d\)\.md$/);
    const head = (t: string) => t.slice(0, t.indexOf('# Excalidraw Data'));
    expect(head(failed.download.text)).toBe(head(busText));
    expect(readObsidianExcalidrawMarkdown(failed.download.text).elements[0].x).toBe(555);
    expect(hasUnsavedChanges()).toBe(true);
    failed.release();
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('.excalidraw stays JSON', async () => {
    const { failed } = await canvasFail('c.excalidraw', hexagonText, 'f2b');
    expect(failed.download.filename).toMatch(/^c \(conflict .*\)\.excalidraw$/);
    expect(JSON.parse(failed.download.text).elements[0].x).toBe(555);
    failed.release();
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('a CRLF note keeps CRLF', async () => {
    const disk = new MemoryFileStore();
    await disk.write('n.md', 'one\r\ntwo\r\n');
    const s = createTextSession(refusing(disk), 'n.md', { saveDelayMs: 1000, scope: 'f2c' });
    await s.ready;
    s.edit('one\ntwo\nthree\n');
    await disk.twin().write('n.md', 'theirs\r\n');
    await wait(5);
    await s.dispose();
    const failed = kept.at(-1)!;
    if (failed.copy !== null) throw new Error('expected a failed copy');
    expect(failed.download.text).toBe('one\r\ntwo\r\nthree\r\n');
    expect(hasUnsavedChanges()).toBe(true);
    failed.release();
    failed.release(); // twice is harmless
    expect(hasUnsavedChanges()).toBe(false);
  });
});
