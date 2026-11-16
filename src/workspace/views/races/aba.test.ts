import { describe, expect, it } from 'vitest';
import { MemoryFileStore } from '../../../files/memoryStore';
import { createFileSceneStore, serialize } from '../canvas/fileSceneStore';
import { createTextSession } from '../shared/textSession';
import { doc, drawing, lateMessages, parse, REF, until } from './testkit';

/**
 * Where an ABA landing leaves the change (the sixth review's N5, its
 * aba.test.ts). Another tab renames the file and makes a new one with the
 * same bytes at the old path before this tab hears the rename: the content
 * precondition can't tell the two apart, so this tab's write lands in the
 * new file. The bytes it replaced are the ones it expected, so no one's work
 * is written over; the change is in the new file at the old path, in the
 * tree, and the session follows the rename and shows the renamed file.
 *
 * Round 7 wrote the change again at the renamed file when it held what the
 * last write replaced. The seventh review (R7-1) showed that another
 * writer's change back to exactly that text looks the same when it's heard
 * late or its read fails, and was written over; and no content check can
 * tell them apart (a new file at the old path holding exactly the change's
 * bytes passes any). So the re-check after a rename only looks. Closing ABA
 * landings needs a per-file identity in the write's precondition.
 */

describe('N5: an ABA landing leaves the change in the new file at the old path, and never writes over the renamed one', () => {
  it('note: the change lands in the new file at the old path; the renamed file is shown, never written over', async () => {
    const disk = new MemoryFileStore();
    await disk.write('Untitled.md', '');
    const late = lateMessages(disk.twin());
    const note = createTextSession(late.store, 'Untitled.md', { saveDelayMs: 2 ** 30, scope: 'n5-note' });
    await note.ready;
    const other = disk.twin();
    late.hold();
    await other.rename('Untitled.md', 'Ideas.md');
    await other.write('Untitled.md', '', { exclusive: true });
    note.edit('my first idea');
    await note.flush();
    // Landed in the new file: the bytes it replaced were the ones expected.
    expect(await disk.readText('Untitled.md')).toBe('my first idea');
    late.release();
    await until(() => note.getState().text === '', 300);
    await new Promise((r) => setTimeout(r, 50));
    await note.flush();
    const state = note.getState();
    await note.dispose();
    expect({ moved: await disk.readText('Ideas.md'), there: await disk.readText('Untitled.md') }).toEqual({ moved: '', there: 'my first idea' });
    expect({ shows: state.text, dirty: state.dirty, conflict: state.conflict }).toEqual({ shows: '', dirty: false, conflict: false });
  });

  it('canvas: the change lands in the new file at the old path; the renamed file is shown, never written over', async () => {
    const disk = new MemoryFileStore();
    const opened = serialize(null, drawing(100, 1), 'json');
    await disk.write('c.excalidraw', opened);
    const late = lateMessages(disk.twin());
    const canvas = createFileSceneStore({ store: late.store, path: 'c.excalidraw', intervalMs: 2 ** 30, scope: 'n5-canvas' });
    const loaded = await canvas.load(REF);
    await canvas.save(doc(loaded!.scene));
    const other = disk.twin();
    late.hold();
    await other.rename('c.excalidraw', 'r.excalidraw');
    await other.write('c.excalidraw', opened, { exclusive: true });
    await canvas.save(doc(drawing(300, 2)));
    await canvas.flush();
    expect(parse(await disk.readText('c.excalidraw')).elements[0].x).toBe(300);
    late.release();
    await until(() => canvas.getState().revision === 1, 300);
    await new Promise((r) => setTimeout(r, 50));
    await canvas.flush();
    const state = canvas.getState();
    await canvas.dispose();
    expect({ moved: parse(await disk.readText('r.excalidraw')).elements[0].x, there: parse(await disk.readText('c.excalidraw')).elements[0].x }).toEqual({ moved: 100, there: 300 });
    expect({ pending: state.pending, conflict: state.conflict, revision: state.revision }).toEqual({ pending: false, conflict: false, revision: 1 });
  });

  it('note: a change made elsewhere back to the text before this session’s write, then a rename, is shown, never written over', async () => {
    const disk = new MemoryFileStore();
    await disk.write('a.md', 'seed');
    const note = createTextSession(disk.twin(), 'a.md', { saveDelayMs: 2 ** 30, scope: 'n5-revert' });
    await note.ready;
    note.edit('mine');
    await note.flush();
    const other = disk.twin();
    await other.write('a.md', 'seed', { ifUnchanged: { text: 'mine' } });
    await other.rename('a.md', 'b.md');
    expect(await until(() => note.getState().text === 'seed')).toBe(true);
    await note.flush();
    const final = await disk.readText('b.md');
    await note.dispose();
    expect(final).toBe('seed');
  });
});

/**
 * secu review 7, R7-1: N5's rewrite takes "the renamed file holds what my last
 * write replaced" as an ABA landing. A change made elsewhere back to exactly
 * that text is the same picture when its write was heard but its read failed
 * (the file had moved by the time this tab read it: a tab that hears late, or
 * a rename made by the same flush that wrote the change). N2's rename
 * re-check exists for exactly that case; N5's rewrite then wrote over it.
 * Fixed by taking the rewrite out (see the top of this file).
 */
describe('R7-1: a change back to the old text whose read failed as the file moved', () => {
  it('note: the other tab’s change back to the old text survives the rename', async () => {
    const disk = new MemoryFileStore();
    await disk.write('a.md', 'seed');
    const late = lateMessages(disk.twin());
    const note = createTextSession(late.store, 'a.md', { saveDelayMs: 2 ** 30, scope: 'r71-note' });
    await note.ready;
    note.edit('seed plus a line');
    await note.flush();
    expect(await disk.readText('a.md')).toBe('seed plus a line');
    // The other tab took it, deleted the line again, and renamed the file.
    const other = disk.twin();
    late.hold();
    await other.write('a.md', 'seed', { ifUnchanged: { text: 'seed plus a line' } });
    await other.rename('a.md', 'b.md');
    // The write reaches this tab first; its read finds nothing at a.md.
    late.releaseOne();
    await new Promise((r) => setTimeout(r, 20));
    late.release();
    await until(() => note.getState().text === 'seed', 300);
    await new Promise((r) => setTimeout(r, 50));
    await note.flush();
    const final = await disk.readText('b.md');
    const state = note.getState();
    await note.dispose();
    expect({ final, shows: state.text, dirty: state.dirty, conflict: state.conflict }).toEqual({ final: 'seed', shows: 'seed', dirty: false, conflict: false });
  });

  it('canvas: the other tab’s drawing back to the old bytes survives the rename', async () => {
    const disk = new MemoryFileStore();
    const opened = serialize(null, drawing(100, 1), 'json');
    await disk.write('c.excalidraw', opened);
    const late = lateMessages(disk.twin());
    const canvas = createFileSceneStore({ store: late.store, path: 'c.excalidraw', intervalMs: 2 ** 30, scope: 'r71-canvas' });
    const loaded = await canvas.load(REF);
    await canvas.save(doc(loaded!.scene));
    await canvas.save(doc(drawing(300, 2)));
    await canvas.flush();
    const mine = await disk.readText('c.excalidraw');
    expect(parse(mine).elements[0].x).toBe(300);
    const other = disk.twin();
    late.hold();
    await other.write('c.excalidraw', opened, { ifUnchanged: { text: mine } });
    await other.rename('c.excalidraw', 'r.excalidraw');
    late.releaseOne();
    await new Promise((r) => setTimeout(r, 20));
    late.release();
    await new Promise((r) => setTimeout(r, 80));
    await canvas.flush();
    const final = parse(await disk.readText('r.excalidraw')).elements[0].x;
    const state = canvas.getState();
    await canvas.dispose();
    expect({ final, conflict: state.conflict }).toEqual({ final: 100, conflict: false });
  });
});

describe('R7-1, the mirror order: a rename, then a change back to the old text, both heard late', () => {
  it('note: the other tab’s change back to the old text survives', async () => {
    const disk = new MemoryFileStore();
    await disk.write('a.md', 'seed');
    const late = lateMessages(disk.twin());
    const note = createTextSession(late.store, 'a.md', { saveDelayMs: 2 ** 30, scope: 'r71m-note' });
    await note.ready;
    note.edit('seed plus a line');
    await note.flush();
    // The other tab took it, renamed the file, then deleted the line again,
    // all before this tab (frozen in the background, say) heard any of it.
    const other = disk.twin();
    late.hold();
    await other.rename('a.md', 'b.md');
    await other.write('b.md', 'seed', { ifUnchanged: { text: 'seed plus a line' } });
    late.release();
    await until(() => note.getState().text === 'seed', 300);
    await new Promise((r) => setTimeout(r, 50));
    await note.flush();
    const final = await disk.readText('b.md');
    const state = note.getState();
    await note.dispose();
    expect({ final, shows: state.text, dirty: state.dirty, conflict: state.conflict }).toEqual({ final: 'seed', shows: 'seed', dirty: false, conflict: false });
  });

  it('canvas: the other tab’s drawing back to the old bytes survives', async () => {
    const disk = new MemoryFileStore();
    const opened = serialize(null, drawing(100, 1), 'json');
    await disk.write('c.excalidraw', opened);
    const late = lateMessages(disk.twin());
    const canvas = createFileSceneStore({ store: late.store, path: 'c.excalidraw', intervalMs: 2 ** 30, scope: 'r71m-canvas' });
    const loaded = await canvas.load(REF);
    await canvas.save(doc(loaded!.scene));
    await canvas.save(doc(drawing(300, 2)));
    await canvas.flush();
    const mine = await disk.readText('c.excalidraw');
    const other = disk.twin();
    late.hold();
    await other.rename('c.excalidraw', 'r.excalidraw');
    await other.write('r.excalidraw', opened, { ifUnchanged: { text: mine } });
    late.release();
    await new Promise((r) => setTimeout(r, 80));
    await canvas.flush();
    const final = parse(await disk.readText('r.excalidraw')).elements[0].x;
    const state = canvas.getState();
    await canvas.dispose();
    expect({ final, conflict: state.conflict }).toEqual({ final: 100, conflict: false });
  });
});
