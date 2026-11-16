import { CompletionContext, type Completion, type CompletionResult } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry, FileStore } from '../../../../files/types';
import { clearHeadingCache, wikilinkCompletions } from './completion';
import { projectLinksFacet, type EditorLinks } from './projectLinks';
import { wikilinkSyntax } from './wikilinks';

// Wikilink completion (part 2, task 2): the source is called the way
// CodeMirror calls it, with a CompletionContext, and its answers applied in a
// real (jsdom) EditorView.

const file = (path: string, size = 10): FileEntry => ({ path, name: path.split('/').at(-1)!, type: 'file', size, modified: 1 });
const FILES = [
  'Guides/Observing plan.md',
  'Guides/Moon phases.md',
  'Orion.md',
  'Archive/Old notes.md',
  'Guides/Sky chart.png',
  'Winter hexagon.excalidraw.md',
  'Charts/Star chart — October.pdf',
  'Sounds/Night.mp3',
  'Data/stars.csv',
].map((path) => file(path));
const PLAN = 'Guides/Observing plan.md';

function storeOf(texts: Record<string, string>) {
  const readText = vi.fn(async (path: string) => {
    if (!(path in texts)) throw new Error(`no ${path}`);
    return texts[path];
  });
  return { store: { readText } as unknown as FileStore, readText };
}

function linksFor(overrides: Partial<EditorLinks> = {}): EditorLinks {
  return { files: FILES, open: vi.fn(), create: vi.fn(), path: PLAN, store: null, projectId: 'p', ...overrides };
}

function stateOf(doc: string, cursor = doc.length, links = linksFor()) {
  const state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [markdown({ base: markdownLanguage, extensions: wikilinkSyntax }), projectLinksFacet.of(links)],
  });
  ensureSyntaxTree(state, state.doc.length, 5_000);
  // The whole parse, in the state's own tree (and every field that reads it), as a busy machine may not have it yet.
  return state.update({}).state;
}

async function complete(doc: string, cursor = doc.length, links = linksFor()): Promise<CompletionResult | null> {
  const state = stateOf(doc, cursor, links);
  return wikilinkCompletions(new CompletionContext(state, cursor, false));
}

const labels = (result: CompletionResult | null) => result?.options.map((option) => option.label) ?? null;

/** The options in the order the list shows them with nothing typed yet (CodeMirror sorts by boost, then label). */
function shown(result: CompletionResult | null): string[] {
  return [...(result?.options ?? [])].sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0) || a.label.localeCompare(b.label)).map((option) => option.label);
}

describe('wikilink completion: what it offers', () => {
  afterEach(() => clearHeadingCache());

  it('offers the project’s files after [[: notes first, nearest the note first, others with their extensions; never the note itself', async () => {
    const result = await complete('See [[');
    expect(result?.from).toBe(6);
    expect(shown(result)).toEqual(['Moon phases', 'Orion', 'Old notes', 'Sky chart.png', 'Winter hexagon.excalidraw', 'Night.mp3', 'Star chart — October.pdf', 'stars.csv']);
    const moon = result!.options.find((option) => option.label === 'Moon phases')!;
    expect(moon.detail).toBe('Guides');
    expect(result!.options.find((option) => option.label === 'Orion')!.detail).toBeUndefined();
  });

  it('offers from the start of what’s typed after [[, and keeps the list while more is typed', async () => {
    const result = await complete('See [[Or]]', 8);
    expect(result?.from).toBe(6);
    expect(result?.validFor instanceof RegExp && result.validFor.test('Orio')).toBe(true);
    expect(result?.validFor instanceof RegExp && result.validFor.test('Orion#')).toBe(false);
  });

  it('offers only what an embed can show after ![[: pictures, drawings, notes, PDFs, audio and video', async () => {
    expect(labels(await complete('![['))?.sort()).toEqual(['Moon phases', 'Night.mp3', 'Old notes', 'Orion', 'Sky chart.png', 'Star chart — October.pdf', 'Winter hexagon.excalidraw']);
  });

  it('offers a note’s headings after #, read once from the store, and this note’s own after [[#', async () => {
    const { store, readText } = storeOf({ 'Orion.md': '---\ntitle: x\n---\n# Orion\n\n## Stars\n\n```\n# not a heading\n```\n\n### Betelgeuse\n' });
    const links = linksFor({ store });
    const result = await complete('See [[Orion#', undefined, links);
    expect(result?.from).toBe(12);
    expect(labels(result)).toEqual(['Orion', 'Stars', 'Betelgeuse']);
    await complete('See [[Orion#St', undefined, links);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(labels(await complete('# Plan\n\n## Pack\n\nSee [[#'))).toEqual(['Plan', 'Pack']);
  });

  it('reads no headings from a note too long to read quickly, or one it can’t read', async () => {
    const { store, readText } = storeOf({});
    const links = linksFor({ store, files: [...FILES, file('Huge.md', 3_000_000)] });
    expect(labels(await complete('[[Huge#', undefined, links))).toEqual([]);
    expect(readText).not.toHaveBeenCalled();
    expect(labels(await complete('[[Orion#', undefined, links))).toEqual([]);
  });

  it('offers nothing after |, in code, outside [[, or in a note over 200,000 characters', async () => {
    expect(await complete('See [[Orion|')).toBeNull();
    expect(await complete('See `[[ x`', 7)).toBeNull();
    expect(await complete('```\n[[')).toBeNull();
    expect(await complete('See [')).toBeNull();
    expect(await complete('See [[Orion]] and')).toBeNull();
    expect(await complete(`${'x'.repeat(200_001)}\n[[`)).toBeNull();
  });
});

describe('wikilink completion: accepting', () => {
  const views: EditorView[] = [];
  afterEach(() => {
    for (const view of views.splice(0)) view.destroy();
    document.body.innerHTML = '';
  });

  async function accept(doc: string, cursor: number, label: string, links = linksFor()) {
    const view = new EditorView({ parent: document.body.appendChild(document.createElement('div')), state: stateOf(doc, cursor, links) });
    views.push(view);
    const result = (await wikilinkCompletions(new CompletionContext(view.state, cursor, false)))!;
    const option = result.options.find((candidate: Completion) => candidate.label === label) as Completion;
    expect(typeof option.apply).toBe('function');
    (option.apply as (view: EditorView, completion: Completion, from: number, to: number) => void)(view, option, result.from, cursor);
    return { text: view.state.doc.toString(), cursor: view.state.selection.main.head };
  }

  it('writes the shortest name that names the file alone, steps over the ]] already there, and puts the cursor after it', async () => {
    // closeBrackets has made '[[]]' of the two brackets typed.
    expect(await accept('See [[Or]] tonight', 8, 'Orion')).toEqual({ text: 'See [[Orion]] tonight', cursor: 13 });
    const twins = linksFor({ files: [...FILES, file('Archive/Orion.md')] });
    // Two notes called Orion: the one at the top is named from the top, as a bare name would mean either.
    expect(await accept('See [[]]', 6, 'Orion', twins)).toMatchObject({ text: 'See [[/Orion]]' });
    const result = await complete('See [[', 6, twins);
    const archived = result!.options.find((option) => option.label === 'Orion' && option.detail === 'Archive')!;
    expect(archived).toBeDefined();
  });

  it('writes a path for a file whose name another shares', async () => {
    const twins = linksFor({ files: [...FILES, file('Archive/Orion.md')] });
    const view = new EditorView({ parent: document.body.appendChild(document.createElement('div')), state: stateOf('See [[]]', 6, twins) });
    views.push(view);
    const result = (await wikilinkCompletions(new CompletionContext(view.state, 6, false)))!;
    const archived = result.options.find((option: Completion) => option.label === 'Orion' && option.detail === 'Archive')!;
    (archived.apply as (view: EditorView, completion: Completion, from: number, to: number) => void)(view, archived, result.from, 6);
    expect(view.state.doc.toString()).toBe('See [[Archive/Orion]]');
    expect(view.state.selection.main.head).toBe(21);
  });

  it('closes the link itself when no ]] follows (typed without bracket closing)', async () => {
    expect(await accept('See [[Moo', 9, 'Moon phases')).toEqual({ text: 'See [[Moon phases]]', cursor: 19 });
    expect(await accept('See [[Moo]', 9, 'Moon phases')).toEqual({ text: 'See [[Moon phases]]', cursor: 19 });
  });

  it('writes a picture with its extension and a drawing as Name.excalidraw', async () => {
    expect(await accept('![[]]', 3, 'Sky chart.png')).toEqual({ text: '![[Sky chart.png]]', cursor: 18 });
    expect(await accept('![[]]', 3, 'Winter hexagon.excalidraw')).toMatchObject({ text: '![[Winter hexagon.excalidraw]]' });
  });

  it('writes a heading and steps over the ]]', async () => {
    const { store } = storeOf({ 'Orion.md': '## Stars\n' });
    expect(await accept('[[Orion#]]', 8, 'Stars', linksFor({ store }))).toEqual({ text: '[[Orion#Stars]]', cursor: 15 });
  });
});
