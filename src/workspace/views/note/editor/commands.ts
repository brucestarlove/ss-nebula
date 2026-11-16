import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { type ChangeSpec, EditorSelection, type EditorState, type Extension, Prec, type SelectionRange } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

/**
 * The note editor's editing helpers: Enter continues a list (and an empty
 * item ends it), Tab and Shift-Tab move list items in and out, typing a mark
 * around a selection wraps it, and Ctrl/⌘-B and -I make words bold or italic.
 * Ctrl/⌘-K stays the app's search: nothing here binds it.
 */

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

/* ---- Enter --------------------------------------------------------------- */

/** CodeMirror's list continuation, except that an empty second item ends a
 * tight list too (rather than opening a blank line above it). */
export const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/* ---- Tab and Shift-Tab ----------------------------------------------------- */

/** The list item that holds the start of `line`'s text, if any. */
function itemOnLine(state: EditorState, lineFrom: number): SyntaxNode | null {
  const text = state.doc.lineAt(lineFrom).text;
  const indent = /^[ \t]*(?:>[ \t]?)*[ \t]*/.exec(text)![0].length;
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(lineFrom + indent, 1); node; node = node.parent) {
    if (node.name === 'ListItem') return state.doc.lineAt(node.from).from === lineFrom ? node : null;
  }
  return null;
}

/** The items whose first line a selection touches, outermost only. */
function selectedItems(state: EditorState): SyntaxNode[] {
  const items: SyntaxNode[] = [];
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos);
      const item = itemOnLine(state, line.from);
      if (item && !items.some((other) => other.from <= item.from && other.to >= item.to)) items.push(item);
      pos = line.to + 1;
    }
  }
  return items;
}

/** Where the item's marker starts, as a column. */
function markerColumn(state: EditorState, item: SyntaxNode): number {
  return item.from - state.doc.lineAt(item.from).from;
}

/** The width of an item's marker and the space after it ('- ' 2, '10. ' 4). */
function markerWidth(state: EditorState, item: SyntaxNode): number {
  const mark = item.getChild('ListMark');
  if (!mark) return 2;
  const after = /^[ \t]*/.exec(state.doc.sliceString(mark.to, Math.min(mark.to + 4, state.doc.lineAt(mark.to).to)))![0].length;
  return mark.to - mark.from + Math.max(1, after);
}

function linesOf(state: EditorState, item: SyntaxNode): number[] {
  const first = state.doc.lineAt(item.from).number;
  const last = state.doc.lineAt(item.to).number;
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/** Tab on a list item: under the item above, by that item's marker, with its own items. */
export function indentListItem(view: EditorView): boolean {
  const { state } = view;
  const items = selectedItems(state);
  if (!items.length) return false;
  const changes: ChangeSpec[] = [];
  for (const item of items) {
    let previous = item.prevSibling;
    while (previous && previous.name !== 'ListItem') previous = previous.prevSibling;
    // A first item has nothing to go under: Tab stays in the list and does nothing.
    if (!previous) continue;
    const by = markerColumn(state, previous) + markerWidth(state, previous) - markerColumn(state, item);
    if (by <= 0) continue;
    for (const n of linesOf(state, item)) {
      const line = state.doc.line(n);
      if (line.text.trim() || n === state.doc.lineAt(item.from).number) changes.push({ from: line.from, insert: ' '.repeat(by) });
    }
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'input.indent' });
  return true;
}

/** Shift-Tab on a list item: back to its parent item's column, with its own items. */
export function outdentListItem(view: EditorView): boolean {
  const { state } = view;
  const items = selectedItems(state);
  if (!items.length) return false;
  const changes: ChangeSpec[] = [];
  for (const item of items) {
    let parent = item.parent?.parent ?? null;
    while (parent && parent.name !== 'ListItem') parent = parent.parent;
    // A top-level item stays where it is.
    if (!parent) continue;
    const by = markerColumn(state, item) - markerColumn(state, parent);
    if (by <= 0) continue;
    for (const n of linesOf(state, item)) {
      const line = state.doc.line(n);
      const spaces = /^ */.exec(line.text)![0].length;
      if (spaces) changes.push({ from: line.from, to: line.from + Math.min(spaces, by) });
    }
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'delete.dedent' });
  return true;
}

/* ---- marks around a selection ------------------------------------------------ */

const WRAPS = new Set(['*', '_', '`', '~']);

/** Typing *, _, ` or ~ with words selected wraps them (twice makes ** and ~~). */
const wrapOnType = EditorView.inputHandler.of((view, from, to, text) => {
  if (!WRAPS.has(text) || view.state.readOnly || view.state.selection.ranges.every((range) => range.empty)) return false;
  view.dispatch(
    view.state.changeByRange((range) => {
      if (range.empty) return { changes: { from: range.from, insert: text }, range: EditorSelection.cursor(range.from + 1) };
      return {
        changes: [
          { from: range.from, insert: text },
          { from: range.to, insert: text },
        ],
        range: EditorSelection.range(range.anchor + 1, range.head + 1),
      };
    }),
    { userEvent: 'input.type' },
  );
  void from;
  void to;
  return true;
});

const SPAN: Record<string, string> = { '**': 'StrongEmphasis', '*': 'Emphasis' };

/** The bold (or italic) span holding `range`, if any. */
function spanAround(state: EditorState, range: SelectionRange, marker: string): SyntaxNode | null {
  const wanted = SPAN[marker];
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(range.from, 1); node; node = node.parent) {
    if (node.name === wanted && node.from <= range.from && node.to >= range.to) return node;
  }
  if (range.empty) {
    for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(range.from, -1); node; node = node.parent) {
      if (node.name === wanted && node.from <= range.from && node.to >= range.to) return node;
    }
  }
  return null;
}

/** Ctrl/⌘-B (`**`) and Ctrl/⌘-I (`*`): wrap the selection, or unwrap the span it's in. */
export function toggleMark(marker: string) {
  return (view: EditorView): boolean => {
    const { state } = view;
    if (state.readOnly) return false;
    const size = marker.length;
    view.dispatch(
      state.changeByRange((range) => {
        // Selected words with the marks just outside them.
        const before = state.sliceDoc(range.from - size, range.from);
        const after = state.sliceDoc(range.to, range.to + size);
        const outside = before === marker && after === marker && !(size === 1 && state.sliceDoc(range.from - 2, range.from) === '**' && state.sliceDoc(range.to, range.to + 2) === '**');
        if (outside) {
          return {
            changes: [
              { from: range.from - size, to: range.from },
              { from: range.to, to: range.to + size },
            ],
            range: EditorSelection.range(range.anchor - size, range.head - size),
          };
        }
        const span = spanAround(state, range, marker);
        if (span) {
          const open = span.firstChild!;
          const close = span.lastChild!;
          const shift = (pos: number) => (pos >= close.to ? pos - (open.to - open.from) - (close.to - close.from) : pos >= open.to ? pos - (open.to - open.from) : open.from);
          return {
            changes: [
              { from: open.from, to: open.to },
              { from: close.from, to: close.to },
            ],
            range: EditorSelection.range(shift(range.anchor), shift(range.head)),
          };
        }
        return {
          changes: [
            { from: range.from, insert: marker },
            { from: range.to, insert: marker },
          ],
          range: EditorSelection.range(range.anchor + size, range.head + size),
        };
      }),
      { userEvent: 'input.format' },
    );
    return true;
  };
}

/** The helpers, as an extension: ahead of basicSetup's keys (its Mod-i selects syntax). */
export const editingHelpers: Extension = [
  Prec.high(
    keymap.of([
      { key: 'Enter', run: (view) => continueMarkup(view) },
      { key: 'Backspace', run: deleteMarkupBackward },
      { key: 'Tab', run: indentListItem },
      { key: 'Shift-Tab', run: outdentListItem },
      { key: 'Mod-b', run: toggleMark('**') },
      { key: 'Mod-i', run: toggleMark('*') },
    ]),
  ),
  wrapOnType,
];
