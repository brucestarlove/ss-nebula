import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';

/**
 * What the editor needs to know of a GFM table, read from the syntax tree:
 * which lines a table fills, its rows, where each cell's words are in the
 * text, and the columns' alignment. Pure (a state in, positions out), so the
 * drawing (tableCells.ts) and the field (tables.ts) share one reading, and
 * the unit tests need no DOM.
 */

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

export type Align = 'left' | 'center' | 'right' | null;

/** Where one cell's words are in the document, and the parser's node for them (null for an empty cell, which is a point between its pipes). */
export type CellSlot = { from: number; to: number; node: SyntaxNode | null };

/** A table, as whole lines. */
export type TableBlock = { from: number; to: number };

/** A delimiter row's text: `|:--|--:|`. It needs a pipe to be a table's, and the parse decides the rest. */
const DELIMITER_ROW = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** Whether a line could be a table's delimiter row, by its text alone (a cheap test before the parse is asked). */
export function looksLikeDelimiterRow(text: string): boolean {
  return text.includes('|') && text.includes('-') && DELIMITER_ROW.test(text);
}

function contentStart(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  return line.from + /^[ \t]*/.exec(line.text)![0].length;
}

/** The Table node whose lines hold `pos`, if it stands in the document itself (a table inside a list or a quote stays source). */
export function tableNodeAt(state: EditorState, pos: number): SyntaxNode | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(contentStart(state, pos), 1); node; node = node.parent) {
    if (node.name === 'Table') return node.parent?.name === 'Document' ? node : null;
  }
  return null;
}

/** The table whose delimiter row is the line at `pos`, as whole lines, or null (not parsed yet, or not a table). */
export function tableAroundRow(state: EditorState, pos: number): TableBlock | null {
  const tree = syntaxTree(state);
  // Beyond what's parsed so far the tree is only the document: nothing to read yet.
  if (tree.length < pos) return null;
  const table = tableNodeAt(state, pos);
  if (!table) return null;
  return { from: state.doc.lineAt(table.from).from, to: state.doc.lineAt(table.to).to };
}

/** The header row, then the body rows. */
export function tableRows(table: SyntaxNode): SyntaxNode[] {
  const head = table.getChild('TableHeader');
  return head ? [head, ...table.getChildren('TableRow')] : [];
}

/**
 * The cells of a row, in order, empty ones too. The parser makes a TableCell
 * only for words, so the cells are what lies between the pipes: a pipe at the
 * start or the end of the row opens or closes no cell of its own.
 */
export function rowSlots(row: SyntaxNode): CellSlot[] {
  const slots: CellSlot[] = [];
  let words: SyntaxNode | null = null;
  let pipes = 0;
  let afterPipe = row.from;
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableCell') {
      words = child;
    } else if (child.name === 'TableDelimiter') {
      if (words) slots.push({ from: words.from, to: words.to, node: words });
      else if (pipes > 0) slots.push({ from: afterPipe, to: afterPipe, node: null });
      pipes += 1;
      words = null;
      afterPipe = child.to;
    }
  }
  if (words) slots.push({ from: words.from, to: words.to, node: words });
  return slots;
}

/** Each column's alignment, from the delimiter row under the header (`:--` left, `:-:` centre, `--:` right). */
export function columnAligns(state: EditorState, header: SyntaxNode): Align[] {
  const next = state.doc.lineAt(header.to).number + 1;
  if (next > state.doc.lines) return [];
  const text = state.doc.line(next).text.trim().replace(/^\|/, '').replace(/\|$/, '');
  return text.split('|').map((cell) => {
    const mark = cell.trim();
    const left = mark.startsWith(':');
    const right = mark.endsWith(':');
    if (left && right) return 'center';
    return right ? 'right' : left ? 'left' : null;
  });
}
