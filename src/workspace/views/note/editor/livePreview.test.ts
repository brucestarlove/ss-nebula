import { history, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { buildPreview, toggleTaskAt } from './livePreview';

// Live preview draws decorations only; these tests build them straight from
// an EditorState (no DOM) and read them back as plain strings:
//   'line 4 ws-cm-h2'           a line's class
//   'hide 27-30 "## "'          text hidden (replaced by nothing)
//   'widget 41-47 task(done)'   text drawn as a widget
//   'mark 50-55 ws-cm-strong "bold"'

const NOTE = [
  '---', //                               1
  'tags: [stargazing]', //                2
  '---', //                               3
  '# Observing plan', //                  4
  '## Targets', //                        5
  '', //                                  6
  '- [x] Orion Nebula', //                7
  '- [ ] The Pleiades', //                8
  '  - Binoculars first', //              9
  '1. Count meteors', //                  10
  '', //                                  11
  '> Give your eyes twenty minutes', //   12
  '', //                                  13
  '---', //                               14
  '', //                                  15
  '| Object | Mag |', //                  16
  '|---|---|', //                         17
  '| M42 | 4 |', //                       18
  '', //                                  19
  '```js', //                             20
  'let dark = true', //                   21
  '```', //                               22
  '', //                                  23
  'Plain words.', //                      24
].join('\n');

function stateOf(doc: string, selection: EditorSelection | number = doc.length) {
  const state = EditorState.create({
    doc,
    selection: typeof selection === 'number' ? EditorSelection.cursor(selection) : selection,
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, state.doc.length, 5_000);
  // The whole parse, in the state's own tree, as a busy machine may not have it yet.
  return state.update({}).state;
}

/** Where line `n` (1-based) starts. */
function lineStart(doc: string, n: number): number {
  return stateOf(doc, 0).doc.line(n).from;
}

function described(doc: string, selection?: EditorSelection | number, ranges?: { from: number; to: number }[]): string[] {
  const state = stateOf(doc, selection);
  const { decorations } = buildPreview(state, ranges ?? [{ from: 0, to: state.doc.length }]);
  const out: string[] = [];
  const iter = decorations.iter();
  for (; iter.value; iter.next()) {
    const { from, to } = iter;
    const spec = iter.value.spec as { class?: string; widget?: { describe?(): string }; kind?: string };
    const text = JSON.stringify(state.doc.sliceString(from, to));
    if (from === to && !spec.widget) out.push(`line ${state.doc.lineAt(from).number} ${spec.class}`);
    else if (spec.widget) out.push(`widget ${from}-${to} ${spec.widget.describe?.() ?? 'widget'}`);
    else if (spec.kind === 'hide') out.push(`hide ${from}-${to} ${text}`);
    else out.push(`mark ${from}-${to} ${spec.class} ${text}`);
  }
  return out;
}

const forLine = (all: string[], n: number) => all.filter((entry) => entry.startsWith(`line ${n} `));
const inRange = (all: string[], from: number, to: number) =>
  all.filter((entry) => {
    const match = /^(?:hide|widget|mark) (\d+)-(\d+)/.exec(entry);
    return match !== null && Number(match[1]) >= from && Number(match[2]) <= to;
  });

describe('live preview: inline', () => {
  const TEXT = 'Some **bold** and _soft_ and ~~gone~~ and `dew` and [the chart](https://example.com/chart) and <https://auto.example> and https://bare.example #october';
  const doc = `${TEXT}\n\nSee [[Orion]], [a note](Guides/Orion.md), ![[Winter hexagon.excalidraw]] and \`a #not\`.\n\n\`\`\`c\n#nope\n\`\`\`\n\nEnd.`;
  const at = (needle: string, from = 0) => doc.indexOf(needle, from);
  const away = doc.length;

  it('hides the marks of bold, italic, strikethrough and code, and draws code as code', () => {
    const all = described(doc, away);
    const bold = at('**bold**');
    expect(inRange(all, bold, bold + 8)).toEqual([`hide ${bold}-${bold + 2} "**"`, `hide ${bold + 6}-${bold + 8} "**"`]);
    const soft = at('_soft_');
    expect(inRange(all, soft, soft + 6)).toEqual([`hide ${soft}-${soft + 1} "_"`, `hide ${soft + 5}-${soft + 6} "_"`]);
    const gone = at('~~gone~~');
    expect(inRange(all, gone, gone + 8)).toEqual([`hide ${gone}-${gone + 2} "~~"`, `hide ${gone + 6}-${gone + 8} "~~"`]);
    const dew = at('`dew`');
    expect(inRange(all, dew, dew + 5)).toEqual([`hide ${dew}-${dew + 1} "\`"`, `mark ${dew + 1}-${dew + 4} ws-cm-inline-code "dew"`, `hide ${dew + 4}-${dew + 5} "\`"`]);
  });

  it('draws a link as its words, its address hidden, and autolinks as links', () => {
    const all = described(doc, away);
    const link = at('[the chart]');
    const end = at(')', link) + 1;
    expect(inRange(all, link, end)).toEqual([`hide ${link}-${link + 1} "["`, `mark ${link + 1}-${link + 10} ws-link "the chart"`, `hide ${link + 10}-${end} "](https://example.com/chart)"`]);
    const auto = at('<https://auto.example>');
    expect(inRange(all, auto, auto + 22)).toEqual([`hide ${auto}-${auto + 1} "<"`, `mark ${auto + 1}-${auto + 21} ws-link "https://auto.example"`, `hide ${auto + 21}-${auto + 22} ">"`]);
    const bare = at('https://bare.example');
    expect(inRange(all, bare, bare + 20)).toEqual([`mark ${bare}-${bare + 20} ws-link "https://bare.example"`]);
  });

  it('gives a web link its address to open, and a link inside the project none', () => {
    const state = stateOf(doc, away);
    const { decorations } = buildPreview(state, [{ from: 0, to: state.doc.length }]);
    const hrefs: Array<string | undefined> = [];
    for (const iter = decorations.iter(); iter.value; iter.next()) {
      const spec = iter.value.spec as { class?: string; attributes?: Record<string, string> };
      if (spec.class?.includes('ws-link')) hrefs.push(spec.attributes?.['data-href']);
    }
    expect(hrefs).toEqual(['https://example.com/chart', 'https://auto.example', 'https://bare.example', undefined]);
  });

  it('draws #tags as the page’s tag pills, never in code', () => {
    const all = described(doc, away);
    const tag = at('#october');
    expect(inRange(all, tag, tag + 8)).toEqual([`mark ${tag}-${tag + 8} ws-tag ws-tag-inline "#october"`]);
    for (const code of ['#not', '#nope']) {
      const not = at(code);
      expect(inRange(all, not, not + code.length).filter((entry) => entry.includes('ws-tag')), code).toEqual([]);
    }
  });

  it('draws nothing for [[ ]] without the wikilink syntax (wikilinks.test.ts draws them)', () => {
    const all = described(doc, away);
    const wiki = at('[[Orion]]');
    expect(inRange(all, wiki, wiki + 9)).toEqual([]);
    const embed = at('![[Winter');
    expect(inRange(all, embed, embed + 30)).toEqual([]);
  });

  it('shows a span’s marks while the cursor touches it: inside or at either edge', () => {
    const bold = at('**bold**');
    for (const cursor of [bold, bold + 4, bold + 8]) {
      expect(inRange(described(doc, cursor), bold, bold + 8), `cursor at ${cursor - bold}`).toEqual([]);
    }
    // One character away, they're hidden again; the other spans stay drawn on the same line.
    expect(inRange(described(doc, bold - 1), bold, bold + 8)).toHaveLength(2);
    const link = at('[the chart]');
    expect(inRange(described(doc, link + 3), link, at(')', link) + 1)).toEqual([`mark ${link + 1}-${link + 10} ws-link "the chart"`]);
    const soft = at('_soft_');
    expect(inRange(described(doc, bold + 4), soft, soft + 6)).toHaveLength(2);
  });

  it('makes every hidden mark one step for the cursor', () => {
    const state = stateOf(doc, away);
    const { atomic } = buildPreview(state, [{ from: 0, to: state.doc.length }]);
    const ranges: string[] = [];
    for (const iter = atomic.iter(); iter.value; iter.next()) ranges.push(state.doc.sliceString(iter.from, iter.to));
    expect(ranges.slice(0, 4)).toEqual(['**', '**', '_', '_']);
    expect(ranges).toContain('](https://example.com/chart)');
  });
});

describe('live preview: blocks', () => {
  const end = NOTE.length; // the cursor sits on the last line, away from everything

  it('draws a heading at its level with its #s hidden', () => {
    const all = described(NOTE, end);
    const h2 = lineStart(NOTE, 5);
    expect(forLine(all, 5)).toEqual(['line 5 ws-cm-heading ws-cm-h2']);
    expect(inRange(all, h2, h2 + 10)).toEqual([`hide ${h2}-${h2 + 3} "## "`]);
    expect(forLine(all, 4)).toEqual(['line 4 ws-cm-heading ws-cm-h1']);
  });

  it('shows the Markdown of the line the cursor is on, keeping the heading’s size', () => {
    const h2 = lineStart(NOTE, 5);
    const all = described(NOTE, h2 + 5);
    expect(forLine(all, 5)).toEqual(['line 5 ws-cm-heading ws-cm-h2']);
    expect(inRange(all, h2, h2 + 10)).toEqual([]);
  });

  it('shows the Markdown of every line a selection touches', () => {
    const h1 = lineStart(NOTE, 4);
    const all = described(NOTE, EditorSelection.single(h1 + 3, lineStart(NOTE, 5) + 2));
    expect(inRange(all, h1, lineStart(NOTE, 6))).toEqual([]);
  });

  it('draws a task’s box as a checkbox, ticked or not, and dims a done one', () => {
    const all = described(NOTE, end);
    const done = lineStart(NOTE, 7);
    const open = lineStart(NOTE, 8);
    expect(inRange(all, done, done + 18)).toEqual([`widget ${done}-${done + 6} task(done)`]);
    expect(inRange(all, open, open + 18)).toEqual([`widget ${open}-${open + 6} task(open)`]);
    expect(forLine(all, 7)).toEqual(['line 7 ws-cm-li ws-cm-task ws-cm-done']);
    expect(forLine(all, 8)).toEqual(['line 8 ws-cm-li ws-cm-task']);
  });

  it('keeps a list’s marker drawn on the cursor line, and shows it with the cursor at the line’s start', () => {
    const open = lineStart(NOTE, 8);
    // Typing in the task: its box stays a box.
    expect(inRange(described(NOTE, open + 10), open, open + 18)).toEqual([`widget ${open}-${open + 6} task(open)`]);
    // At the start of the line, before the box: its Markdown.
    expect(inRange(described(NOTE, open), open, open + 18)).toEqual([]);
  });

  it('draws bullets as bullets and numbers as written, nested lists one level in', () => {
    const all = described(NOTE, end);
    const nested = lineStart(NOTE, 9);
    const numbered = lineStart(NOTE, 10);
    expect(inRange(all, nested, nested + 20)).toEqual([`widget ${nested}-${nested + 4} bullet`]);
    expect(forLine(all, 9)).toEqual(['line 9 ws-cm-li ws-cm-li-1']);
    expect(inRange(all, numbered, numbered + 16)).toEqual([`widget ${numbered}-${numbered + 3} number(1.)`]);
    expect(forLine(all, 10)).toEqual(['line 10 ws-cm-li']);
  });

  it('indents a list item’s later lines to its text, and gives a line in two blocks both', () => {
    const doc = ['- First item', '  goes on here', '  - Inner', '    and on', '- Last', '', 'End.'].join('\n');
    const all = described(doc, doc.length);
    expect(forLine(all, 2)).toEqual(['line 2 ws-cm-li-cont']);
    expect(inRange(all, lineStart(doc, 2), lineStart(doc, 3))).toEqual([`hide ${lineStart(doc, 2)}-${lineStart(doc, 2) + 2} "  "`]);
    expect(forLine(all, 3)).toEqual(['line 3 ws-cm-li ws-cm-li-1']);
    expect(forLine(all, 4)).toEqual(['line 4 ws-cm-li-cont ws-cm-li-1']);
    // On the cursor's line, its indentation shows.
    expect(inRange(described(doc, lineStart(doc, 2) + 5), lineStart(doc, 2), lineStart(doc, 3))).toEqual([]);
    const quoted = described('> - [ ] In a quote\n\nEnd.', 20);
    expect(forLine(quoted, 1)).toEqual(['line 1 ws-cm-quote ws-cm-li ws-cm-task']);
  });

  it('draws a quote with its rule and the > hidden', () => {
    const all = described(NOTE, end);
    const quote = lineStart(NOTE, 12);
    expect(forLine(all, 12)).toEqual(['line 12 ws-cm-quote']);
    expect(inRange(all, quote, quote + 30)).toEqual([`hide ${quote}-${quote + 2} "> "`]);
  });

  it('draws a horizontal rule as a rule', () => {
    const all = described(NOTE, end);
    const rule = lineStart(NOTE, 14);
    expect(inRange(all, rule, rule + 3)).toEqual([`widget ${rule}-${rule + 3} rule`]);
    expect(forLine(all, 14)).toEqual(['line 14 ws-cm-hr']);
  });

  it('styles a table’s rows and quiets its pipes', () => {
    const all = described(NOTE, end);
    expect(forLine(all, 16)).toEqual(['line 16 ws-cm-table ws-cm-table-head']);
    expect(forLine(all, 17)).toEqual(['line 17 ws-cm-table ws-cm-table-rule']);
    expect(forLine(all, 18)).toEqual(['line 18 ws-cm-table']);
    const head = lineStart(NOTE, 16);
    expect(inRange(all, head, head + 1)).toEqual([`mark ${head}-${head + 1} ws-cm-pipe "|"`]);
  });

  it('draws a fenced code block as a panel, its fences hidden until the cursor is in it', () => {
    const all = described(NOTE, end);
    expect(forLine(all, 20)).toEqual(['line 20 ws-cm-code ws-cm-code-first ws-cm-fence']);
    expect(forLine(all, 21)).toEqual(['line 21 ws-cm-code']);
    // The hidden closing fence is a thin line, so the panel's bottom matches its top.
    expect(forLine(all, 22)).toEqual(['line 22 ws-cm-code ws-cm-code-last ws-cm-fence ws-cm-fence-hidden']);
    const open = lineStart(NOTE, 20);
    const close = lineStart(NOTE, 22);
    expect(inRange(all, open, open + 5)).toEqual([`hide ${open}-${open + 3} "\`\`\`"`, `mark ${open + 3}-${open + 5} ws-cm-code-info "js"`]);
    expect(inRange(all, close, close + 3)).toEqual([`hide ${close}-${close + 3} "\`\`\`"`]);
    const inside = described(NOTE, lineStart(NOTE, 21) + 2);
    expect(inRange(inside, open, close + 3).filter((entry) => entry.startsWith('hide'))).toEqual([]);
    expect(forLine(inside, 22)).toEqual(['line 22 ws-cm-code ws-cm-code-last ws-cm-fence']);
    // A fence that names no language is thin at the top as well.
    const plain = 'Text\n\n```\ncode\n```\n\nEnd';
    expect(forLine(described(plain, plain.length), 3)).toEqual(['line 3 ws-cm-code ws-cm-code-first ws-cm-fence ws-cm-fence-hidden']);
  });

  it('draws a blank line between blocks as the page’s gap between paragraphs, not a whole line; full height under the cursor and in code', () => {
    const all = described(NOTE, end);
    for (const n of [6, 11, 13, 15, 19, 23]) expect(forLine(all, n), `line ${n}`).toEqual([`line ${n} ws-cm-blank`]);
    expect(forLine(described(NOTE, lineStart(NOTE, 11)), 11)).toEqual([]);
    const code = 'Text\n\n```\none\n\ntwo\n```\n\nEnd';
    const lines = described(code, code.length);
    expect(forLine(lines, 2)).toEqual(['line 2 ws-cm-blank']);
    expect(forLine(lines, 5)).toEqual(['line 5 ws-cm-code']);
    expect(forLine(lines, 8)).toEqual(['line 8 ws-cm-blank']);
  });

  it('draws front matter as a quiet properties block, and nothing in it as Markdown', () => {
    const all = described(NOTE, end);
    expect(forLine(all, 1)).toEqual(['line 1 ws-cm-frontmatter ws-cm-frontmatter-first']);
    expect(forLine(all, 2)).toEqual(['line 2 ws-cm-frontmatter']);
    expect(forLine(all, 3)).toEqual(['line 3 ws-cm-frontmatter ws-cm-frontmatter-last']);
    // Not a setext heading, a rule or a link, as the parser alone would say.
    expect(inRange(all, 0, lineStart(NOTE, 4))).toEqual([]);
  });

  it('leaves a paragraph as it is', () => {
    expect(forLine(described(NOTE, 0), 24)).toEqual([]);
  });

  it('draws only the ranges it is given (what is on screen)', () => {
    const all = described(NOTE, end, [{ from: lineStart(NOTE, 12), to: lineStart(NOTE, 13) - 1 }]);
    expect(all.map((entry) => entry.split(' ').slice(0, 2).join(' '))).toEqual(['line 12', `hide ${lineStart(NOTE, 12)}-${lineStart(NOTE, 12) + 2}`]);
  });

  it('never changes the document', () => {
    const state = stateOf(NOTE, end);
    buildPreview(state, [{ from: 0, to: state.doc.length }]);
    expect(state.doc.toString()).toBe(NOTE);
  });

  it('ticks and unticks a task with one change, undone in one step', () => {
    const doc = '- [ ] The Pleiades\n> 1. [x] Quoted\n';
    const view = new EditorView({ state: EditorState.create({ doc, extensions: [history()] }) });
    expect(toggleTaskAt(view, 8)).toBe(true);
    expect(view.state.doc.toString()).toBe('- [x] The Pleiades\n> 1. [x] Quoted\n');
    expect(toggleTaskAt(view, view.state.doc.line(2).from + 3)).toBe(true);
    expect(view.state.doc.toString()).toBe('- [x] The Pleiades\n> 1. [ ] Quoted\n');
    undo(view);
    expect(view.state.doc.toString()).toBe('- [x] The Pleiades\n> 1. [x] Quoted\n');
    expect(toggleTaskAt(view, view.state.doc.length)).toBe(false);
    view.destroy();
  });
});
