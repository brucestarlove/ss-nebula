import { history, undo } from '@codemirror/commands';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SEARCH_EVENT, type SearchRequest } from '../../../searchEvent';
import { modeExtensions, noteEditorSetup } from './setup';
import { tagsOn } from './tags';

// Tags in the Markdown source and in live preview: each `#tag` is marked as one (its name in `data-tag`), a
// Ctrl/⌘-click or Ctrl/⌘-Enter opens search for it, a plain click only places the cursor.

const range = Range.prototype as Range & { getClientRects?: () => DOMRectList; getBoundingClientRect?: () => DOMRect };
const had = { rects: range.getClientRects, box: range.getBoundingClientRect };
beforeAll(() => {
  range.getClientRects = () => [] as unknown as DOMRectList;
  range.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
});
afterAll(() => {
  range.getClientRects = had.rects;
  range.getBoundingClientRect = had.box;
});

const views: EditorView[] = [];
const searches: string[] = [];
const listener = (event: Event) => {
  searches.push((event as CustomEvent<SearchRequest>).detail.query);
  event.preventDefault();
};
beforeAll(() => window.addEventListener(SEARCH_EVENT, listener));
afterAll(() => window.removeEventListener(SEARCH_EVENT, listener));
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  searches.length = 0;
});

function stateOf(doc: string, source = true): EditorState {
  return EditorState.create({ doc, extensions: noteEditorSetup({ label: 'Note', readOnly: false, source }) });
}

function editor(doc: string, { source = true, cursor = 0 }: { source?: boolean; cursor?: number } = {}) {
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: noteEditorSetup({ label: 'Note', readOnly: false, source }) }) });
  views.push(view);
  return view;
}

const tagsIn = (doc: string) => tagsOn(stateOf(doc), 0, doc.length).map(({ tag }) => tag);

describe('which `#words` are tags', () => {
  it('finds a tag in prose, lowercased and without the #, nested tags whole', () => {
    expect(tagsIn('Saturday, after moonset. #October and #Project/Nebula.')).toEqual(['october', 'project/nebula']);
  });

  it('finds none in code, an address, a link, a wikilink, or a heading marker', () => {
    const doc = ['`#inline`', '', '```', '#fenced', '```', '', 'See https://example.com/page#anchor and [a link #label](https://example.com) and [[Note#Heading]].', '', '# Heading', '', 'Real: #real'].join('\n');
    expect(tagsIn(doc)).toEqual(['real']);
  });

  it('finds none in the front matter', () => {
    expect(tagsIn('---\ntags: [#a]\ncolour: #fff\n---\nBody #b')).toEqual(['b']);
  });

  it('gives where each is, so the mark covers the `#` and the name', () => {
    const doc = 'Words #tag more';
    const [found] = tagsOn(stateOf(doc), 0, doc.length);
    expect(doc.slice(found.from, found.to)).toBe('#tag');
  });
});

describe('in the editor', () => {
  it('marks each tag in the Markdown source with its name, and in live preview too', () => {
    for (const source of [true, false]) {
      const view = editor('A #one and `#no` and #Two', { source });
      const marks = [...view.dom.querySelectorAll<HTMLElement>('.ws-cm-tag')];
      expect(marks.map((mark) => mark.dataset.tag), source ? 'source' : 'live').toEqual(['one', 'two']);
      view.destroy();
      views.pop();
    }
  });

  it('opens search for the tag on a Ctrl-click or ⌘-click, and not on a plain click', () => {
    const view = editor('A #Orion tonight');
    const mark = view.dom.querySelector<HTMLElement>('.ws-cm-tag')!;
    const down = (init: MouseEventInit) => mark.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init }));
    down({});
    expect(searches).toEqual([]);
    down({ ctrlKey: true });
    expect(searches).toEqual(['#orion']);
    down({ metaKey: true });
    expect(searches).toEqual(['#orion', '#orion']);
    // A modified click elsewhere in the text does nothing of the kind.
    view.dom.querySelector<HTMLElement>('.cm-line')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
    expect(searches).toHaveLength(2);
  });

  it('opens search for the tag under the cursor on Ctrl-Enter, and for no other place', () => {
    const doc = 'A #Orion tonight';
    const press = (view: EditorView) => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    press(editor(doc, { cursor: doc.indexOf('Orion') + 2 }));
    expect(searches).toEqual(['#orion']);
    press(editor(doc, { cursor: 0 }));
    expect(searches).toEqual(['#orion']);
  });

  it('keeps the editor, its undo and its selection when the mode switches, the tags marked in both', () => {
    const mode = new Compartment();
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: 'A #one', selection: { anchor: 3 }, extensions: [history(), noteEditorSetup({ label: 'Note', readOnly: false, source: false, mode })] }),
    });
    views.push(view);
    view.dispatch({ changes: { from: 6, insert: ' #two' } });
    expect([...view.dom.querySelectorAll<HTMLElement>('.ws-cm-tag')].map((mark) => mark.dataset.tag)).toEqual(['one', 'two']);
    for (const source of [true, false]) {
      view.dispatch({ effects: mode.reconfigure(modeExtensions(source)) });
      expect([...view.dom.querySelectorAll<HTMLElement>('.ws-cm-tag')].map((mark) => mark.dataset.tag), source ? 'source' : 'live').toEqual(['one', 'two']);
      expect(view.state.selection.main.head).toBe(3);
      expect(view.state.doc.toString()).toBe('A #one #two');
    }
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('A #one');
  });
});
