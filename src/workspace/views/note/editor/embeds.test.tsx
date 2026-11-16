import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore } from '../../../../../e2e/harness/views-store';
import type { FileEntry, FileStore } from '../../../../files/types';
import { waitFor } from '../../testing/render';
import { editorEmbeds, embedDecorations, embedLines, flushParkedEmbeds, heldEmbedLines, type EmbedLine } from './embeds';
import { projectLinksFacet, type EditorLinks } from './projectLinks';
import { noteEditorSetup } from './setup';
import { wikilinkSyntax } from './wikilinks';

// Embeds drawn in the editor (part 2, task 3): the reading lane's components
// in block widgets, in place of the lines that hold only an embed, while no
// cursor is on them.

vi.mock('../embeds/canvasSvg', () => ({
  renderCanvasSvg: vi.fn(async () => new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'], { type: 'image/svg+xml' })),
}));

const PLAN = 'Guides/Observing plan.md';
const PNG = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

const DOC = [
  '---', //                                     1
  'cover: ![[Sky.png]]', //                      2
  '---', //                                     3
  'Words first.', //                            4
  '', //                                        5
  '![[Sky.png|300]]', //                        6
  '', //                                        7
  '![[Winter hexagon.excalidraw]]', //          8
  '', //                                        9
  '![[Orion]]', //                              10
  '', //                                        11
  '![A chart](../Charts/chart.png)', //         12
  '', //                                        13
  'See ![[Sky.png]] in a line.', //            14
  '![web](https://example.com/a.png)', //       15
  '', //                                        16
  '```', //                                     17
  '![[Sky.png]]', //                            18
  '```', //                                     19
  '', //                                        20
  '![[Nowhere.png]]', //                        21
  '', //                                        22
  '- An item', //                               23
  '  ![[Sky.png]]', //                          24
  '', //                                        25
  'Last line.', //                              26
].join('\n');

const entry = (path: string, data: string | Blob): FileEntry => ({ path, name: path.split('/').pop()!, type: 'file', size: typeof data === 'string' ? data.length : data.size, modified: 1 });

let store: FileStore;
let readBlobs: string[];
let made: number;

function linksFor(overrides: Partial<EditorLinks> = {}): EditorLinks {
  const files: Record<string, string | Blob> = {
    [PLAN]: DOC,
    'Guides/Sky.png': PNG(),
    'Winter hexagon.excalidraw.md': '---\nexcalidraw-plugin: parsed\n---\n',
    'Orion.md': '# Orion\n\nThe hunter, **bright** in winter.\n',
    'Charts/chart.png': PNG(),
  };
  store = createMemoryFileStore(files);
  const readBlob = store.readBlob.bind(store);
  store.readBlob = async (target) => {
    readBlobs.push(target);
    return readBlob(target);
  };
  return { files: Object.entries(files).map(([path, data]) => entry(path, data)), open: vi.fn(), create: vi.fn(), path: PLAN, store, projectId: 'p', ...overrides };
}

function stateOf(doc: string, selection: EditorSelection | number = 0, links = linksFor()) {
  const state = EditorState.create({
    doc,
    selection: typeof selection === 'number' ? EditorSelection.cursor(selection) : selection,
    extensions: [markdown({ base: markdownLanguage, extensions: wikilinkSyntax }), projectLinksFacet.of(links), editorEmbeds],
  });
  ensureSyntaxTree(state, state.doc.length, 5_000);
  // The whole parse, in the state's own tree (and every field that reads it), as a busy machine may not have it yet.
  return state.update({}).state;
}

const lineOf = (state: EditorState, n: number) => state.doc.line(n);

/** The line numbers drawn as widgets. */
function drawn(state: EditorState): number[] {
  const out: number[] = [];
  for (const iter = embedDecorations(state).iter(); iter.value; iter.next()) {
    expect(iter.value.spec.block).toBe(true);
    out.push(state.doc.lineAt(iter.from).number);
    expect(iter.to).toBe(state.doc.lineAt(iter.from).to);
  }
  return out;
}

const range = Range.prototype as Range & { getClientRects?: unknown; getBoundingClientRect?: unknown };
const jsdomRange = { rects: range.getClientRects, box: range.getBoundingClientRect };

beforeEach(() => {
  // jsdom has no layout; CodeMirror measures text around block widgets.
  range.getClientRects = () => [] as unknown as DOMRectList;
  range.getBoundingClientRect = () => new DOMRect();
  readBlobs = [];
  made = 0;
  URL.createObjectURL = vi.fn(() => `blob:test/${(made += 1)}`);
  URL.revokeObjectURL = vi.fn();
});

describe('embeds in the editor: which lines', () => {
  it('finds the lines that hold only an embed: ![[…]] or a project image; not in a line of words, a fence, a list item, front matter, or from the web', () => {
    const state = stateOf(DOC);
    expect(embedLines(state).map((line: EmbedLine) => [state.doc.lineAt(line.from).number, line.kind])).toEqual([
      [6, 'wiki'],
      [8, 'wiki'],
      [10, 'wiki'],
      [12, 'image'],
      [21, 'wiki'],
    ]);
  });

  it('draws each as a block widget over its line, and shows the source of the line a cursor is on', () => {
    expect(drawn(stateOf(DOC, 0))).toEqual([6, 8, 10, 12, 21]);
    const state = stateOf(DOC, 0);
    expect(drawn(stateOf(DOC, lineOf(state, 8).from))).toEqual([6, 10, 12, 21]);
    expect(drawn(stateOf(DOC, lineOf(state, 8).to))).toEqual([6, 10, 12, 21]);
    // A selection running through an embed keeps it drawn; one that ends on its line shows the source.
    expect(drawn(stateOf(DOC, EditorSelection.single(lineOf(state, 4).from, lineOf(state, 9).from)))).toEqual([6, 8, 10, 12, 21]);
    expect(drawn(stateOf(DOC, EditorSelection.single(lineOf(state, 4).from, lineOf(state, 10).from + 2)))).toEqual([6, 8, 12, 21]);
  });

  it('keeps its lines right through edits, reading only the lines an edit touches (as a fresh reading finds them)', () => {
    let state = stateOf(DOC, 0);
    // A small seeded random walk of edits: inserts and deletes of embed lines, words and line breaks.
    let seed = 7;
    const random = () => {
      seed = (seed * 16_807) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    const pieces = ['![[Sky.png]]', '\n', 'words ', '![a](b.png)', '\n\n', ']', '![['];
    for (let step = 0; step < 200; step += 1) {
      const at = Math.floor(random() * (state.doc.length + 1));
      const change =
        random() < 0.6
          ? { from: at, insert: pieces[Math.floor(random() * pieces.length)] }
          : { from: at, to: Math.min(state.doc.length, at + 1 + Math.floor(random() * 6)) };
      state = state.update({ changes: change }).state;
      ensureSyntaxTree(state, state.doc.length, 5_000);
      state = state.update({}).state;
      const fresh = embedLines(state).map((line) => `${line.from}-${line.to} ${line.raw}`);
      expect(heldEmbedLines(state).map((line) => `${line.from}-${line.to} ${line.raw}`), `after edit ${step}`).toEqual(fresh);
    }
  });

  it('draws nothing where there is no store to read files from (an editor on its own)', () => {
    expect(drawn(stateOf(DOC, 0, { ...linksFor(), store: null }))).toEqual([]);
  });
});

describe('embeds in the editor: the widgets', () => {
  const views: EditorView[] = [];

  afterEach(async () => {
    range.getClientRects = jsdomRange.rects;
    range.getBoundingClientRect = jsdomRange.box;
    await act(async () => {
      for (const view of views.splice(0)) view.destroy();
      flushParkedEmbeds();
    });
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function editor(doc = DOC, cursor = 0, links = linksFor()) {
    const parent = document.body.appendChild(document.createElement('div'));
    let view!: EditorView;
    await act(async () => {
      view = new EditorView({
        parent,
        state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: [noteEditorSetup({ label: 'Plan', readOnly: false }), projectLinksFacet.of(links)] }),
      });
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
      view.dispatch({});
    });
    views.push(view);
    return { view, links };
  }

  it('draws a picture, a drawing, a note and a markdown image with the reading view’s own components', async () => {
    const { view } = await editor();
    const widgets = () => [...view.contentDOM.querySelectorAll<HTMLElement>('.ws-cm-embed')];
    await waitFor(() => expect(view.contentDOM.querySelectorAll('.ws-cm-embed img[src^="blob:"]').length).toBeGreaterThanOrEqual(2));
    const [sky, canvas, note, chart, nowhere] = widgets();
    expect(sky.querySelector('img')?.style.width).toBe('300px');
    expect(canvas.querySelector('.ws-embed-canvas')).not.toBeNull();
    await waitFor(() => expect(note.querySelector('.ws-embed-note')?.textContent).toContain('The hunter, bright in winter.'));
    // An embedded note is read only: its text is drawn, not edited.
    expect(note.querySelector('[contenteditable="true"]')).toBeNull();
    expect(chart.querySelector('img')?.alt).toBe('A chart');
    expect(nowhere.querySelector('.ws-embed-missing')?.textContent).toContain('Nowhere.png');
    expect(readBlobs.sort()).toEqual(['Charts/chart.png', 'Guides/Sky.png']);
  });

  it('opens the file on a click on the widget, and leaves the cursor where it was', async () => {
    const { view, links } = await editor();
    const before = view.state.selection.main.head;
    await waitFor(() => expect(view.contentDOM.querySelector('.ws-cm-embed img[src^="blob:"]')).not.toBeNull());
    const image = view.contentDOM.querySelector<HTMLElement>('.ws-cm-embed img')!;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    image.dispatchEvent(down);
    image.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(links.open).toHaveBeenCalledWith('Guides/Sky.png');
    expect(view.state.selection.main.head).toBe(before);
  });

  it('shows the source when the cursor comes onto the line, and draws it again when it leaves', async () => {
    const { view } = await editor();
    expect(view.contentDOM.querySelectorAll('.ws-cm-embed')).toHaveLength(5);
    await act(async () => view.dispatch({ selection: { anchor: view.state.doc.line(6).from } }));
    expect(view.contentDOM.querySelectorAll('.ws-cm-embed')).toHaveLength(4);
    expect([...view.contentDOM.querySelectorAll('.cm-line')].some((line) => line.textContent === '![[Sky.png|300]]')).toBe(true);
    await act(async () => view.dispatch({ selection: { anchor: 0 } }));
    expect(view.contentDOM.querySelectorAll('.ws-cm-embed')).toHaveLength(5);
  });

  it('keeps a picture it has read when the cursor passes over its line (no second read)', async () => {
    const { view } = await editor('Top\n\n![[Sky.png]]\n\nEnd');
    await waitFor(() => expect(view.contentDOM.querySelector('.ws-cm-embed img[src^="blob:"]')).not.toBeNull());
    await act(async () => view.dispatch({ selection: { anchor: view.state.doc.line(3).from } }));
    await act(async () => view.dispatch({ selection: { anchor: 0 } }));
    await waitFor(() => expect(view.contentDOM.querySelector('.ws-cm-embed img[src^="blob:"]')).not.toBeNull());
    expect(readBlobs).toEqual(['Guides/Sky.png']);
  });

  it('Backspace at the start of the line after a widget shows the embed’s source and deletes nothing', async () => {
    const doc = 'Top\n![[Sky.png]]\nNext';
    const { view } = await editor(doc, doc.indexOf('Next'));
    expect(view.contentDOM.querySelectorAll('.ws-cm-embed')).toHaveLength(1);
    await act(async () => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    });
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main.head).toBe(doc.indexOf('\nNext'));
    expect(view.contentDOM.querySelectorAll('.ws-cm-embed')).toHaveLength(0);
    // The next Backspace removes a character that can be seen.
    await act(async () => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    });
    expect(view.state.doc.toString()).toBe('Top\n![[Sky.png]\nNext');
  });

  it('ArrowDown from the line above a widget, and ArrowUp from the line below, put the cursor on its line in one move', async () => {
    const doc = 'Top\n![[Sky.png]]\nNext';
    const { view } = await editor(doc, 1);
    // jsdom has no layout: CodeMirror's own vertical motion is stood in for by the next line.
    view.moveVertically = (range, forward) => {
      const line = view.state.doc.lineAt(range.head);
      const next = forward ? Math.min(line.number + 2, view.state.doc.lines) : Math.max(line.number - 2, 1);
      return EditorSelection.cursor(view.state.doc.line(next).from);
    };
    await act(async () => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(view.state.selection.main.head).toBe(4);
    expect(view.contentDOM.querySelectorAll('.ws-cm-embed')).toHaveLength(0);
    await act(async () => view.dispatch({ selection: { anchor: doc.length } }));
    expect(view.contentDOM.querySelectorAll('.ws-cm-embed')).toHaveLength(1);
    await act(async () => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    });
    expect(view.state.selection.main.head).toBe(doc.indexOf('\nNext'));
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('Delete at the end of the line before a widget shows its source and deletes nothing', async () => {
    const doc = 'Top\n![[Sky.png]]\nNext';
    const { view } = await editor(doc, 3);
    await act(async () => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    });
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main.head).toBe(4);
  });

  it('lets go of every React root when the editor goes', async () => {
    const { view } = await editor('![[Orion]]\n\nEnd', 14);
    await waitFor(() => expect(view.contentDOM.querySelector('.ws-embed-note')).not.toBeNull());
    const widget = view.contentDOM.querySelector('.ws-cm-embed-body')!;
    await act(async () => {
      view.destroy();
      views.splice(views.indexOf(view), 1);
      flushParkedEmbeds();
    });
    expect(widget.childElementCount).toBe(0);
  });
});
