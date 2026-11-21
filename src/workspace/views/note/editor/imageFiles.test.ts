import { history, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { createMemoryFileStore, type MemoryFileStore } from '../../../../../e2e/harness/views-store';
import type { FileEntry, FileStore } from '../../../../files/types';
import { blobBytes } from '../../../attachments';
import { FILE_DRAG_TYPE } from '../../../dragTypes';
import { slowWrites } from '../../testing/slowWrites';
import { imageFiles, type ImageFilesTarget } from './imageFiles';

// Images pasted or dropped into a note: each becomes a file in Attachments/ and a `![[link]]` where it went.
// Behaviour only: what the file holds, where the link lands, what is left to the editor, and when the status is told.

const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3];
const image = (name: string, bytes = PNG, type = 'image/png') => new File([new Uint8Array(bytes)], name, { type });

// jsdom has no layout: CodeMirror's measuring needs rectangles for a text range, and gets none.
const range = Range.prototype as Range & { getClientRects?: () => DOMRectList; getBoundingClientRect?: () => DOMRect };
const hadRange = { rects: range.getClientRects, box: range.getBoundingClientRect };
beforeAll(() => {
  range.getClientRects = () => [] as unknown as DOMRectList;
  range.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
});
afterAll(() => {
  range.getClientRects = hadRange.rects;
  range.getBoundingClientRect = hadRange.box;
});

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.useRealTimers();
});

type Options = { doc?: string; cursor?: number; store?: FileStore | null; files?: FileEntry[]; readOnly?: boolean; status?: Mock<(message: string) => void> };

function editor(options: Options = {}) {
  const status = options.status ?? vi.fn<(message: string) => void>();
  const target: ImageFilesTarget = { store: options.store === undefined ? createMemoryFileStore() : options.store, files: options.files ?? [], onStatus: status };
  const doc = options.doc ?? '';
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: { anchor: options.cursor ?? doc.length }, extensions: [history(), imageFiles(() => target), EditorState.readOnly.of(options.readOnly ?? false)] }),
  });
  views.push(view);
  return { view, status, target };
}

/** Sends an event through the editor's own handlers; true when the default was prevented (which CodeMirror's own paste does too, so it
 * says nothing about who took it: check the files and the document). */
function send(view: EditorView, type: 'paste' | 'drop', data: { files?: File[]; text?: string; tree?: string; at?: number }): boolean {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const transfer = {
    files: data.files ?? [],
    getData: (kind: string) => (kind === 'text/plain' ? (data.text ?? '') : kind === FILE_DRAG_TYPE ? (data.tree ?? '') : ''),
  };
  Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: transfer });
  if (type === 'drop') {
    Object.assign(event, { clientX: 1, clientY: 1 });
    view.posAtCoords = () => data.at ?? 0;
  }
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

const settle = async (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting.');
    await settle(5);
  }
}

const attachments = async (store: FileStore) => (await store.list()).filter((entry) => entry.type === 'file' && entry.path.startsWith('Attachments/')).map((entry) => entry.path).sort();
const bytesAt = async (store: FileStore, path: string) => Array.from(await blobBytes(await store.readBlob(path)));
const PASTED = /^Attachments\/Pasted image \d{14}\.png$/;

describe('pasting an image', () => {
  it('writes it as a pasted-image file and links it at the cursor, the cursor after it', async () => {
    const store = createMemoryFileStore();
    const { view, status } = editor({ doc: 'Before  after', cursor: 7, store });
    expect(send(view, 'paste', { files: [image('image.png')] })).toBe(true);
    await until(() => view.state.doc.toString() !== 'Before  after');
    const [path] = await attachments(store);
    expect(path).toMatch(PASTED);
    expect(await bytesAt(store, path)).toEqual(PNG);
    const name = path.slice('Attachments/'.length);
    expect(view.state.doc.toString()).toBe(`Before ![[${name}]] after`);
    expect(view.state.selection.main.head).toBe(`Before ![[${name}]]`.length);
    expect(status).not.toHaveBeenCalled();
  });

  it('is taken back by one undo', async () => {
    const { view } = editor({ doc: 'Text' });
    send(view, 'paste', { files: [image('image.png')] });
    await until(() => view.state.doc.length > 4);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('Text');
  });

  it('keeps a pasted file’s own name when it has one, and never writes over a file of that name', async () => {
    const store = createMemoryFileStore({ 'Attachments/Sky.png': new Blob([new Uint8Array([9, 9])]) });
    const { view } = editor({ store });
    send(view, 'paste', { files: [image('Sky.png')] });
    await until(() => view.state.doc.length > 0);
    expect(await bytesAt(store, 'Attachments/Sky.png')).toEqual([9, 9]);
    expect(await bytesAt(store, 'Attachments/Sky 2.png')).toEqual(PNG);
    expect(view.state.doc.toString()).toBe('![[Sky 2.png]]');
  });

  it('leaves a text-only paste to the editor', async () => {
    const store = createMemoryFileStore();
    const { view } = editor({ store });
    send(view, 'paste', { text: 'just words' });
    await settle();
    expect(await attachments(store)).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  it('pastes the text when the clipboard holds a picture of it too (a copied table), writing no file', async () => {
    const store = createMemoryFileStore();
    const { view } = editor({ store });
    send(view, 'paste', { files: [image('image.png')], text: 'a\tb\n1\t2' });
    await settle();
    expect(await attachments(store)).toEqual([]);
    expect(view.state.doc.toString()).not.toContain('![[');
  });

  it('pastes the image when the only text is the copied file’s own name', async () => {
    const store = createMemoryFileStore();
    const { view } = editor({ store });
    expect(send(view, 'paste', { files: [image('Sky.png')], text: 'Sky.png' })).toBe(true);
    await until(() => view.state.doc.length > 0);
    expect(await attachments(store)).toEqual(['Attachments/Sky.png']);
  });

  it('ignores a paste in a read-only editor', async () => {
    const store = createMemoryFileStore();
    const { view } = editor({ store, readOnly: true });
    send(view, 'paste', { files: [image('image.png')] });
    await settle();
    expect(await attachments(store)).toEqual([]);
    expect(view.state.doc.toString()).toBe('');
  });

  it('says there is nowhere to keep it, inserting nothing, when the editor has no store', async () => {
    const { view, status } = editor({ doc: 'Text', store: null });
    send(view, 'paste', { files: [image('image.png')] });
    await until(() => status.mock.calls.length > 0);
    expect(status).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe('Text');
  });
});

describe('dropping image files', () => {
  it('writes each under its own name, a free name when taken, `_` for what breaks a link, and links them one per line in the order dropped', async () => {
    const store = createMemoryFileStore({ 'Attachments/Sky.png': new Blob([new Uint8Array([9])]) });
    const { view } = editor({ doc: 'ab', store });
    expect(send(view, 'drop', { files: [image('Sky.png'), image('Sky #1.jpg', PNG, 'image/jpeg'), image('Moon.png')], at: 1 })).toBe(true);
    await until(() => view.state.doc.length > 2);
    expect(await attachments(store)).toEqual(['Attachments/Moon.png', 'Attachments/Sky 2.png', 'Attachments/Sky _1.jpg', 'Attachments/Sky.png']);
    expect(await bytesAt(store, 'Attachments/Sky.png')).toEqual([9]);
    expect(view.state.doc.toString()).toBe('a![[Sky 2.png]]\n![[Sky _1.jpg]]\n![[Moon.png]]b');
  });

  it('links a name shared with another folder’s file with its folder', async () => {
    const store = createMemoryFileStore({ 'Photos/Sky.png': new Blob([new Uint8Array([9])]) });
    const { view } = editor({ store });
    send(view, 'drop', { files: [image('Sky.png')] });
    await until(() => view.state.doc.length > 0);
    expect(await attachments(store)).toEqual(['Attachments/Sky.png']);
    expect(view.state.doc.toString()).toBe('![[Attachments/Sky.png]]');
  });

  it('leaves a non-image file dropped in to the editor', async () => {
    const store = createMemoryFileStore();
    const { view, status } = editor({ store });
    send(view, 'drop', { files: [new File([new Uint8Array([1])], 'Star chart.pdf', { type: 'application/pdf' })] });
    await settle();
    expect(await attachments(store)).toEqual([]);
    // Not ours to refuse: the image handler says nothing about a file it doesn't take.
    expect(status).not.toHaveBeenCalled();
  });

  it('ignores a drop in a read-only editor', async () => {
    const store = createMemoryFileStore();
    const { view } = editor({ store, readOnly: true });
    send(view, 'drop', { files: [image('Sky.png')] });
    await settle();
    expect(await attachments(store)).toEqual([]);
  });
});

describe('a file dragged from the file tree', () => {
  const files: FileEntry[] = [
    { path: 'Photos/Sky.png', name: 'Sky.png', type: 'file' },
    { path: 'Notes/Other.md', name: 'Other.md', type: 'file' },
    { path: 'Sketches/Map.excalidraw.md', name: 'Map.excalidraw.md', type: 'file' },
    { path: 'Charts/Star chart.pdf', name: 'Star chart.pdf', type: 'file' },
    { path: 'Photos', name: 'Photos', type: 'dir' },
  ];

  it('drops as a link to the file, in its shortest form, and copies nothing', async () => {
    const store = createMemoryFileStore();
    for (const [path, link] of [['Photos/Sky.png', '![[Sky.png]]'], ['Notes/Other.md', '[[Other]]'], ['Sketches/Map.excalidraw.md', '![[Map.excalidraw]]'], ['Charts/Star chart.pdf', '![[Star chart.pdf]]']] as const) {
      const { view } = editor({ doc: 'x', cursor: 1, store, files });
      expect(send(view, 'drop', { tree: path, at: 1 }), path).toBe(true);
      expect(view.state.doc.toString(), path).toBe(`x${link}`);
      expect(view.state.selection.main.head).toBe(1 + link.length);
    }
    expect(store.writes).toEqual([]);
  });

  it('uses the path when the name alone would be ambiguous', () => {
    const { view } = editor({ files: [...files, { path: 'Other/Sky.png', name: 'Sky.png', type: 'file' }] });
    send(view, 'drop', { tree: 'Photos/Sky.png' });
    expect(view.state.doc.toString()).toBe('![[Photos/Sky.png]]');
  });

  it('falls through for a folder, and for a path the project doesn’t hold', () => {
    const { view } = editor({ files });
    send(view, 'drop', { tree: 'Photos' });
    send(view, 'drop', { tree: 'Somewhere else/Sky.png' });
    // Left to the editor: nothing of ours (no link) goes in.
    expect(view.state.doc.toString()).not.toContain('![[');
    expect(view.state.doc.toString()).not.toContain('[[');
  });
});

describe('while the file is written', () => {
  it('keeps the editor usable: text typed before the point moves the link with it, and the link goes in once', async () => {
    const memory = createMemoryFileStore();
    const slow = slowWrites(memory);
    const { view } = editor({ doc: ' world', cursor: 0, store: memory });
    send(view, 'paste', { files: [image('a.png')] });
    await until(() => slow.waiting > 0);
    view.dispatch({ changes: { from: 0, insert: '>>> Hello' } });
    expect(view.state.doc.toString()).toBe('>>> Hello world');
    slow.release();
    await until(() => view.state.doc.toString().includes('![['));
    expect(view.state.doc.toString()).toBe('>>> Hello![[a.png]] world');
    await settle();
    expect(view.state.doc.toString().match(/!\[\[/g)).toHaveLength(1);
  });

  it('keeps the file, throws nothing and says nothing when the editor closed before the write finished', async () => {
    const memory = createMemoryFileStore();
    const slow = slowWrites(memory);
    const { view, status } = editor({ store: memory });
    send(view, 'paste', { files: [image('a.png')] });
    await until(() => slow.waiting > 0);
    view.destroy();
    slow.release();
    await until(() => memory.writes.length > 0);
    await settle();
    expect(await attachments(memory)).toEqual(['Attachments/a.png']);
    expect(status).not.toHaveBeenCalled();
  });

  it('names a failure when the editor closed and the write failed', async () => {
    const memory = createMemoryFileStore();
    const store: FileStore = { ...memory, write: async () => Promise.reject(new Error('The disk is full.')) };
    const { view, status } = editor({ store });
    send(view, 'paste', { files: [image('a.png')] });
    view.destroy();
    await until(() => status.mock.calls.length > 0);
    expect(status).toHaveBeenCalledTimes(1);
  });
});

describe('a write that fails', () => {
  const failingFor = (memory: MemoryFileStore, bad: (path: string) => boolean): FileStore => ({
    ...memory,
    write: async (path, data, options) => (bad(path) ? Promise.reject(new Error('The disk is full.')) : memory.write(path, data, options)),
  });

  it('inserts nothing, keeps what was typed meanwhile, and tells the status line once', async () => {
    const memory = createMemoryFileStore();
    const { view, status } = editor({ doc: 'Text', store: failingFor(memory, () => true) });
    send(view, 'paste', { files: [image('image.png'), image('b.png')] });
    view.dispatch({ changes: { from: 0, insert: 'Typed: ' } });
    await until(() => status.mock.calls.length > 0);
    await settle();
    expect(status).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe('Typed: Text');
    expect(memory.writes).toEqual([]);
  });

  it('doesn’t stop the other files: one failing leaves the rest written and linked', async () => {
    const memory = createMemoryFileStore();
    const { view, status } = editor({ store: failingFor(memory, (path) => path.endsWith('bad.png')) });
    send(view, 'drop', { files: [image('one.png'), image('bad.png'), image('two.png')] });
    await until(() => status.mock.calls.length > 0);
    expect(view.state.doc.toString()).toBe('![[one.png]]\n![[two.png]]');
    expect(await attachments(memory)).toEqual(['Attachments/one.png', 'Attachments/two.png']);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('refuses a type Nebula can’t keep, writing nothing and telling the status line', async () => {
    const store = createMemoryFileStore();
    const { view, status } = editor({ store });
    send(view, 'drop', { files: [image('Scan.tiff', PNG, 'image/tiff'), image('Photo.heic', PNG, 'image/heic')] });
    await until(() => status.mock.calls.length > 0);
    expect(status).toHaveBeenCalledTimes(1);
    expect(await attachments(store)).toEqual([]);
    expect(view.state.doc.toString()).toBe('');
  });
});
