import { completionStatus, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { dirname } from '../../../../files/paths';
import { kindFromName } from '../../../../files/kinds';
import type { FileEntry, FileStore } from '../../../../files/types';
import { extractOutline } from '../../../outline';
import { shortestTarget } from '../links';
import { projectLinksOf } from './projectLinks';
import { resolveCached } from './wikilinks';

/**
 * Wikilink completion: `[[` offers the project's files, `![[` what an embed
 * can show, `[[Note#` that note's headings, and nothing after `|`. Fuzzy on
 * the name (CodeMirror's own matching), the folder shown beside it. Accepting
 * writes the shortest name that names the file alone and steps over the `]]`
 * bracket closing already put there. Everything here is the project's own
 * files, read on this device: no network, nothing guessed.
 */

/** Above this the note is edited as plain source, and nothing is offered (NoteView's LONG_NOTE_CHARS). */
const LONG_NOTE_CHARS = 200_000;
/** A note bigger than this isn't read for its headings: reading it would hold up typing. */
const HEADINGS_MAX_BYTES = 1_000_000;
const HEADINGS_MAX = 200;
const CACHED_NOTES = 50;

/** What `![[` can show in the page. */
const EMBEDDABLE = new Set(['image', 'canvas', 'note', 'pdf', 'audio', 'video']);

/** Inside `[[` (or `![[`), up to the cursor, on one line. */
const OPEN_LINK = /(!?)\[\[([^[\]\n]*)$/;
/** What the list keeps filtering on as more is typed. */
const NAME_CHARS = /^[^[\]|#\n]*$/;
const HEADING_CHARS = /^[^[\]|#\n]*$/;

const NO_COMPLETION = new Set(['InlineCode', 'CodeText', 'FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'URL']);

function inCode(state: EditorState, pos: number): boolean {
  for (let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (NO_COMPLETION.has(node.name)) return true;
  }
  return false;
}

/** How many leading folders two paths share. */
function sharedFolders(a: string, b: string): number {
  const left = dirname(a) ? dirname(a).toLowerCase().split('/') : [];
  const right = dirname(b) ? dirname(b).toLowerCase().split('/') : [];
  let n = 0;
  while (n < left.length && n < right.length && left[n] === right[n]) n += 1;
  return n;
}

/** The list's order before anything is typed: notes first; then the note's own folder, folders it shares, the shallowest. Within -99..99, as CodeMirror wants. */
function boostFor(file: FileEntry, from: string): number {
  const note = kindFromName(file.name) === 'note';
  const beside = dirname(file.path).toLowerCase() === dirname(from).toLowerCase() ? 20 : 0;
  const shared = Math.min(sharedFolders(file.path, from), 9);
  const shallow = Math.max(0, 9 - file.path.split('/').length);
  return (note ? 50 : 0) + beside + shared + shallow - 50;
}

/** A file as the list names it: a note without `.md`, a drawing as `Name.excalidraw`, anything else whole. */
function listName(file: FileEntry): string {
  return file.name.replace(/\.md$/i, '');
}

/** Writes `text` over [from, to] and steps over (or adds) the link's closing `]]`; the cursor goes after it. */
function insertClosed(view: EditorView, text: string, from: number, to: number): void {
  const after = view.state.doc.sliceString(to, to + 2);
  const present = after === ']]' ? 2 : after.startsWith(']') ? 1 : 0;
  const closing = ']]'.slice(present);
  view.dispatch({
    changes: { from, to, insert: text + closing },
    selection: { anchor: from + text.length + 2 },
    userEvent: 'input.complete',
    scrollIntoView: true,
  });
}

function fileOptions(state: EditorState, embed: boolean, query: string): Completion[] {
  const { files, path } = projectLinksOf(state);
  const byPath = query.includes('/');
  const options: Completion[] = [];
  for (const file of files) {
    if (file.type !== 'file' || file.path === path) continue;
    if (embed && !EMBEDDABLE.has(kindFromName(file.name))) continue;
    const folder = dirname(file.path);
    options.push({
      label: byPath ? file.path.replace(/\.md$/i, '') : listName(file),
      detail: folder || undefined,
      type: kindFromName(file.name) === 'note' ? 'text' : 'variable',
      boost: boostFor(file, path),
      apply: (view, _completion, from, to) => insertClosed(view, shortestTarget(file.path, projectLinksOf(view.state).files), from, to),
    });
  }
  return options;
}

/* ---- headings ------------------------------------------------------------ */

const headingCache = new Map<string, { stamp: string; headings: Promise<string[]> }>();

/** Forgets the headings read so far (tests). */
export function clearHeadingCache(): void {
  headingCache.clear();
}

function headingsOf(text: string): string[] {
  return [...new Set(extractOutline(text).map((heading) => heading.text).filter(Boolean))].slice(0, HEADINGS_MAX);
}

/** A note's headings, read once per version of the file (its size and time), and never from a note too big to read quickly. */
function noteHeadings(store: FileStore | null, file: FileEntry): Promise<string[]> {
  if (!store || (file.size ?? 0) > HEADINGS_MAX_BYTES) return Promise.resolve([]);
  const stamp = `${file.size ?? ''}:${file.modified ?? ''}`;
  const known = headingCache.get(file.path);
  if (known && known.stamp === stamp) return known.headings;
  const headings = store.readText(file.path).then(headingsOf, () => {
    headingCache.delete(file.path);
    return [];
  });
  headingCache.set(file.path, { stamp, headings });
  while (headingCache.size > CACHED_NOTES) headingCache.delete(headingCache.keys().next().value!);
  return headings;
}

async function headingOptions(state: EditorState, target: string): Promise<Completion[]> {
  const { files, path, store } = projectLinksOf(state);
  let headings: string[];
  if (target.trim() === '') headings = headingsOf(state.doc.toString());
  else {
    const file = resolveCached(target.trim(), path, files);
    headings = file && kindFromName(file.name) === 'note' ? await noteHeadings(store, file) : [];
  }
  return headings.map((heading, index) => ({
    label: heading,
    type: 'keyword',
    // In the note's order.
    boost: Math.max(-99, 99 - index),
    apply: (view, _completion, from, to) => insertClosed(view, heading, from, to),
  }));
}

/* ---- the source ---------------------------------------------------------- */

/** The completion source: see the module's comment. */
export async function wikilinkCompletions(context: CompletionContext): Promise<CompletionResult | null> {
  const { state, pos } = context;
  if (state.doc.length > LONG_NOTE_CHARS) return null;
  const line = state.doc.lineAt(pos);
  const match = OPEN_LINK.exec(line.text.slice(0, pos - line.from));
  if (!match || inCode(state, pos)) return null;
  const embed = match[1] === '!';
  const inside = match[2];
  if (inside.includes('|')) return null;
  const hash = inside.indexOf('#');
  if (hash >= 0) {
    const last = inside.lastIndexOf('#');
    if (inside.slice(hash + 1).startsWith('^')) return null;
    const options = await headingOptions(state, inside.slice(0, hash));
    return { from: pos - (inside.length - last - 1), options, validFor: HEADING_CHARS };
  }
  return { from: pos - inside.length, options: fileOptions(state, embed, inside), validFor: NAME_CHARS };
}

/** Says how many files the list offers when it opens, for a screen reader (the list itself is read through aria-activedescendant). */
const announceList = EditorView.updateListener.of((update) => {
  if (completionStatus(update.startState) === 'active' || completionStatus(update.state) !== 'active') return;
  const view = update.view;
  setTimeout(() => {
    if (completionStatus(view.state) !== 'active') return;
    const count = view.dom.querySelectorAll('.cm-tooltip-autocomplete [role="option"]').length;
    if (count) view.dispatch({ effects: EditorView.announce.of(`${count} ${count === 1 ? 'suggestion' : 'suggestions'}. Up and down to choose, Enter to write it, Escape to close.`) });
  }, 0);
});

/** Completion for the note editor: the source, through Markdown's language data, so basicSetup's autocompletion() asks it. */
export const wikilinkCompletion: Extension = [markdownLanguage.data.of({ autocomplete: wikilinkCompletions }), announceList];
