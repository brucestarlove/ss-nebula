import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { EditorView } from 'codemirror';

/**
 * Token colours, from CSS variables that code.css maps onto ss-ui's tokens
 * (accent, accent-2, blue, danger, muted), so night and day each get colours
 * made for them. No colour is fixed here.
 */
export const nebulaHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self], color: 'var(--ws-code-keyword)' },
  { tag: [t.string, t.special(t.string), t.character, t.regexp, t.escape, t.monospace], color: 'var(--ws-code-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.constant(t.variableName)], color: 'var(--ws-code-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.quote], color: 'var(--ws-code-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.labelName], color: 'var(--ws-code-type)' },
  { tag: [t.meta, t.annotation, t.processingInstruction, t.contentSeparator, t.list], color: 'var(--ws-code-comment)' },
  { tag: [t.link, t.url], color: 'var(--ws-code-link)', textDecoration: 'underline' },
  { tag: [t.invalid, t.deleted], color: 'var(--ws-code-invalid)' },
  { tag: t.heading, fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
]);

/** The highlight style as an editor extension. */
export const nebulaHighlighting = syntaxHighlighting(nebulaHighlightStyle);

/**
 * The editor's look, from the page's CSS variables, so it follows night and
 * day without being rebuilt. Token colours are nebulaHighlightStyle (above).
 */
export const nebulaEditorTheme = EditorView.theme({
  '&': {
    color: 'var(--ink)',
    backgroundColor: 'transparent',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'var(--ws-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace)',
    lineHeight: '1.65',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '0.75rem 0 2rem',
  },
  '.cm-line': {
    padding: '0 1.25rem 0 0.5rem',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--ws-cm-selection-blur)',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--ws-cm-selection)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--ws-muted, var(--muted))',
    border: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 0.5rem 0 1rem',
    minWidth: '2.6rem',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--ink)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--ws-cm-active-line)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--subtle-bg)',
    border: '1px solid var(--line)',
    color: 'var(--ws-muted, var(--muted))',
  },
  '.cm-panels': {
    backgroundColor: 'var(--surface-raised)',
    color: 'var(--ink)',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid var(--line)',
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: '1px solid var(--line)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-raised)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    borderRadius: '8px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-active, var(--subtle-bg))',
    color: 'var(--ink)',
  },
});
