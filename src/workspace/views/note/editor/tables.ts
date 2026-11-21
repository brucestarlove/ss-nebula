import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, Prec, type Range, StateField, type Transaction } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from '@codemirror/view';
import { searchForTag } from '../../../searchEvent';
import { frontmatterLines, openWebLink, webHref } from './livePreview';
import { projectLinksFacet, projectLinksOf, type EditorLinks } from './projectLinks';
import { drawTable, sourceFallback } from './tableCells';
import { looksLikeDelimiterRow, rowSlots, tableAroundRow, tableNodeAt, tableRows, type TableBlock } from './tableSyntax';
import { followLink, type WikiNode } from './wikilinks';

/**
 * GFM tables drawn as tables in the live preview, away from the cursor: a
 * block widget over the table's lines, drawn as the reading view draws a
 * table (tableCells.ts). With the cursor (or a selection's end) on any of
 * its lines the source shows, as every other mark does, and a click on a
 * cell puts the cursor in that cell's words. A selection running through a
 * table keeps it drawn.
 *
 * Block widgets come from a StateField (a ViewPlugin can't make them). Per
 * transaction the field does only what changed, as embeds.tsx does: a
 * table has a delimiter row (`|---|---|`), so those lines are the
 * candidates, found by their text on the lines an edit touched and carried
 * through the edit everywhere else; the parse then says which are tables.
 * The widgets change when the selection moves into or out of a table, not
 * on every move. A widget's DOM is built only when CodeMirror draws it, so
 * only the tables near the screen cost anything.
 *
 * The source keeps livePreview.ts's table style (monospace columns, quiet
 * pipes); the drawn table is editor.css's "Tables (2.0.2)" block.
 */

/* ---- finding the tables ---------------------------------------------------- */

/** A line that looks like a table's delimiter row. */
type Candidate = { from: number; to: number };

function scanLine(state: EditorState, n: number): Candidate | null {
  const line = state.doc.line(n);
  return looksLikeDelimiterRow(line.text) ? { from: line.from, to: line.to } : null;
}

function scanAll(state: EditorState): Candidate[] {
  const out: Candidate[] = [];
  for (let n = 1; n <= state.doc.lines; n += 1) {
    const found = scanLine(state, n);
    if (found) out.push(found);
  }
  return out;
}

/** The candidates after an edit: the old ones carried through it, less those it touched, plus the lines it touched read again. */
function mapCandidates(previous: readonly Candidate[], tr: Transaction): Candidate[] {
  const touched: Array<[number, number]> = [];
  tr.changes.iterChangedRanges((fromA, toA) => touched.push([fromA, toA]));
  const kept: Candidate[] = [];
  for (const line of previous) {
    if (touched.some(([from, to]) => from <= line.to && to >= line.from)) continue;
    kept.push({ from: tr.changes.mapPos(line.from, 1), to: tr.changes.mapPos(line.to, -1) });
  }
  const seen = new Set(kept.map((line) => line.from));
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    for (let n = tr.state.doc.lineAt(fromB).number; n <= tr.state.doc.lineAt(toB).number; n += 1) {
      const found = scanLine(tr.state, n);
      if (found && !seen.has(found.from)) {
        seen.add(found.from);
        kept.push(found);
      }
    }
  });
  return kept.sort((a, b) => a.from - b.from);
}

/** The tables the parse reads from the candidates, outside the front matter, each once. */
function checked(state: EditorState, candidates: readonly Candidate[]): TableBlock[] {
  const front = frontmatterLines(state);
  const found = new Map<number, TableBlock>();
  for (const candidate of candidates) {
    if (front && candidate.from <= front.to) continue;
    const block = tableAroundRow(state, candidate.from);
    if (block) found.set(block.from, block);
  }
  return [...found.values()].sort((a, b) => a.from - b.from);
}

/** The tables of a state, read afresh (tests compare them with what the editor holds). */
export function tablesOf(state: EditorState): TableBlock[] {
  return checked(state, scanAll(state));
}

/* ---- the widget ------------------------------------------------------------ */

/** Where a cell's words are in the text, or null if no table starts at `from` any more. */
function slotAt(state: EditorState, from: number, row: number, column: number): { from: number; to: number } | null {
  const table = tableNodeAt(state, from);
  if (!table) return null;
  const rows = tableRows(table);
  const slots = rows[row] ? rowSlots(rows[row]) : [];
  return slots[Math.min(column, slots.length - 1)] ?? null;
}

/** Puts the cursor in a cell's words (the table's source shows), `fraction` of the way along them. */
function enterCell(view: EditorView, dom: HTMLElement, row: number, column: number, fraction: number): void {
  const from = view.posAtDOM(dom);
  const slot = slotAt(view.state, from, row, column);
  const at = slot ? slot.from + Math.round((slot.to - slot.from) * Math.min(1, Math.max(0, fraction))) : from;
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true, userEvent: 'select.pointer' });
  view.focus();
}

/** A row's height until the browser has said: its padding and a line, at the page's size. */
const ROW_HEIGHT = 38;
/** What the page leaves after a table (--ws-table-gap). */
const BLOCK_PADDING = 20;

const observers = new WeakMap<HTMLElement, ResizeObserver>();

class TableWidget extends WidgetType {
  /** The table's text: what the widget is, so a table that reads the same keeps its DOM. */
  readonly text: string;
  readonly from: number;
  readonly to: number;
  readonly lines: number;
  readonly links: EditorLinks;

  constructor(text: string, from: number, to: number, lines: number, links: EditorLinks) {
    super();
    this.text = text;
    this.from = from;
    this.to = to;
    this.lines = lines;
    this.links = links;
  }

  eq(other: TableWidget) {
    return other.text === this.text && other.links === this.links;
  }

  describe() {
    return `table(${this.lines - 1})`;
  }

  /** CodeMirror lays out what's off screen by this, so the scroll doesn't jump when a table is drawn. The delimiter row isn't a row on the page. */
  get estimatedHeight() {
    return (this.lines - 1) * ROW_HEIGHT + BLOCK_PADDING;
  }

  toDOM(view: EditorView) {
    const root = document.createElement('div');
    root.className = 'ws-cm-table-block';
    const drawn = drawTable(view.state, this.from);
    if (!drawn) {
      // The tree moved on before the widget was drawn: its words as written, until the next update.
      root.appendChild(sourceFallback(view.state, this.from, this.to));
      return root;
    }
    const scroll = drawn.dom;
    root.appendChild(scroll);
    const body = drawn.rows - 1;
    const label = `Table, ${drawn.columns} ${drawn.columns === 1 ? 'column' : 'columns'}, ${body} ${body === 1 ? 'row' : 'rows'} under the headings. Enter edits its Markdown.`;
    // A box that scrolls sideways takes focus, so the keyboard can scroll it (arrow keys); Enter opens its Markdown.
    const sync = () => {
      if (scroll.scrollWidth > scroll.clientWidth + 1) {
        scroll.tabIndex = 0;
        scroll.setAttribute('role', 'group');
        scroll.setAttribute('aria-label', label);
      } else {
        scroll.removeAttribute('tabindex');
        scroll.removeAttribute('role');
        scroll.removeAttribute('aria-label');
      }
    };
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        sync();
        view.requestMeasure();
      });
      observer.observe(scroll);
      observers.set(root, observer);
    }

    root.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const cell = event.target.closest<HTMLElement>('td, th');
      if (!cell) return;
      // Ctrl/⌘-click opens a link, as in the text; any other click is a place for the cursor.
      if (event.metaKey || event.ctrlKey) {
        const href = event.target.closest<HTMLElement>('.ws-link[data-href]')?.dataset.href;
        if (href && webHref(href)) {
          event.preventDefault();
          openWebLink(href);
          return;
        }
        const tag = event.target.closest<HTMLElement>('.ws-tag[data-tag]')?.dataset.tag;
        if (tag) {
          event.preventDefault();
          searchForTag(tag);
          return;
        }
        const wiki = event.target.closest<HTMLElement>('.ws-wikilink[data-wiki]');
        if (wiki?.dataset.wiki !== undefined) {
          event.preventDefault();
          const node: Pick<WikiNode, 'raw' | 'embed'> = { raw: wiki.dataset.wiki, embed: wiki.dataset.embed !== undefined };
          followLink(view.state, node);
          return;
        }
      }
      event.preventDefault();
      const box = cell.getBoundingClientRect();
      enterCell(view, root, Number(cell.dataset.row), Number(cell.dataset.col), box.width > 0 ? (event.clientX - box.left) / box.width : 0);
    });
    scroll.addEventListener('keydown', (event) => {
      if (event.target !== scroll || (event.key !== 'Enter' && event.key !== ' ') || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      enterCell(view, root, 0, 0, 0);
    });
    return root;
  }

  destroy(dom: HTMLElement) {
    observers.get(dom)?.disconnect();
    observers.delete(dom);
  }

  // What happens inside the drawn table is the widget's own; a click on its
  // padding is the editor's, and puts the cursor on the table's source.
  ignoreEvent(event: Event) {
    return !(event.target instanceof HTMLElement && event.target.classList.contains('ws-cm-table-block'));
  }
}

/* ---- the field ------------------------------------------------------------- */

type Tables = {
  /** Lines that look like a delimiter row. */
  candidates: Candidate[];
  /** The tables the parse agrees with, as whole lines. */
  blocks: TableBlock[];
  /** Which of them a selection is on, as a key: the widgets change when this does. */
  covered: string;
  decorations: DecorationSet;
};

/** The tables a cursor or a selection's end is on (a selection running through one isn't). */
function coveredBy(state: EditorState, blocks: readonly TableBlock[]): number[] {
  const out: number[] = [];
  blocks.forEach((block, index) => {
    const on = (pos: number) => pos >= block.from && pos <= block.to;
    if (state.selection.ranges.some((range) => on(range.anchor) || on(range.head))) out.push(index);
  });
  return out;
}

function decorate(state: EditorState, blocks: readonly TableBlock[], covered: readonly number[]): DecorationSet {
  if (blocks.length === 0) return Decoration.none;
  const links = projectLinksOf(state);
  const ranges: Range<Decoration>[] = [];
  blocks.forEach((block, index) => {
    if (covered.includes(index)) return;
    const lines = state.doc.lineAt(block.to).number - state.doc.lineAt(block.from).number + 1;
    const widget = new TableWidget(state.doc.sliceString(block.from, block.to), block.from, block.to, lines, links);
    ranges.push(Decoration.replace({ widget, block: true }).range(block.from, block.to));
  });
  return Decoration.set(ranges);
}

function build(state: EditorState, candidates: Candidate[], blocks: TableBlock[]): Tables {
  const covered = coveredBy(state, blocks);
  return { candidates, blocks, covered: covered.join(','), decorations: decorate(state, blocks, covered) };
}

const tableField = StateField.define<Tables>({
  create(state) {
    const candidates = scanAll(state);
    return build(state, candidates, checked(state, candidates));
  },
  update(value, tr) {
    const project = tr.startState.facet(projectLinksFacet) !== tr.state.facet(projectLinksFacet);
    const parsed = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (tr.docChanged || project || parsed) {
      const candidates = tr.docChanged ? mapCandidates(value.candidates, tr) : value.candidates;
      return build(tr.state, candidates, checked(tr.state, candidates));
    }
    if (tr.selection) {
      const covered = coveredBy(tr.state, value.blocks);
      const key = covered.join(',');
      if (key !== value.covered) return { ...value, covered: key, decorations: decorate(tr.state, value.blocks, covered) };
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** The tables the editor holds now, as whole lines (tests compare them with a fresh reading). */
export function heldTables(state: EditorState): TableBlock[] {
  return state.field(tableField, false)?.blocks ?? [];
}

/** The tables drawn as widgets now (tests read them). */
export function tableDecorations(state: EditorState): DecorationSet {
  return state.field(tableField, false)?.decorations ?? Decoration.none;
}

/* ---- keys beside a drawn table ----------------------------------------------- */

/** The drawn table that starts at `pos` (`edge` 'from') or ends there ('to'), or null. */
function drawnAt(state: EditorState, pos: number, edge: 'from' | 'to'): TableBlock | null {
  let found: TableBlock | null = null;
  tableDecorations(state).between(pos, pos, (from, to) => {
    if ((edge === 'from' ? from : to) === pos) found = { from, to };
  });
  return found;
}

/** ArrowDown from the line above a drawn table, or ArrowUp from the line below, puts the cursor on the table's source in one move (CodeMirror's own vertical motion would step past it). */
function stepOnto(forward: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const range = state.selection.main;
    if (state.selection.ranges.length > 1 || !range.empty) return false;
    const line = state.doc.lineAt(range.head);
    const next = line.number + (forward ? 1 : -1);
    if (next < 1 || next > state.doc.lines) return false;
    const table = forward ? drawnAt(state, state.doc.line(next).from, 'from') : drawnAt(state, state.doc.line(next).to, 'to');
    if (!table) return false;
    // Only from the line's last (or first) row: a wrapped paragraph moves within itself first.
    const moved = view.moveVertically(range, forward);
    if (forward ? moved.head <= line.to : moved.head >= line.from) return false;
    view.dispatch({ selection: { anchor: forward ? table.from : table.to }, scrollIntoView: true, userEvent: 'select' });
    return true;
  };
}

/** Backspace at the start of the line after a drawn table, or Delete at the end of the line before one, shows the table's source rather than joining a line to words that can't be seen. */
function showBeside(forward: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const range = state.selection.main;
    if (state.selection.ranges.length > 1 || !range.empty) return false;
    const line = state.doc.lineAt(range.head);
    if (forward) {
      if (range.head !== line.to || line.number >= state.doc.lines) return false;
      const table = drawnAt(state, state.doc.line(line.number + 1).from, 'from');
      if (!table) return false;
      view.dispatch({ selection: { anchor: table.from }, scrollIntoView: true, userEvent: 'select' });
      return true;
    }
    if (range.head !== line.from || line.number <= 1) return false;
    const table = drawnAt(state, state.doc.line(line.number - 1).to, 'to');
    if (!table) return false;
    view.dispatch({ selection: { anchor: table.to }, scrollIntoView: true, userEvent: 'select' });
    return true;
  };
}

const besideTables = Prec.high(
  keymap.of([
    { key: 'ArrowDown', run: stepOnto(true) },
    { key: 'ArrowUp', run: stepOnto(false) },
    { key: 'Backspace', run: showBeside(false) },
    { key: 'Delete', run: showBeside(true) },
  ]),
);

/** Tables drawn as tables in the live preview, away from the cursor. */
export const editorTables: Extension = [tableField, besideTables];
