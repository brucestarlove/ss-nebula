import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Compartment, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { nebulaEditorTheme, nebulaNoteHighlighting } from '../../code/codeTheme';
import { editorNames, escapeLeaves, keyboardFocus } from './accessibility';
import { editingHelpers } from './commands';
import { editorEmbeds } from './embeds';
import { wikilinkCompletion } from './completion';
import { livePreview, openWebLink, toggleTaskAt, webLinkAt } from './livePreview';
import { followLink, wikilinkSyntax, wikiNodeAt } from './wikilinks';
import { editorTables } from './tables';
import { editorTags } from './tags';

export type SetupOptions = {
  /** The editor's accessible name. */
  label: string;
  readOnly: boolean;
  /** The plain Markdown, every decoration off (the source switch). */
  source?: boolean;
  /** Where the mode lives, so NoteEditor can switch it without a new editor. */
  mode?: Compartment;
  /** Where the name lives, so NoteEditor can change it with the mode. */
  names?: Compartment;
  /** The id of what describes the editor (its keys), for assistive technology. */
  describedBy?: string;
  /** Escape: move the focus out of the editor to the page's toolbar. False when there's nowhere to go. */
  leave?: () => boolean;
};

/**
 * What live preview adds: the drawn page (decorations, embeds, links that
 * open). The source has none of it: the Markdown as written, in the note's
 * own highlighting (marks muted, words in ink; CodeEditor's code colours
 * muted every list). One compartment holds it, so switching keeps the
 * editor, its undo history and its selection.
 */
export function modeExtensions(source: boolean): Extension {
  return source ? [] : [livePreview, editorEmbeds, editorTables, editorTags];
}

/**
 * Everything the note editor is, apart from what React hands it (the text,
 * the links compartment, the change listener). One place, so a test can build
 * the same editor state without a DOM.
 */
export function noteEditorSetup({ label, readOnly, source = false, mode = new Compartment(), names = new Compartment(), describedBy, leave }: SetupOptions): Extension {
  return [
    basicSetup,
    // GFM (tables, task lists, strikethrough, autolinks); code fences take
    // their language from language-data, loaded when a fence names one.
    // The Markdown keys (Enter, Backspace) come with the editing helpers.
    // [[wikilinks]] and ![[embeds]] are nodes of their own (wikilinks.ts).
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false, extensions: wikilinkSyntax }),
    editingHelpers,
    // [[ offers the project's files (basicSetup's autocompletion asks Markdown's language data).
    wikilinkCompletion,
    EditorView.lineWrapping,
    nebulaEditorTheme,
    nebulaNoteHighlighting,
    // Live preview (a line holding only an embed drawn as the page draws it, too), or the source.
    mode.of(modeExtensions(source)),
    Prec.high(
      keymap.of([
        // Ctrl/⌘-Enter opens the wikilink or web link at the cursor, or ticks
        // the task on the cursor's line (as in Obsidian): the keyboard's way
        // to what a Ctrl/⌘-click and the box (which takes no focus) do.
        {
          key: 'Mod-Enter',
          run: (view) => {
            const wiki = wikiNodeAt(view.state, view.state.selection.main.head);
            if (wiki && followLink(view.state, wiki)) return true;
            const href = webLinkAt(view.state, view.state.selection.main.head);
            if (href) {
              openWebLink(href);
              return true;
            }
            return !readOnly && toggleTaskAt(view, view.state.selection.main.head);
          },
        },
      ]),
    ),
    names.of(editorNames(label, readOnly, describedBy)),
    keyboardFocus,
    escapeLeaves(leave ?? (() => false)),
    EditorView.editable.of(!readOnly),
  ];
}
