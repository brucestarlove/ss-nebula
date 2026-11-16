import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, Prec, type Range, StateField, type Transaction } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from '@codemirror/view';
import { createRoot, type Root } from 'react-dom/client';
import { embedFile, type EmbedLine } from './embedLine';
import { EmbedView } from './EmbedView';
import { frontmatterLines } from './livePreview';
import { projectLinksFacet, projectLinksOf, type EditorLinks } from './projectLinks';

/**
 * Embeds drawn in the editor: a line that holds only `![[…]]` or a project
 * image (`![alt](path)`) is drawn as the reading view draws it, with the
 * reading lane's own components (embeds/), in a block widget over the line,
 * while no cursor is on it; with a cursor (or a selection's end) on the line,
 * its source shows, as every other mark does. A selection running through it
 * keeps it drawn.
 *
 * Block widgets come from a StateField (a ViewPlugin can't make them). The
 * lines are found again when the text, the parse or the project changes;
 * the widgets when the selection moves. CodeMirror draws only what is near
 * the screen, so a widget, and the file it reads, exists only there; inside
 * it, the components keep their own lazy rules (a picture is read near the
 * screen, Excalidraw loads only for a drawing near the screen).
 *
 * A widget's React root is parked for a while when the cursor uncovers its
 * line, so passing over a picture doesn't read it again.
 */

export type { EmbedLine };

const WIKI_LINE = /^[ \t]{0,3}!\[\[([^[\]\n]+)\]\][ \t]*$/;
const IMAGE_LINE = /^[ \t]{0,3}!\[([^\]\n]*)\]\((<[^<>\n]*>|[^\s()<>]+)(?:[ \t]+"([^"\n]*)")?\)[ \t]*$/;
const NOT_DRAWN = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'Blockquote', 'ListItem', 'Table']);

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

/** Whether the parser read the embed at `pos` as one (not code, not inside a quote or list). */
function parsedAsEmbed(state: EditorState, pos: number, name: 'Embed' | 'Image'): boolean {
  let found = false;
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (NOT_DRAWN.has(node.name)) return false;
    if (node.name === name) found = true;
  }
  // Beyond what's parsed yet the tree is only the document: take the line as it reads.
  return found || syntaxTree(state).length < pos;
}

/** Line `n` as an embed line, by its text alone (the parse is checked later), or null. */
function scanLine(state: EditorState, n: number): EmbedLine | null {
  const line = state.doc.line(n);
  if (!line.text.includes('![')) return null;
  const wiki = WIKI_LINE.exec(line.text);
  if (wiki) return { from: line.from, to: line.to, kind: 'wiki', raw: wiki[1] };
  const image = IMAGE_LINE.exec(line.text);
  if (!image) return null;
  const src = image[2].startsWith('<') ? image[2].slice(1, -1) : image[2];
  // Web images wait for Load images in the reading view; here they stay as written.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return null;
  return { from: line.from, to: line.to, kind: 'image', raw: src, alt: image[1], title: image[3] };
}

function scanAll(state: EditorState): EmbedLine[] {
  const out: EmbedLine[] = [];
  for (let n = 1; n <= state.doc.lines; n += 1) {
    const found = scanLine(state, n);
    if (found) out.push(found);
  }
  return out;
}

/**
 * The candidates after an edit: the old ones mapped through it, less those it
 * touched, plus the lines it touched read again. So typing in a long note
 * reads the line being typed, not the whole note.
 */
function mapCandidates(previous: readonly EmbedLine[], tr: Transaction): EmbedLine[] {
  const touched: Array<[number, number]> = [];
  tr.changes.iterChangedRanges((fromA, toA) => touched.push([fromA, toA]));
  const kept: EmbedLine[] = [];
  for (const line of previous) {
    if (touched.some(([from, to]) => from <= line.to && to >= line.from)) continue;
    kept.push({ ...line, from: tr.changes.mapPos(line.from, 1), to: tr.changes.mapPos(line.to, -1) });
  }
  const state = tr.state;
  const seen = new Set(kept.map((line) => line.from));
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    for (let n = state.doc.lineAt(fromB).number; n <= state.doc.lineAt(toB).number; n += 1) {
      const found = scanLine(state, n);
      if (found && !seen.has(found.from)) {
        seen.add(found.from);
        kept.push(found);
      }
    }
  });
  return kept.sort((a, b) => a.from - b.from);
}

/** The candidates the parse reads as embeds, outside the front matter. */
function checked(state: EditorState, candidates: readonly EmbedLine[]): EmbedLine[] {
  const front = frontmatterLines(state);
  return candidates.filter((line) => {
    if (front && line.from <= front.to) return false;
    const text = state.doc.sliceString(line.from, line.to);
    const at = line.from + text.indexOf('![');
    return parsedAsEmbed(state, at + 1, line.kind === 'wiki' ? 'Embed' : 'Image');
  });
}

/** The lines of the note that hold only an embed. */
export function embedLines(state: EditorState): EmbedLine[] {
  return checked(state, scanAll(state));
}

/* ---- the widget ----------------------------------------------------------- */

type Mounted = { dom: HTMLElement; root: Root; key: string; embed: EmbedLine; timer?: ReturnType<typeof setTimeout> };

const mountedByDom = new WeakMap<HTMLElement, Mounted>();
/** Roots whose line the cursor uncovered, kept for a while in case it comes back. */
const parked = new Map<string, Mounted[]>();
const PARK_MS = 15_000;

function unmount(mounted: Mounted) {
  // Never inside React's own rendering (an editor torn down by a React effect).
  queueMicrotask(() => mounted.root.unmount());
}

/** Unmounts every parked root now (tests, and the editor going away). */
export function flushParkedEmbeds(): void {
  for (const list of parked.values()) {
    for (const mounted of list) {
      clearTimeout(mounted.timer);
      mounted.root.unmount();
    }
  }
  parked.clear();
}

/** What the cursor may do inside a widget: nothing; clicks are the components'. */
const INTERACTIVE = 'a, button, audio, video, input, select, textarea, summary';

class EmbedWidget extends WidgetType {
  readonly embed: EmbedLine;
  readonly links: EditorLinks;

  constructor(embed: EmbedLine, links: EditorLinks) {
    super();
    this.embed = embed;
    this.links = links;
  }

  get key(): string {
    return `${this.links.projectId}\u0000${this.links.path}\u0000${this.embed.kind}\u0000${this.embed.raw}\u0000${this.embed.alt ?? ''}`;
  }

  eq(other: EmbedWidget) {
    return other.key === this.key && other.embed.title === this.embed.title && other.links === this.links;
  }

  describe() {
    return `embed(${this.embed.raw})`;
  }

  private render(mounted: Mounted) {
    mounted.embed = this.embed;
    mounted.root.render(<EmbedView embed={this.embed} links={this.links} />);
  }

  toDOM(view: EditorView) {
    const reused = parked.get(this.key)?.pop();
    if (reused) {
      clearTimeout(reused.timer);
      this.render(reused);
      return reused.dom;
    }
    const dom = document.createElement('div');
    dom.className = 'ws-cm-embed';
    dom.dataset.kind = this.embed.kind;
    const body = document.createElement('div');
    body.className = 'ws-cm-embed-body ws-prose';
    dom.append(body);
    // Clicks inside are the components' (Open, play, a link) or open the file;
    // they never move the editor's cursor or take its focus.
    body.addEventListener('mousedown', (event) => {
      if (event.target instanceof Element && event.target.closest('audio, video')) return;
      event.preventDefault();
    });
    body.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
      const file = embedFile(mountedByDom.get(dom)?.embed ?? this.embed, projectLinksOf(view.state));
      if (!file) return;
      event.preventDefault();
      projectLinksOf(view.state).open(file.path);
    });
    // A picture or a drawing arriving changes the widget's height: the editor measures again.
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => view.requestMeasure()).observe(body);
    const mounted: Mounted = { dom, root: createRoot(body), key: this.key, embed: this.embed };
    mountedByDom.set(dom, mounted);
    this.render(mounted);
    return dom;
  }

  updateDOM(dom: HTMLElement) {
    const mounted = mountedByDom.get(dom);
    if (!mounted || mounted.key !== this.key) return false;
    this.render(mounted);
    return true;
  }

  destroy(dom: HTMLElement) {
    const mounted = mountedByDom.get(dom);
    if (!mounted) return;
    const list = parked.get(mounted.key) ?? [];
    list.push(mounted);
    parked.set(mounted.key, list);
    mounted.timer = setTimeout(() => {
      const left = parked.get(mounted.key);
      const index = left?.indexOf(mounted) ?? -1;
      if (!left || index < 0) return;
      left.splice(index, 1);
      if (left.length === 0) parked.delete(mounted.key);
      unmount(mounted);
    }, PARK_MS);
  }

  // The editor leaves what happens inside the drawing to it; a click on the
  // widget's own edge (its padding) is the editor's, and places the cursor
  // on the source line.
  ignoreEvent(event: Event) {
    return !(event.target instanceof HTMLElement && event.target.classList.contains('ws-cm-embed'));
  }
}

/* ---- the field ------------------------------------------------------------ */

type Embeds = {
  /** Lines whose text is one embed. */
  candidates: EmbedLine[];
  /** Those the parse agrees are embeds: what is drawn, away from the cursor. */
  lines: EmbedLine[];
  decorations: DecorationSet;
};

/** The line numbers a cursor or a selection's end is on. */
function cursorLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    lines.add(state.doc.lineAt(range.anchor).number);
    lines.add(state.doc.lineAt(range.head).number);
  }
  return lines;
}

function decorate(state: EditorState, lines: EmbedLine[]): DecorationSet {
  const links = projectLinksOf(state);
  if (!links.store || lines.length === 0) return Decoration.none;
  const covered = cursorLines(state);
  const ranges: Range<Decoration>[] = [];
  for (const line of lines) {
    if (covered.has(state.doc.lineAt(line.from).number)) continue;
    ranges.push(Decoration.replace({ widget: new EmbedWidget(line, links), block: true }).range(line.from, line.to));
  }
  return Decoration.set(ranges);
}

const embedField = StateField.define<Embeds>({
  create(state) {
    const candidates = scanAll(state);
    const lines = checked(state, candidates);
    return { candidates, lines, decorations: decorate(state, lines) };
  },
  update(value, tr) {
    const project = tr.startState.facet(projectLinksFacet) !== tr.state.facet(projectLinksFacet);
    const parsed = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (tr.docChanged || project || parsed) {
      const candidates = tr.docChanged ? mapCandidates(value.candidates, tr) : value.candidates;
      const lines = checked(tr.state, candidates);
      return { candidates, lines, decorations: decorate(tr.state, lines) };
    }
    if (tr.selection) return { ...value, decorations: decorate(tr.state, value.lines) };
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** The embed lines the editor holds now (tests compare them with a fresh reading). */
export function heldEmbedLines(state: EditorState): EmbedLine[] {
  return state.field(embedField, false)?.lines ?? [];
}

/** The drawn embeds of a state (tests read them). */
export function embedDecorations(state: EditorState): DecorationSet {
  return state.field(embedField, false)?.decorations ?? Decoration.none;
}

/** Whether line `n` is drawn as a widget now. */
function drawnLine(state: EditorState, n: number): boolean {
  if (n < 1 || n > state.doc.lines) return false;
  const line = state.doc.line(n);
  let found = false;
  embedDecorations(state).between(line.from, line.to, (from) => {
    if (from === line.from) found = true;
  });
  return found;
}

/** ArrowDown from the line above a widget, or ArrowUp from the line below,
 * puts the cursor on the embed's line (its source shows) in one move;
 * CodeMirror's own vertical motion would step past the drawing. */
function stepOnto(forward: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const range = state.selection.main;
    if (state.selection.ranges.length > 1 || !range.empty) return false;
    const line = state.doc.lineAt(range.head);
    const next = line.number + (forward ? 1 : -1);
    if (!drawnLine(state, next)) return false;
    // Only from the line's last (or first) row: a wrapped paragraph moves within itself first.
    const moved = view.moveVertically(range, forward);
    if (forward ? moved.head <= line.to : moved.head >= line.from) return false;
    const target = state.doc.line(next);
    view.dispatch({ selection: { anchor: forward ? target.from : target.to }, scrollIntoView: true, userEvent: 'select' });
    return true;
  };
}

/** Backspace at the start of the line after a widget, or Delete at the end of
 * the line before one, puts the cursor on the embed's line (its source shows)
 * rather than joining a line to text that can't be seen. */
const besideWidgets = Prec.high(
  keymap.of([
    { key: 'ArrowDown', run: stepOnto(true) },
    { key: 'ArrowUp', run: stepOnto(false) },
    {
      key: 'Backspace',
      run: (view) => {
        const { state } = view;
        const range = state.selection.main;
        if (state.selection.ranges.length > 1 || !range.empty) return false;
        const line = state.doc.lineAt(range.head);
        if (range.head !== line.from || !drawnLine(state, line.number - 1)) return false;
        view.dispatch({ selection: { anchor: state.doc.line(line.number - 1).to }, scrollIntoView: true, userEvent: 'select' });
        return true;
      },
    },
    {
      key: 'Delete',
      run: (view) => {
        const { state } = view;
        const range = state.selection.main;
        if (state.selection.ranges.length > 1 || !range.empty) return false;
        const line = state.doc.lineAt(range.head);
        if (range.head !== line.to || !drawnLine(state, line.number + 1)) return false;
        view.dispatch({ selection: { anchor: state.doc.line(line.number + 1).from }, scrollIntoView: true, userEvent: 'select' });
        return true;
      },
    },
  ]),
);

/** Embeds drawn in the editor, as an extension (part of live preview). */
export const editorEmbeds: Extension = [embedField, besideWidgets];
