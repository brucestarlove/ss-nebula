import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { FileEntry } from '../../../../files/types';
import { buildPreview } from './livePreview';
import { projectLinksFacet, type EditorLinks } from './projectLinks';
import { noteEditorSetup } from './setup';
import { followLink, shownParts, wikilinkSyntax, wikiNodeAt } from './wikilinks';

// Wikilinks and embeds in the editor (part 2, task 1). Decorations are read
// back as strings, as in livePreview.test.ts:
//   'hide 4-6 "[["'   'mark 6-11 ws-wikilink "Orion"'   'widget 11-12 separator'

const file = (path: string): FileEntry => ({ path, name: path.split('/').at(-1)!, type: 'file', size: 1, modified: 0 });
const FILES = ['Orion.md', 'Guides/Observing plan.md', 'Winter hexagon.excalidraw.md', 'Photos/Winter hexagon.png'].map(file);

function linksFor(overrides: Partial<EditorLinks> = {}): EditorLinks {
  return { files: FILES, open: vi.fn(), create: vi.fn(), path: 'Guides/Observing plan.md', store: null, projectId: '', ...overrides };
}

function stateOf(doc: string, selection: EditorSelection | number = doc.length, links: EditorLinks = linksFor()) {
  const state = EditorState.create({
    doc,
    selection: typeof selection === 'number' ? EditorSelection.cursor(selection) : selection,
    extensions: [markdown({ base: markdownLanguage, extensions: wikilinkSyntax }), projectLinksFacet.of(links)],
  });
  ensureSyntaxTree(state, state.doc.length, 5_000);
  // The whole parse, in the state's own tree (and every field that reads it), as a busy machine may not have it yet.
  return state.update({}).state;
}

type Spec = { class?: string; widget?: { describe?(): string }; kind?: string; attributes?: Record<string, string> };

function described(doc: string, selection?: EditorSelection | number, links?: EditorLinks): string[] {
  const state = stateOf(doc, selection, links);
  const { decorations } = buildPreview(state, [{ from: 0, to: state.doc.length }]);
  const out: string[] = [];
  for (const iter = decorations.iter(); iter.value; iter.next()) {
    const { from, to } = iter;
    const spec = iter.value.spec as Spec;
    const text = JSON.stringify(state.doc.sliceString(from, to));
    if (from === to && !spec.widget) out.push(`line ${state.doc.lineAt(from).number} ${spec.class}`);
    else if (spec.widget) out.push(`widget ${from}-${to} ${spec.widget.describe?.() ?? 'widget'}`);
    else if (spec.kind === 'hide') out.push(`hide ${from}-${to} ${text}`);
    else out.push(`mark ${from}-${to} ${spec.class} ${text}`);
  }
  return out;
}

const inRange = (all: string[], from: number, to: number) =>
  all.filter((entry) => {
    const match = /^(?:hide|widget|mark) (\d+)-(\d+)/.exec(entry);
    return match !== null && Number(match[1]) >= from && Number(match[2]) <= to;
  });

/** The attributes of the wikilink mark that starts at `from`. */
function markAttributes(doc: string, from: number, links?: EditorLinks): Record<string, string> | undefined {
  const state = stateOf(doc, doc.length, links);
  const { decorations } = buildPreview(state, [{ from: 0, to: state.doc.length }]);
  for (const iter = decorations.iter(); iter.value; iter.next()) {
    const spec = iter.value.spec as Spec;
    if (iter.from === from && spec.class?.includes('ws-wikilink')) return spec.attributes;
  }
  return undefined;
}

const DOC = [
  'See [[Orion]] and [[Orion|the hunter]] tonight.', //  1
  'Then [[Orion#Stars#Betelgeuse]] and [[#Pack]].', //  2
  'Maybe [[Meteor showers]] or [[Sketch.excalidraw]].', // 3
  'Inline ![[Winter hexagon.png|300]] here.', //          4
  'Code `[[Orion]]` stays.', //                           5
  '', //                                                  6
  '```', //                                               7
  '[[Orion]]', //                                         8
  '```', //                                               9
  '', //                                                  10
  'Not [[]] nor [[a', //                                  11
  'b]].', //                                              12
  '', //                                                  13
  'End.', //                                              14
].join('\n');
const at = (needle: string, from = 0) => DOC.indexOf(needle, from);
const away = DOC.length;

describe('wikilinks: the syntax', () => {
  it('reads [[ ]] as a Wikilink and ![[ ]] as an Embed, never in code, never empty or across lines', () => {
    const state = stateOf(DOC);
    const found: string[] = [];
    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name === 'Wikilink' || node.name === 'Embed') found.push(`${node.name} ${state.doc.sliceString(node.from, node.to)}`);
      },
    });
    expect(found).toEqual([
      'Wikilink [[Orion]]',
      'Wikilink [[Orion|the hunter]]',
      'Wikilink [[Orion#Stars#Betelgeuse]]',
      'Wikilink [[#Pack]]',
      'Wikilink [[Meteor showers]]',
      'Wikilink [[Sketch.excalidraw]]',
      'Embed ![[Winter hexagon.png|300]]',
    ]);
  });

  it('finds the link at a position, inside it or at either edge', () => {
    const state = stateOf(DOC);
    const orion = at('[[Orion]]');
    for (const pos of [orion, orion + 4, orion + 9]) expect(wikiNodeAt(state, pos)?.raw, `at ${pos - orion}`).toBe('Orion');
    expect(wikiNodeAt(state, orion - 2)).toBeNull();
    expect(wikiNodeAt(state, at('![[Winter') + 5)).toMatchObject({ embed: true, raw: 'Winter hexagon.png|300' });
  });

  it('says which part of the inside a link shows', () => {
    const shown = (raw: string, embed = false) => shownParts(raw, embed).map(([from, to]) => raw.slice(from, to));
    expect(shown('Orion')).toEqual(['Orion']);
    expect(shown('Orion|the hunter')).toEqual(['the hunter']);
    expect(shown('Orion#Stars#Betelgeuse')).toEqual(['Orion', 'Stars', 'Betelgeuse']);
    expect(shown('#Pack')).toEqual(['Pack']);
    expect(shown('Orion#^abc')).toEqual(['Orion']);
    expect(shown('#^abc')).toEqual(['abc']);
    expect(shown('Orion#Stars#^abc')).toEqual(['Orion', 'Stars']);
    expect(shown('Orion\\|alias')).toEqual(['alias']);
    expect(shown('Winter hexagon.png|300', true)).toEqual(['Winter hexagon.png']);
    expect(shown('Winter hexagon.png|a caption', true)).toEqual(['a caption']);
  });
});

describe('wikilinks: drawn', () => {
  it('draws [[Orion]] as its name, the brackets hidden', () => {
    const all = described(DOC, away);
    const orion = at('[[Orion]]');
    expect(inRange(all, orion, orion + 9)).toEqual([`hide ${orion}-${orion + 2} "[["`, `mark ${orion + 2}-${orion + 7} ws-wikilink "Orion"`, `hide ${orion + 7}-${orion + 9} "]]"`]);
  });

  it('draws an alias as the alias, and a heading as Note > Heading', () => {
    const all = described(DOC, away);
    const alias = at('[[Orion|the hunter]]');
    expect(inRange(all, alias, alias + 20)).toEqual([`hide ${alias}-${alias + 8} "[[Orion|"`, `mark ${alias + 8}-${alias + 18} ws-wikilink "the hunter"`, `hide ${alias + 18}-${alias + 20} "]]"`]);
    const deep = at('[[Orion#Stars#Betelgeuse]]');
    expect(inRange(all, deep, deep + 26)).toEqual([
      `hide ${deep}-${deep + 2} "[["`,
      `mark ${deep + 2}-${deep + 7} ws-wikilink "Orion"`,
      `widget ${deep + 7}-${deep + 8} separator`,
      `mark ${deep + 8}-${deep + 13} ws-wikilink "Stars"`,
      `widget ${deep + 13}-${deep + 14} separator`,
      `mark ${deep + 14}-${deep + 24} ws-wikilink "Betelgeuse"`,
      `hide ${deep + 24}-${deep + 26} "]]"`,
    ]);
    const own = at('[[#Pack]]');
    expect(inRange(all, own, own + 9)).toEqual([`hide ${own}-${own + 3} "[[#"`, `mark ${own + 3}-${own + 7} ws-wikilink "Pack"`, `hide ${own + 7}-${own + 9} "]]"`]);
  });

  it('draws a link to nothing muted, with the reading view’s words in its title', () => {
    const all = described(DOC, away);
    const missing = at('[[Meteor showers]]');
    expect(inRange(all, missing, missing + 18)).toContain(`mark ${missing + 2}-${missing + 16} ws-wikilink ws-wikilink-missing "Meteor showers"`);
    expect(markAttributes(DOC, missing + 2)?.title).toMatch(/^No note called Meteor showers\. (⌘|Ctrl)-click to make it\.$/);
    const sketch = at('[[Sketch.excalidraw]]');
    expect(markAttributes(DOC, sketch + 2)?.title).toBe('No file called Sketch.excalidraw.');
    expect(markAttributes(DOC, at('[[Orion]]') + 2)?.title).toMatch(/^Orion\.md \((⌘|Ctrl)-click to open\)$/);
  });

  it('draws an embed inside a line of words as a link to its file, its size hidden', () => {
    const all = described(DOC, away);
    const embed = at('![[Winter hexagon.png|300]]');
    expect(inRange(all, embed, embed + 27)).toEqual([`hide ${embed}-${embed + 3} "![["`, `mark ${embed + 3}-${embed + 21} ws-wikilink "Winter hexagon.png"`, `hide ${embed + 21}-${embed + 27} "|300]]"`]);
  });

  it('leaves links in code as written', () => {
    const all = described(DOC, away);
    expect(inRange(all, at('`[[Orion]]`') + 1, at('`[[Orion]]`') + 10).filter((entry) => entry.includes('wikilink') || entry.startsWith('hide'))).toEqual([]);
    const fenced = at('[[Orion]]', at('```'));
    expect(inRange(all, fenced, fenced + 9)).toEqual([]);
  });

  it('shows the whole link while the cursor touches it, still drawn as a link', () => {
    const orion = at('[[Orion]]');
    for (const cursor of [orion, orion + 4, orion + 9]) {
      expect(inRange(described(DOC, cursor), orion, orion + 9), `cursor at ${cursor - orion}`).toEqual([`mark ${orion + 2}-${orion + 7} ws-wikilink "Orion"`]);
    }
    expect(inRange(described(DOC, orion - 1), orion, orion + 9)).toHaveLength(3);
  });

  it('makes every hidden range atomic, so the cursor never lands inside text it can’t see', () => {
    const state = stateOf(DOC, away);
    const { atomic } = buildPreview(state, [{ from: 0, to: state.doc.length }]);
    const ranges: string[] = [];
    for (const iter = atomic.iter(); iter.value; iter.next()) ranges.push(state.doc.sliceString(iter.from, iter.to));
    expect(ranges.slice(0, 6)).toEqual(['[[', ']]', '[[Orion|', ']]', '[[', '#']);
  });

  it('follows the project: a link drawn missing is drawn found once its file is there', () => {
    const missing = at('[[Meteor showers]]');
    const more = linksFor({ files: [...FILES, file('Meteor showers.md')] });
    expect(inRange(described(DOC, away, more), missing, missing + 18)).toContain(`mark ${missing + 2}-${missing + 16} ws-wikilink "Meteor showers"`);
  });
});

describe('wikilinks: opening', () => {
  const views: EditorView[] = [];
  afterEach(() => {
    for (const view of views.splice(0)) view.destroy();
    document.body.innerHTML = '';
  });

  function editor(links: EditorLinks, cursor = away) {
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: DOC, selection: { anchor: cursor }, extensions: [noteEditorSetup({ label: 'Plan', readOnly: false }), projectLinksFacet.of(links)] }),
    });
    ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    view.dispatch({});
    views.push(view);
    return view;
  }

  it('opens the file a link names, at its heading; makes a missing note; does nothing for a missing file', () => {
    const links = linksFor();
    const state = stateOf(DOC, away, links);
    expect(followLink(state, wikiNodeAt(state, at('[[Orion]]') + 3)!)).toBe(true);
    expect(links.open).toHaveBeenLastCalledWith('Orion.md', undefined);
    followLink(state, wikiNodeAt(state, at('[[Orion#Stars') + 3)!);
    expect(links.open).toHaveBeenLastCalledWith('Orion.md', 'Betelgeuse');
    followLink(state, wikiNodeAt(state, at('[[#Pack]]') + 3)!);
    expect(links.open).toHaveBeenLastCalledWith('Guides/Observing plan.md', 'Pack');
    followLink(state, wikiNodeAt(state, at('[[Meteor') + 3)!);
    expect(links.create).toHaveBeenCalledWith('Meteor showers', 'Guides/Observing plan.md');
    expect(followLink(state, wikiNodeAt(state, at('[[Sketch') + 3)!)).toBe(false);
    expect(links.create).toHaveBeenCalledTimes(1);
  });

  it('opens a link on a Ctrl/⌘-click; a plain click doesn’t (it places the cursor)', () => {
    const links = linksFor();
    const view = editor(links);
    const link = view.contentDOM.querySelector<HTMLElement>('.ws-wikilink');
    expect(link?.textContent).toBe('Orion');
    // jsdom has no layout: CodeMirror's own mouse selection, which a plain click starts, measures text.
    const range = Range.prototype as Range & { getClientRects?: unknown; getBoundingClientRect?: unknown };
    const had = { rects: range.getClientRects, box: range.getBoundingClientRect };
    range.getClientRects = () => [] as unknown as DOMRectList;
    range.getBoundingClientRect = () => new DOMRect();
    onTestFinished(() => {
      range.getClientRects = had.rects;
      range.getBoundingClientRect = had.box;
    });
    link!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    expect(links.open).not.toHaveBeenCalled();
    const modified = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ctrlKey: true, metaKey: true });
    link!.dispatchEvent(modified);
    expect(links.open).toHaveBeenCalledWith('Orion.md', undefined);
    expect(modified.defaultPrevented).toBe(true);
  });

  it('opens the link at the cursor with Ctrl/⌘-Enter', () => {
    const links = linksFor();
    const view = editor(links, at('[[Orion|the') + 4);
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(links.open).toHaveBeenCalledWith('Orion.md', undefined);
    expect(view.state.doc.toString()).toBe(DOC);
  });
});
