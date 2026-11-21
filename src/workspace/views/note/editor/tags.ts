import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, Prec } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { searchForTag } from '../../../searchEvent';
import { isApplePlatform } from '../../shared/hooks';
import { INLINE_TAG } from '../markdown';
import { frontmatterLines, modifierHeld } from './livePreview';

/**
 * `#tags` in the editor, live preview and the Markdown source alike: each one
 * is marked as a tag (its name in `data-tag`, a tooltip saying what a click
 * does), and a Ctrl/⌘-click on it, or Ctrl/⌘-Enter with the cursor in it,
 * opens search for it, as the same keys open a link (livePreview.ts). A plain
 * click places the cursor.
 *
 * How a tag looks is the stylesheet's: a link, whatever the mode. Live preview
 * also marks tags with the page's `.ws-tag .ws-tag-inline` (livePreview.ts's
 * `tags()`), which carries the underline there; the source has only this
 * mark, and editor.css gives it the same look under `.ws-cm-source`.
 *
 * A tag is its own source, so nothing is hidden or replaced and the cursor
 * has no rule to follow: the marks are the same on the cursor's line and off
 * it. Built for the visible ranges only, so a long note costs one screen.
 * `tagsOn()` is pure (a state and a range in, tags out), which is how a test
 * reads it.
 */

const TAG_CLASS = 'ws-cm-tag';

/** Where a #tag can't be: code, addresses, HTML and comments (livePreview's list), and links, which take the click themselves. */
const NO_TAGS = new Set([
  'InlineCode',
  'FencedCode',
  'CodeBlock',
  'CodeText',
  'URL',
  'Autolink',
  'HTMLBlock',
  'HTMLTag',
  'CommentBlock',
  'Comment',
  'LinkLabel',
  'Link',
  'Image',
  'Wikilink',
  'Embed',
]);

export type EditorTag = { from: number; to: number; /** Lowercase, without the `#`. */ tag: string };

/** The tags on the lines that `from`..`to` touch, outside the front matter and what NO_TAGS names. */
export function tagsOn(state: EditorState, from: number, to: number): EditorTag[] {
  const { doc } = state;
  const tree = syntaxTree(state);
  const front = frontmatterLines(state);
  const found: EditorTag[] = [];
  for (let pos = front ? Math.max(from, front.to + 1) : from; pos <= to; ) {
    const line = doc.lineAt(pos);
    pos = line.to + 1;
    if (!line.text.includes('#')) continue;
    for (const match of line.text.matchAll(INLINE_TAG)) {
      const start = line.from + (match.index ?? 0) + match[1].length;
      let blocked = false;
      for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(start, 1); node; node = node.parent) {
        if (NO_TAGS.has(node.name)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) found.push({ from: start, to: start + 1 + match[2].length, tag: match[2].toLowerCase() });
    }
  }
  return found;
}

function tooltip(tag: string): string {
  return `Search for #${tag} (${isApplePlatform() ? '⌘' : 'Ctrl'}-click)`;
}

function build(view: EditorView): DecorationSet {
  const marks = [];
  for (const range of view.visibleRanges) {
    for (const found of tagsOn(view.state, range.from, range.to)) {
      marks.push(Decoration.mark({ class: TAG_CLASS, attributes: { 'data-tag': found.tag, title: tooltip(found.tag) } }).range(found.from, found.to));
    }
  }
  return Decoration.set(marks, true);
}

const tagMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate) {
      // The cursor doesn't matter: a tag looks the same wherever it is.
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Ctrl/⌘-click on a tag: search for it; a plain click places the cursor, as anywhere in the text. */
const tagClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>(`.${TAG_CLASS}[data-tag]`) : null;
    const tag = element && view.contentDOM.contains(element) ? element.dataset.tag : undefined;
    if (!tag) return false;
    event.preventDefault();
    searchForTag(tag);
    return true;
  },
});

/** Ctrl/⌘-Enter with the cursor in a tag: the keyboard's way to what the click does. Ahead of the task toggle on the same key, which only applies off a tag. */
const tagKey = Prec.highest(
  keymap.of([
    {
      key: 'Mod-Enter',
      run: (view) => {
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head);
        const found = tagsOn(view.state, line.from, line.to).find((candidate) => head >= candidate.from && head <= candidate.to);
        if (!found) return false;
        searchForTag(found.tag);
        return true;
      },
    },
  ]),
);

// modifierHeld is the live preview's own plugin; one instance serves both, as CodeMirror keeps an extension that appears twice once.
export const editorTags: Extension = [tagMarks, tagClicks, tagKey, modifierHeld];
