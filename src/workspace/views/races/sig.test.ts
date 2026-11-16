import { describe, expect, it } from 'vitest';
import { MemoryFileStore } from '../../../files/memoryStore';
import type { FileStore } from '../../../files/types';
import type { ExcalidrawScene } from '../../../nebula/excalidraw/scene';
import { createFileSceneStore, serialize, type FileSceneStore } from '../canvas/fileSceneStore';
import { createTextSession } from '../shared/textSession';
import { doc, el, lateMessages, parse, REF, scene, until } from './testkit';

/**
 * The sixth review's N1: the canvas told "the same drawing in other bytes"
 * from a real change by element ids and versions. Excalidraw raises a
 * version by one per change, so two tabs changing one element from the same
 * base reach the same version with different drawings; a tab then took the
 * other's change for its own without showing it, and its next edit wrote
 * over it unseen. A hand edit of the JSON did the same. (The reviewer's
 * sig.test.ts, its waits made waits for state.)
 */

async function openCanvas(store: FileStore, path: string, scope: string) {
  const canvas = createFileSceneStore({ store, path, intervalMs: 2 ** 30, scope });
  const loaded = await canvas.load(REF);
  await canvas.save(doc(loaded!.scene));
  return canvas;
}

/** What the canvas shows once it has dealt with a change: when it took the
 * file, it remounts and loads it, as the shell does. */
async function shown(canvas: FileSceneStore, before: ExcalidrawScene): Promise<ExcalidrawScene> {
  if (canvas.getState().revision === 0) return before;
  const loaded = await canvas.load(REF);
  await canvas.save(doc(loaded!.scene));
  return loaded!.scene;
}

const moveB = (drawn: ExcalidrawScene, x: number, nonce: number): ExcalidrawScene => ({
  ...drawn,
  elements: drawn.elements.map((element) => (element.id === 'b' ? { ...element, x, version: Number(element.version) + 1, versionNonce: nonce } : element)),
});

describe('N1: the canvas knows another writer’s drawing by its content, not its versions', () => {
  it('a tab neither takes another tab’s Keep mine for its own nor writes over it unseen, when both changed one element to the same version', async () => {
    const disk = new MemoryFileStore();
    const path = 'c.excalidraw';
    await disk.write(path, serialize(null, scene([el('a', 100, 1, 11), el('b', 500, 1, 12)]), 'json'));
    const a = await openCanvas(disk.twin(), path, 'n1-a');
    const late = lateMessages(disk.twin());
    const b = await openCanvas(late.store, path, 'n1-b');

    // Tab A moves `a` (version 1 to 2) and saves.
    late.hold();
    const mineA = scene([el('a', 200, 2, 21), el('b', 500, 1, 12)]);
    await a.save(doc(mineA));
    await a.flush();
    expect(parse(await disk.readText(path)).elements[0].x).toBe(200);

    // Tab B, not having heard yet, recolours `a` (also version 1 to 2): its
    // save finds A's change and asks. B chooses Keep mine.
    await b.save(doc(scene([el('a', 100, 2, 22, '#e03131'), el('b', 500, 1, 12)])));
    await b.flush();
    expect(b.getState().conflict).toBe(true);
    late.release();
    await b.keepMine();
    expect(parse(await disk.readText(path)).elements[0].strokeColor).toBe('#e03131');

    // A hears B's write: it takes it (nothing unsaved here) or asks.
    const dealt = await until(() => a.getState().revision > 0 || a.getState().conflict);
    const onScreen = await shown(a, mineA);
    // A moves `b`.
    await a.save(doc(moveB(onScreen, 600, 31)));
    await a.flush();
    const final = parse(await disk.readText(path));
    expect(dealt, 'A never showed B’s change nor asked').toBe(true);
    expect(final.elements[0].strokeColor === '#e03131' || a.getState().conflict, 'B’s Keep mine was overwritten unseen').toBe(true);
    await a.dispose();
    await b.dispose();
  });

  it('an edit of the drawing’s JSON by hand in another tab (Open as text) is neither taken for the canvas’s own nor written over unseen', async () => {
    const disk = new MemoryFileStore();
    const path = 'd.excalidraw';
    const opened = scene([el('a', 100, 1, 11), el('b', 500, 1, 12)]);
    await disk.write(path, serialize(null, opened, 'json'));
    const a = await openCanvas(disk.twin(), path, 'n1-a2');
    // Tab B opens the file as text and recolours `a` by hand: no version moves.
    const text = createTextSession(disk.twin(), path, { saveDelayMs: 2 ** 30, scope: 'n1-b2' });
    await text.ready;
    text.edit(text.getState().text.replace('"strokeColor": "#000000"', '"strokeColor": "#2f9e44"'));
    await text.flush();
    expect(parse(await disk.readText(path)).elements[0].strokeColor).toBe('#2f9e44');

    const dealt = await until(() => a.getState().revision > 0 || a.getState().conflict);
    const onScreen = await shown(a, opened);
    // Tab A moves `b`.
    await a.save(doc(moveB(onScreen, 650, 32)));
    await a.flush();
    const final = parse(await disk.readText(path));
    expect(dealt, 'A never showed the text edit nor asked').toBe(true);
    expect(final.elements[0].strokeColor === '#2f9e44' || a.getState().conflict, 'the text edit was overwritten unseen').toBe(true);
    await a.dispose();
    await text.dispose();
  });

  it('the same drawing in other bytes (another tab’s identical change, written in other spacing) is still taken as the canvas’s own', async () => {
    const disk = new MemoryFileStore();
    const path = 'e.excalidraw';
    const opened = scene([el('a', 100, 1, 11)]);
    await disk.write(path, serialize(null, opened, 'json'));
    const a = await openCanvas(disk.twin(), path, 'n1-a3');
    const other = disk.twin();
    // The same drawing, written compactly.
    const before = serialize(null, opened, 'json');
    await other.write(path, JSON.stringify(JSON.parse(before)), { ifUnchanged: { text: before } });
    // A's next edit goes over it without asking: nothing of anyone's changed.
    const moved = scene([el('a', 300, 2, 13)]);
    await a.save(doc(moved));
    await a.flush();
    expect(a.getState().conflict).toBe(false);
    expect(a.getState().revision).toBe(0);
    expect(parse(await disk.readText(path)).elements[0].x).toBe(300);
    await a.dispose();
  });
});
