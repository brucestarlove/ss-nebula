import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Range, RangeSet } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { isApplePlatform } from '../../shared/hooks';
import { INLINE_TAG } from '../markdown';
import { projectLinksFacet } from './projectLinks';
import { followLink, linkTarget, shownParts, wikiNodeAt, wikiNodeOf } from './wikilinks';

/**
 * Live preview: the Markdown drawn as the page it makes, around the line
 * being edited. Decoration only: the document is always the file's text, so
 * undo, search, selection, copy and the saved bytes are the Markdown, and a
 * change here can never change the file.
 *
 * Built from the syntax tree for the ranges on screen (CodeMirror's visible
 * ranges), so a long note costs what one screen of it costs. buildPreview()
 * is pure (an EditorState and ranges in, decorations out), which is how the
 * unit tests read it.
 *
 * What shows its Markdown, and when:
 * - block marks (#, >, a rule, code fences) on every line a selection
 *   touches; headings keep their size on the cursor line;
 * - list markers and task boxes stay drawn while you type on their line (as
 *   Obsidian keeps them), and show their Markdown with the cursor at the
 *   line's start or a selection over them;
 * - inline marks when a selection touches the span (inside it or at an edge).
 * Every hidden range is atomic: the cursor steps over it in one move, and
 * never lands inside text it can't see.
 */

type Span = { from: number; to: number };
/** @lezer/common's SyntaxNode, named through the language package (lezer isn't a direct dependency). */
type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

export type Preview = {
  decorations: DecorationSet;
  /** The hidden and replaced ranges, which the cursor treats as one step. */
  atomic: RangeSet<Decoration>;
};

/* ---- widgets ------------------------------------------------------------- */

/** A task's box: a real checkbox; clicking it ticks the task in the text. */
class TaskWidget extends WidgetType {
  readonly done: boolean;
  readonly label: string;

  constructor(done: boolean, label: string) {
    super();
    this.done = done;
    this.label = label;
  }

  eq(other: TaskWidget) {
    return other.done === this.done && other.label === this.label;
  }

  describe() {
    return `task(${this.done ? 'done' : 'open'})`;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = 'ws-cm-marker ws-cm-task-box ws-tasks';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'ws-check';
    box.checked = this.done;
    box.tabIndex = -1;
    box.setAttribute('aria-label', this.label || 'Task');
    // The editor keeps its focus and cursor; the text says whether it's
    // ticked. The wrapper takes the click, so its wider target (editor.css)
    // ticks the box too: WebKit doesn't move a tap that misses it, as Chromium does.
    wrap.addEventListener('mousedown', (event) => event.preventDefault());
    wrap.addEventListener('click', (event) => {
      event.preventDefault();
      toggleTaskAt(view, view.posAtDOM(wrap));
    });
    wrap.append(box);
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

/** A bullet, or a list item's number as written. */
class MarkerWidget extends WidgetType {
  readonly text: string | null;

  constructor(text: string | null) {
    super();
    this.text = text;
  }

  eq(other: MarkerWidget) {
    return other.text === this.text;
  }

  describe() {
    return this.text === null ? 'bullet' : `number(${this.text})`;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = this.text === null ? 'ws-cm-marker ws-cm-bullet' : 'ws-cm-marker ws-cm-number';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = this.text ?? '•';
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }

  describe() {
    return 'rule';
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'ws-cm-rule';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

/** A wikilink's '#' between a note and its heading, drawn as the page draws it: ' > '. */
class SeparatorWidget extends WidgetType {
  readonly className: string;

  constructor(className: string) {
    super();
    this.className = className;
  }

  eq(other: SeparatorWidget) {
    return other.className === this.className;
  }

  describe() {
    return 'separator';
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = `${this.className} ws-cm-wikilink-sep`;
    span.textContent = ' > ';
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

const hidden = Decoration.replace({ kind: 'hide' });
const rule = Decoration.replace({ widget: new RuleWidget() });
const bullet = Decoration.replace({ widget: new MarkerWidget(null) });

function lineClass(className: string) {
  return Decoration.line({ class: className });
}

function mark(className: string) {
  return Decoration.mark({ class: className });
}

/* ---- the task box -------------------------------------------------------- */

const TASK_BOX = /^([ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[([ xX])\]/;

/** Ticks or unticks the task whose line holds `pos`: one change, one undo step. */
export function toggleTaskAt(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const match = TASK_BOX.exec(line.text);
  if (!match) return false;
  const at = line.from + match[1].length + 1;
  view.dispatch({ changes: { from: at, to: at + 1, insert: match[2] === ' ' ? 'x' : ' ' }, userEvent: 'input.toggle' });
  return true;
}

/* ---- front matter -------------------------------------------------------- */

const OPENING = /^\uFEFF?---[ \t]*$/;
const CLOSING = /^(?:---|\.\.\.)[ \t]*$/;
const FRONTMATTER_LINES = 500;

/** The front matter's lines (a --- fence at the very top), or null. */
export function frontmatterLines(state: EditorState): { first: number; last: number; to: number } | null {
  const { doc } = state;
  if (!OPENING.test(doc.line(1).text)) return null;
  const limit = Math.min(doc.lines, FRONTMATTER_LINES);
  for (let n = 2; n <= limit; n += 1) {
    const line = doc.line(n);
    if (CLOSING.test(line.text)) return { first: 1, last: n, to: line.to };
  }
  return null;
}

/* ---- building ------------------------------------------------------------ */

class Collector {
  readonly decorations: Range<Decoration>[] = [];
  readonly atomic: Range<Decoration>[] = [];
  private readonly seen = new Set<string>();
  private readonly lines = new Map<number, Set<string>>();
  readonly state: EditorState;

  constructor(state: EditorState) {
    this.state = state;
  }

  /** Adds classes to a line; a line in more than one block (a quote's list
   * item, a list item's code) gets each block's classes. */
  line(at: number, className: string) {
    const from = this.state.doc.lineAt(at).from;
    let classes = this.lines.get(from);
    if (!classes) this.lines.set(from, (classes = new Set()));
    for (const name of className.split(' ')) if (name) classes.add(name);
  }

  /** Whether a line already has a class (it belongs to a block). */
  hasLine(at: number): boolean {
    return this.lines.has(this.state.doc.lineAt(at).from);
  }

  /** Every decoration, the lines' among them. */
  all(): Range<Decoration>[] {
    const lines = [...this.lines].map(([from, classes]) => lineClass([...classes].join(' ')).range(from));
    return [...lines, ...this.decorations];
  }

  replace(from: number, to: number, decoration: Decoration) {
    if (to <= from) return;
    const key = `r${from}:${to}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const range = decoration.range(from, to);
    this.decorations.push(range);
    this.atomic.push(range);
  }

  mark(from: number, to: number, className: string, attributes?: Record<string, string>) {
    if (to <= from) return;
    const key = `m${from}:${to}:${className}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.decorations.push((attributes ? Decoration.mark({ class: className, attributes }) : mark(className)).range(from, to));
  }
}

/** Where selections are, for deciding what shows its Markdown. */
class Selections {
  private readonly lines: Array<[number, number]>;
  private readonly state: EditorState;

  constructor(state: EditorState) {
    this.state = state;
    this.lines = state.selection.ranges.map((range) => [state.doc.lineAt(range.from).number, state.doc.lineAt(range.to).number]);
  }

  /** A selection is on, or runs through, line `n`. */
  onLine(n: number): boolean {
    return this.lines.some(([first, last]) => n >= first && n <= last);
  }

  /** A selection touches [from, to]: inside it or at either edge. */
  touches(from: number, to: number): boolean {
    return this.state.selection.ranges.some((range) => range.from <= to && range.to >= from);
  }

  /** A cursor at the start of [from, to) or inside it, or a selection over it. */
  enters(from: number, to: number): boolean {
    return this.state.selection.ranges.some((range) => (range.empty ? range.head >= from && range.head < to : range.from < to && range.to > from));
  }
}

const HEADINGS: Record<string, number> = { ATXHeading1: 1, ATXHeading2: 2, ATXHeading3: 3, ATXHeading4: 4, ATXHeading5: 5, ATXHeading6: 6 };

function listDepth(item: SyntaxNode): number {
  let depth = 0;
  for (let parent = item.parent; parent; parent = parent.parent) if (parent.name === 'ListItem') depth += 1;
  return depth;
}

function taskLabel(state: EditorState, task: SyntaxNode, marker: SyntaxNode): string {
  const line = state.doc.lineAt(marker.to);
  return state.doc.sliceString(marker.to, Math.min(task.to, line.to)).trim();
}

const LIST_START = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/** A list item's later lines (a paragraph that goes on, a code block in the
 * item): indented to the item's text, their own indentation hidden. */
function continuationLines(out: Collector, sel: Selections, item: SyntaxNode, depth: number, range: Span): void {
  const { doc } = out.state;
  const first = doc.lineAt(item.from).number;
  const last = doc.lineAt(item.to).number;
  for (let n = Math.max(first + 1, doc.lineAt(range.from).number); n <= Math.min(last, doc.lineAt(range.to).number); n += 1) {
    const line = doc.line(n);
    if (!line.text.trim() || LIST_START.test(line.text)) continue;
    const indent = /^[ \t]*/.exec(line.text)![0].length;
    // Only the lines this item holds itself, not a nested item's.
    let inner: SyntaxNode | null = syntaxTree(out.state).resolveInner(line.from + indent, 1);
    while (inner && inner.name !== 'ListItem') inner = inner.parent;
    if (!inner || inner.from !== item.from) continue;
    out.line(line.from, `ws-cm-li-cont${depth ? ` ws-cm-li-${Math.min(depth, 6)}` : ''}`);
    if (indent && !sel.onLine(n)) out.replace(line.from, line.from + indent, hidden);
  }
}

/* ---- inline syntax ------------------------------------------------------- */

/** Links that may open in a new tab, on an explicit Ctrl/⌘-click. */
export const WEB_LINK = /^(?:https?:|mailto:|tel:)/i;

/** What a link's address opens: a web address, or nothing (a path in the project). */
export function webHref(url: string): string | undefined {
  const address = url.trim().replace(/^<|>$/g, '');
  if (WEB_LINK.test(address)) return address;
  if (/^www\./i.test(address)) return `https://${address}`;
  return undefined;
}

function linkMark(out: Collector, from: number, to: number, url: string) {
  const href = webHref(url);
  if (href) out.mark(from, to, 'ws-link', { 'data-href': href, title: `${href} (${isApplePlatform() ? '⌘' : 'Ctrl'}-click to open)` });
  else out.mark(from, to, 'ws-link-local', { title: url });
}

/** Opens a web address in a new tab that can't reach back to this one. */
export function openWebLink(href: string): void {
  window.open(href, '_blank', 'noopener,noreferrer');
}

/** The web address of the link at `pos`, if there is one. */
export function webLinkAt(state: EditorState, pos: number): string | undefined {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === 'URL' || node.name === 'Link' || node.name === 'Autolink') {
      const url = node.name === 'URL' ? node : node.getChild('URL');
      if (url) return webHref(state.doc.sliceString(url.from, url.to));
    }
  }
  return undefined;
}

const SPAN_MARKS: Record<string, string> = { Emphasis: 'EmphasisMark', StrongEmphasis: 'EmphasisMark', Strikethrough: 'StrikethroughMark' };

/** Returns true when the node was inline syntax (handled here). */
function inline(out: Collector, sel: Selections, node: SyntaxNode): boolean {
  const { doc } = out.state;
  const markName = SPAN_MARKS[node.name];
  if (markName) {
    if (!sel.touches(node.from, node.to)) {
      for (let child = node.firstChild; child; child = child.nextSibling) if (child.name === markName) out.replace(child.from, child.to, hidden);
    }
    return true;
  }
  switch (node.name) {
    case 'InlineCode': {
      const open = node.firstChild;
      const close = node.lastChild;
      if (!open || !close || open === close || open.name !== 'CodeMark' || close.name !== 'CodeMark') return true;
      out.mark(open.to, close.from, 'ws-cm-inline-code');
      if (!sel.touches(node.from, node.to)) {
        out.replace(open.from, open.to, hidden);
        out.replace(close.from, close.to, hidden);
      }
      return true;
    }
    case 'Link': {
      // [words](address): a link with an address. [[wikilinks]] and [refs] have none.
      const marks = node.getChildren('LinkMark');
      const url = node.getChild('URL');
      if (!url || marks.length < 3 || node.parent?.name === 'Image') return true;
      const [open, close] = marks;
      linkMark(out, open.to, close.from, doc.sliceString(url.from, url.to));
      if (!sel.touches(node.from, node.to)) {
        out.replace(open.from, open.to, hidden);
        out.replace(close.from, node.to, hidden);
      }
      return true;
    }
    case 'Autolink': {
      const url = node.getChild('URL');
      if (!url) return true;
      linkMark(out, url.from, url.to, doc.sliceString(url.from, url.to));
      if (!sel.touches(node.from, node.to)) {
        out.replace(node.from, url.from, hidden);
        out.replace(url.to, node.to, hidden);
      }
      return true;
    }
    case 'Wikilink':
    case 'Embed': {
      // [[Note#Heading|alias]] as the page draws it: the alias, or 'Note > Heading'.
      // Embeds that stand on a line of their own are drawn whole (embeds.ts).
      const wiki = wikiNodeOf(out.state, node);
      if (!wiki) return true;
      const target = linkTarget(out.state, wiki);
      const className = target.path ? 'ws-wikilink' : 'ws-wikilink ws-wikilink-missing';
      const attributes = { title: target.title };
      const parts = shownParts(wiki.raw, wiki.embed).map(([from, to]) => [wiki.inner + from, wiki.inner + to] as const);
      if (sel.touches(node.from, node.to) || parts.length === 0) {
        out.mark(wiki.inner, node.to - 2, className, attributes);
        return true;
      }
      out.replace(node.from, parts[0][0], hidden);
      parts.forEach(([from, to], index) => {
        out.mark(from, to, className, attributes);
        const next = parts[index + 1];
        if (next) out.replace(to, next[0], Decoration.replace({ widget: new SeparatorWidget(className) }));
      });
      out.replace(parts[parts.length - 1][1], node.to, hidden);
      return true;
    }
    case 'URL': {
      // A bare address (GFM's autolinks); one inside a link or an image is theirs.
      const parent = node.parent?.name;
      if (parent !== 'Link' && parent !== 'Autolink' && parent !== 'Image') linkMark(out, node.from, node.to, doc.sliceString(node.from, node.to));
      return true;
    }
    default:
      return false;
  }
}

/** Where a #tag can't be: code, addresses, HTML and comments. */
const NO_TAGS = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'URL', 'Autolink', 'HTMLBlock', 'HTMLTag', 'CommentBlock', 'Comment', 'LinkLabel']);

/** #tags on the lines of `range`, drawn as the page's tag pills (remarkNebula's shape). */
function tags(out: Collector, range: Span): void {
  const { doc } = out.state;
  const tree = syntaxTree(out.state);
  for (let pos = range.from; pos <= range.to; ) {
    const line = doc.lineAt(pos);
    if (line.text.includes('#')) {
      for (const match of line.text.matchAll(INLINE_TAG)) {
        const from = line.from + (match.index ?? 0) + match[1].length;
        const to = from + 1 + match[2].length;
        let blocked = false;
        for (let node: SyntaxNode | null = tree.resolveInner(from, 1); node; node = node.parent) {
          if (NO_TAGS.has(node.name)) {
            blocked = true;
            break;
          }
        }
        if (!blocked) out.mark(from, to, 'ws-tag ws-tag-inline');
      }
    }
    pos = line.to + 1;
  }
}

function blocks(out: Collector, sel: Selections, node: SyntaxNode, range: Span): void {
  const { state } = out;
  const { doc } = state;
  const lineNo = (pos: number) => doc.lineAt(pos).number;
  const level = HEADINGS[node.name];

  if (level) {
    out.line(node.from, `ws-cm-heading ws-cm-h${level}`);
    if (!sel.onLine(lineNo(node.from))) {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name !== 'HeaderMark') continue;
        if (child.from === node.from) {
          // The opening #s and the space after them.
          const after = doc.sliceString(child.to, child.to + 1);
          out.replace(child.from, child.to + (after === ' ' || after === '\t' ? 1 : 0), hidden);
        } else {
          // A closing sequence ('## Title ##') and the space before it.
          let from = child.from;
          while (from > node.from && /[ \t]/.test(doc.sliceString(from - 1, from))) from -= 1;
          out.replace(from, child.to, hidden);
        }
      }
    }
    return;
  }

  switch (node.name) {
    case 'Blockquote': {
      for (let pos = Math.max(node.from, range.from); pos <= Math.min(node.to, range.to); ) {
        const line = doc.lineAt(pos);
        out.line(line.from, 'ws-cm-quote');
        pos = line.to + 1;
      }
      break;
    }
    case 'QuoteMark': {
      if (sel.onLine(lineNo(node.from))) break;
      const after = doc.sliceString(node.to, node.to + 1);
      out.replace(node.from, node.to + (after === ' ' ? 1 : 0), hidden);
      break;
    }
    case 'ListItem': {
      const markNode = node.firstChild;
      if (!markNode || markNode.name !== 'ListMark') break;
      const line = doc.lineAt(markNode.from);
      if (line.from < range.from || line.from > range.to) break;
      const depth = listDepth(node);
      const task = markNode.nextSibling?.name === 'Task' ? markNode.nextSibling : null;
      const box = task?.firstChild?.name === 'TaskMarker' ? task.firstChild : null;
      const done = box ? /x/i.test(doc.sliceString(box.from + 1, box.to - 1)) : false;
      out.line(line.from, ['ws-cm-li', depth ? `ws-cm-li-${Math.min(depth, 6)}` : '', box ? 'ws-cm-task' : '', done ? 'ws-cm-done' : ''].filter(Boolean).join(' '));
      // The marker's whole prefix: indentation, marker, box and one space after.
      const prefixEnd = (box ?? markNode).to;
      const end = prefixEnd + (/[ \t]/.test(doc.sliceString(prefixEnd, prefixEnd + 1)) ? 1 : 0);
      continuationLines(out, sel, node, depth, range);
      if (sel.enters(line.from, end)) break;
      // Inside a quote, the prefix starts after the quote's marks.
      const start = doc.sliceString(line.from, markNode.from).includes('>') ? markNode.from : line.from;
      if (box && task) {
        out.replace(start, end, Decoration.replace({ widget: new TaskWidget(done, taskLabel(state, task, box)) }));
      } else {
        const text = doc.sliceString(markNode.from, markNode.to);
        out.replace(start, end, /\d/.test(text) ? Decoration.replace({ widget: new MarkerWidget(text) }) : bullet);
      }
      break;
    }
    case 'HorizontalRule': {
      out.line(node.from, 'ws-cm-hr');
      if (!sel.onLine(lineNo(node.from))) out.replace(node.from, node.to, rule);
      break;
    }
    case 'Table': {
      const head = node.getChild('TableHeader');
      for (let pos = Math.max(node.from, range.from); pos <= Math.min(node.to, range.to); ) {
        const line = doc.lineAt(pos);
        const isHead = head && line.from === doc.lineAt(head.from).from;
        const isRule = !isHead && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line.text);
        out.line(line.from, `ws-cm-table${isHead ? ' ws-cm-table-head' : ''}${isRule ? ' ws-cm-table-rule' : ''}`);
        pos = line.to + 1;
      }
      break;
    }
    case 'TableDelimiter': {
      if (node.to - node.from === 1) out.mark(node.from, node.to, 'ws-cm-pipe');
      break;
    }
    case 'FencedCode': {
      const first = lineNo(node.from);
      const last = lineNo(node.to);
      const closed = last > first && /^\s*(`{3,}|~{3,})\s*$/.test(doc.line(last).text);
      const open = node.firstChild;
      const revealed = sel.touches(node.from, node.to);
      const info = node.getChild('CodeInfo');
      for (let n = Math.max(first, lineNo(range.from)); n <= Math.min(last, lineNo(range.to)); n += 1) {
        const classes = ['ws-cm-code'];
        if (n === first) classes.push('ws-cm-code-first');
        if (n === last) classes.push('ws-cm-code-last');
        if (n === first || (n === last && closed)) classes.push('ws-cm-fence');
        // A fence line with nothing left to show is thin: the panel's padding, not a line.
        if (!revealed && ((n === first && !info) || (n === last && closed && n !== first))) classes.push('ws-cm-fence-hidden');
        out.line(doc.line(n).from, classes.join(' '));
      }
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'CodeMark' && !revealed) out.replace(child.from, child.to, hidden);
        if (child.name === 'CodeInfo' && child.from > (open?.from ?? -1)) out.mark(child.from, child.to, 'ws-cm-code-info');
      }
      break;
    }
    default:
      break;
  }
}

/** A blank line between blocks: the page's gap between paragraphs rather than
 * a whole line (editor.css), so an edited note is about as long as the read
 * one. Not under a cursor (where the next words go), and not in a block (code
 * keeps its blank lines as written). */
function blankLines(out: Collector, sel: Selections, range: Span): void {
  const { doc } = out.state;
  for (let n = doc.lineAt(range.from).number; n <= doc.lineAt(range.to).number; n += 1) {
    const line = doc.line(n);
    if (line.text.trim() !== '' || sel.onLine(n) || out.hasLine(line.from)) continue;
    out.line(line.from, 'ws-cm-blank');
  }
}

/** Live preview's decorations for `ranges` of `state`: see the module's comment. */
export function buildPreview(state: EditorState, ranges: readonly Span[]): Preview {
  const out = new Collector(state);
  const sel = new Selections(state);
  const front = frontmatterLines(state);
  const tree = syntaxTree(state);

  for (const range of ranges) {
    if (front) {
      for (let n = Math.max(front.first, state.doc.lineAt(range.from).number); n <= Math.min(front.last, state.doc.lineAt(range.to).number); n += 1) {
        const classes = ['ws-cm-frontmatter'];
        if (n === front.first) classes.push('ws-cm-frontmatter-first');
        if (n === front.last) classes.push('ws-cm-frontmatter-last');
        out.line(state.doc.line(n).from, classes.join(' '));
      }
    }
    // Nothing the parser made of the front matter (a rule, a setext heading) is Markdown.
    const from = front ? Math.max(range.from, front.to + 1) : range.from;
    if (from > range.to) continue;
    tree.iterate({
      from,
      to: range.to,
      enter: (ref) => {
        if (!inline(out, sel, ref.node)) blocks(out, sel, ref.node, { from, to: range.to });
      },
    });
    tags(out, { from, to: range.to });
    blankLines(out, sel, { from, to: range.to });
  }

  return {
    decorations: Decoration.set(out.all(), true),
    atomic: Decoration.set(out.atomic, true),
  };
}

/* ---- the extension ------------------------------------------------------- */

const previewPlugin = ViewPlugin.fromClass(
  class {
    preview: Preview;

    constructor(view: EditorView) {
      this.preview = buildPreview(view.state, view.visibleRanges);
    }

    update(update: ViewUpdate) {
      const project = update.startState.facet(projectLinksFacet) !== update.state.facet(projectLinksFacet);
      if (update.docChanged || update.selectionSet || update.viewportChanged || project || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.preview = buildPreview(update.state, update.view.visibleRanges);
      }
    }
  },
  {
    decorations: (plugin) => plugin.preview.decorations,
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.preview.atomic ?? Decoration.none),
  },
);

/** A link opens on an explicit Ctrl/⌘-click only; a plain click places the
 * cursor, as anywhere in the text. A web link opens in a new tab; a wikilink
 * opens its file in Nebula (or makes the note it names). */
const linkClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    // ⌘ on a Mac, Ctrl elsewhere; either is taken, as browsers report platforms loosely.
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
    const wiki = event.target instanceof Element ? event.target.closest<HTMLElement>('.ws-wikilink') : null;
    if (wiki && view.contentDOM.contains(wiki)) {
      const node = wikiNodeAt(view.state, view.posAtDOM(wiki));
      if (!node) return false;
      event.preventDefault();
      followLink(view.state, node);
      return true;
    }
    const link = event.target instanceof Element ? event.target.closest<HTMLElement>('.ws-link[data-href]') : null;
    const href = link?.dataset.href;
    if (!href || !webHref(href)) return false;
    event.preventDefault();
    openWebLink(href);
    return true;
  },
});

/** While Ctrl/⌘ is held, links show the pointer that says a click opens them. */
const modifierHeld = ViewPlugin.fromClass(
  class {
    readonly dom: HTMLElement;
    readonly onKey: (event: KeyboardEvent) => void;
    readonly onBlur: () => void;

    constructor(view: EditorView) {
      this.dom = view.dom;
      this.onKey = (event) => this.dom.classList.toggle('ws-cm-mod', event.metaKey || event.ctrlKey);
      this.onBlur = () => this.dom.classList.remove('ws-cm-mod');
      window.addEventListener('keydown', this.onKey);
      window.addEventListener('keyup', this.onKey);
      window.addEventListener('blur', this.onBlur);
    }

    destroy() {
      window.removeEventListener('keydown', this.onKey);
      window.removeEventListener('keyup', this.onKey);
      window.removeEventListener('blur', this.onBlur);
      this.dom.classList.remove('ws-cm-mod');
    }
  },
);

/** Live preview, as an editor extension. */
export const livePreview: Extension = [previewPlugin, linkClicks, modifierHeld];
