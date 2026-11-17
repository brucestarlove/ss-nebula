import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { isApplePlatform } from '../../shared/hooks';
import { INLINE_TAG } from '../markdown';
import { webHref } from './livePreview';
import { columnAligns, rowSlots, tableNodeAt, tableRows } from './tableSyntax';
import { linkTarget, shownParts, wikiNodeOf } from './wikilinks';

/**
 * A GFM table as DOM, for the editor's table widget (tables.ts): the reading
 * view's table, built from the syntax tree. A cell's inline Markdown is
 * drawn simply: bold, italic, strikethrough, code, links, wikilinks (as text
 * in the link colour), `#tags`; a picture is its words, and anything else is
 * its source as written. Everything is built with createElement and
 * textContent, so nothing in a note (raw HTML included) can become markup.
 */

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

const ALIGN_CLASS = { left: 'ws-cm-table-left', center: 'ws-cm-table-center', right: 'ws-cm-table-right' } as const;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** Words, with `#tags` drawn as the page's pills. */
function words(parent: Node, value: string): void {
  let last = 0;
  for (const match of value.matchAll(INLINE_TAG)) {
    const from = (match.index ?? 0) + match[1].length;
    if (from > last) parent.appendChild(document.createTextNode(value.slice(last, from)));
    const tag = element('span', 'ws-tag ws-tag-inline');
    tag.textContent = value.slice(from, from + 1 + match[2].length);
    parent.appendChild(tag);
    last = from + 1 + match[2].length;
  }
  if (last < value.length) parent.appendChild(document.createTextNode(value.slice(last)));
}

function plain(parent: Node, value: string): void {
  if (value) parent.appendChild(document.createTextNode(value));
}

function key(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl';
}

/** Draws [from, to) of a node's text, its child nodes drawn as what they are. */
function inlineRange(state: EditorState, node: SyntaxNode, from: number, to: number, parent: Node): void {
  let pos = from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from) continue;
    if (child.from >= to) break;
    if (child.from > pos) words(parent, state.doc.sliceString(pos, child.from));
    inline(state, child, parent);
    pos = child.to;
  }
  if (pos < to) words(parent, state.doc.sliceString(pos, to));
}

/** An emphasis-like node: its words between its first and last marks. */
function wrapped(state: EditorState, node: SyntaxNode, tag: 'em' | 'strong' | 'del', parent: Node): void {
  const open = node.firstChild;
  const close = node.lastChild;
  if (!open || !close || open === close) {
    plain(parent, state.doc.sliceString(node.from, node.to));
    return;
  }
  const out = element(tag);
  inlineRange(state, node, open.to, close.from, out);
  parent.appendChild(out);
}

function webLink(parent: Node, label: (out: HTMLElement) => void, href: string): void {
  const out = element('span', 'ws-link');
  out.dataset.href = href;
  out.setAttribute('role', 'link');
  out.title = `${href} (${key()}-click to open)`;
  label(out);
  parent.appendChild(out);
}

function inline(state: EditorState, node: SyntaxNode, parent: Node): void {
  const { doc } = state;
  switch (node.name) {
    case 'StrongEmphasis':
      wrapped(state, node, 'strong', parent);
      return;
    case 'Emphasis':
      wrapped(state, node, 'em', parent);
      return;
    case 'Strikethrough':
      wrapped(state, node, 'del', parent);
      return;
    case 'InlineCode': {
      const open = node.firstChild;
      const close = node.lastChild;
      if (!open || !close || open === close) {
        plain(parent, doc.sliceString(node.from, node.to));
        return;
      }
      let text = doc.sliceString(open.to, close.from);
      // CommonMark: one space either side of a code span's words is padding.
      if (text.length > 2 && text.startsWith(' ') && text.endsWith(' ') && text.trim()) text = text.slice(1, -1);
      const out = element('code');
      out.textContent = text;
      parent.appendChild(out);
      return;
    }
    case 'Escape': {
      const text = doc.sliceString(node.from, node.to);
      plain(parent, text.length === 2 && text[0] === '\\' ? text[1] : text);
      return;
    }
    case 'Link': {
      const marks = node.getChildren('LinkMark');
      const url = node.getChild('URL');
      if (!url || marks.length < 3) {
        plain(parent, doc.sliceString(node.from, node.to));
        return;
      }
      const address = doc.sliceString(url.from, url.to);
      const href = webHref(address);
      const label = (out: HTMLElement) => inlineRange(state, node, marks[0].to, marks[1].from, out);
      if (href) {
        webLink(parent, label, href);
      } else {
        const out = element('span', 'ws-link-local');
        out.title = address;
        label(out);
        parent.appendChild(out);
      }
      return;
    }
    case 'Image': {
      // A picture can't be drawn in a cell: its words, quietly, and where it is on hover.
      const marks = node.getChildren('LinkMark');
      const url = node.getChild('URL');
      const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from).trim() : '';
      const out = element('span', 'ws-cm-table-image');
      out.textContent = alt || 'Image';
      if (url) out.title = doc.sliceString(url.from, url.to);
      parent.appendChild(out);
      return;
    }
    case 'Autolink':
    case 'URL': {
      const url = node.name === 'URL' ? node : node.getChild('URL');
      if (!url) {
        plain(parent, doc.sliceString(node.from, node.to));
        return;
      }
      const address = doc.sliceString(url.from, url.to);
      const href = webHref(address);
      if (href) webLink(parent, (out) => (out.textContent = address), href);
      else plain(parent, address);
      return;
    }
    case 'Wikilink':
    case 'Embed': {
      const wiki = wikiNodeOf(state, node);
      if (!wiki) {
        plain(parent, doc.sliceString(node.from, node.to));
        return;
      }
      const target = linkTarget(state, wiki);
      const out = element('span', target.path ? 'ws-wikilink' : 'ws-wikilink ws-wikilink-missing');
      out.title = target.title;
      if (target.path || target.canMake) out.setAttribute('role', 'link');
      out.dataset.wiki = wiki.raw;
      if (wiki.embed) out.dataset.embed = '';
      const parts = shownParts(wiki.raw, wiki.embed).map(([from, to]) => wiki.raw.slice(from, to));
      out.textContent = parts.length ? parts.join(' > ') : wiki.raw.trim();
      parent.appendChild(out);
      return;
    }
    default:
      // Raw HTML, a sub- or superscript, anything else: as written.
      plain(parent, doc.sliceString(node.from, node.to));
  }
}

/** The cell's words as DOM, in `out`. */
function drawCell(state: EditorState, cell: SyntaxNode | null, out: HTMLElement): void {
  if (cell) inlineRange(state, cell, cell.from, cell.to, out);
}

/** The table's text as it is written, for when it can't be drawn from the tree (it went away since). */
export function sourceFallback(state: EditorState, from: number, to: number): HTMLElement {
  const pre = element('pre', 'ws-cm-table-source');
  pre.textContent = state.doc.sliceString(from, to);
  return pre;
}

export type DrawnTable = { dom: HTMLElement; rows: number; columns: number };

/**
 * The table whose lines start at `from`, drawn: a scrolling box holding a
 * real <table> (a header row, then the body). Each cell carries its row (0
 * is the header) and column, so a click can say where in the source it
 * landed. Null when no table starts there any more.
 */
export function drawTable(state: EditorState, from: number): DrawnTable | null {
  const table = tableNodeAt(state, from);
  if (!table) return null;
  const rows = tableRows(table);
  if (rows.length === 0) return null;
  const aligns = columnAligns(state, rows[0]);
  const columns = rowSlots(rows[0]).length;
  if (columns === 0) return null;
  const scroll = element('div', 'ws-cm-table-scroll');
  const grid = element('table', 'ws-cm-table-grid');
  const head = element('thead');
  const body = element('tbody');
  rows.forEach((row, rowIndex) => {
    const tr = element('tr');
    const slots = rowSlots(row);
    // As GFM: a short row is padded, and words past the header's columns are dropped.
    for (let column = 0; column < columns; column += 1) {
      const cell = element(rowIndex === 0 ? 'th' : 'td');
      if (rowIndex === 0) cell.scope = 'col';
      const align = aligns[column];
      if (align) cell.classList.add(ALIGN_CLASS[align]);
      cell.dataset.row = String(rowIndex);
      cell.dataset.col = String(column);
      drawCell(state, slots[column]?.node ?? null, cell);
      tr.appendChild(cell);
    }
    (rowIndex === 0 ? head : body).appendChild(tr);
  });
  grid.append(head, body);
  scroll.appendChild(grid);
  return { dom: scroll, rows: rows.length, columns };
}
