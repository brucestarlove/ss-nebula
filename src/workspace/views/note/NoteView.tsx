import { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { FileViewProps } from '../../../files/types';
import { TagButton } from '../../components/TagButton';
import OtherView from '../other/OtherView';
import { downloadEntry } from '../shared/download';
import { folderOf, formatBytes, formatCount, formatEdited, titleFromName } from '../shared/format';
import { Glyph } from '../shared/Glyph';
import { isApplePlatform, isModKey, isShown, useNow } from '../shared/hooks';
import { PageWidthContext } from '../shared/pageWidth';
import { SessionBars, ViewLoading } from '../shared/SessionBars';
import { YouContext } from '../shared/you';
import { useTextSession } from '../shared/useTextSession';
import { useEditMode } from './editor/editMode';
import { readOpensEditing, writeOpensEditing } from './editor/opensEditing';
import { countWords, noteTags, parseFrontmatter, toggleTaskAt } from './markdown';
import { NoteEnvContext, type NoteEnv } from './embeds/NoteEnv';
import { NoteContext, WebImagesContext, webImagesAllowed, type WebImages } from './noteContexts';
import { NoteMarkdown } from './prose';
import '../views.css';
import './note.css';

// CodeMirror loads only when a note is edited (the load budget).
const NoteEditor = lazy(() => import('./editor/NoteEditor'));

/** A note: rendered markdown on a page, with a source editor (⌘E / Ctrl+E). */
/**
 * Above this many characters a note opens as its source (Bruce, 2026-10-25:
 * "did we account for a note's length being too long"). Reading view renders
 * the whole Markdown at once: about 2.3 s for a 100 KB note, 10 s for 500 KB
 * and 27 s for 1 MB (react-markdown with GFM, measured in Node). The editor
 * draws only what's on screen, so it stays quick at any length.
 */
export const LONG_NOTE_CHARS = 200_000;

/** How long the status line keeps saying an image wasn't added. */
const IMAGE_NOTE_MS = 10_000;

/** Whether a keydown is Mod+Shift+<key>: ⌘⇧ on Apple platforms, Ctrl+Shift elsewhere (hooks.ts's isModKey, with Shift). */
function isModShiftKey(event: KeyboardEvent, key: string, apple: boolean): boolean {
  if (event.altKey || !event.shiftKey || event.key.toLowerCase() !== key) return false;
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export default function NoteView(props: FileViewProps & { longNoteChars?: number }) {
  const { projectId, store, entry, onStatus, onDirty, longNoteChars = LONG_NOTE_CHARS } = props;
  const { session, state } = useTextSession(store, entry.path, projectId);
  const imagesKey = `${projectId}\u0000${entry.path}`;
  const [, imagesAllowed] = useReducer((count: number) => count + 1, 0);
  const [heldImages, setHeldImages] = useState(0);
  const loadImages = webImagesAllowed.has(imagesKey);
  const webImages = useMemo<WebImages>(
    () => ({
      load: loadImages,
      hold() {
        setHeldImages((count) => count + 1);
        return () => setHeldImages((count) => count - 1);
      },
    }),
    [loadImages],
  );
  const allowImages = useCallback(() => {
    webImagesAllowed.add(imagesKey);
    imagesAllowed();
  }, [imagesKey]);
  // A note opens the way the person last left one: to read or to edit
  // (opensEditing.ts). Read once, here; a long note and a read-only one
  // override it below without changing it.
  const [wantEditing, setWantEditing] = useState(readOpensEditing);
  // Only a switch made on this page takes the keyboard into the editor. A note
  // that opens already editing must leave the focus where it is: in the file
  // tree, when the person is moving through it with the arrow keys.
  const [focusEditor, setFocusEditor] = useState(false);
  // A long note opens as its source once, when it first loads; 'Read it' still renders it.
  const [longNote, setLongNote] = useState<number | null>(null);
  const [sized, setSized] = useState(false);
  // Decided while rendering, so the reading view, the slow part, never reaches the page first.
  if (!sized && state.status === 'ready') {
    setSized(true);
    if (state.text.length > longNoteChars && !state.readOnly) {
      setLongNote(new Blob([state.text]).size);
      setWantEditing(true);
    }
  }
  // A note that isn't UTF-8 is only read (its bytes would change on save). Nothing
  // is edited before the text is in, which also keeps the editor's mode (live
  // preview or source) from being decided on an empty note.
  const readOnly = state.readOnly;
  const editing = wantEditing && state.status === 'ready' && !readOnly;
  const pageWidth = useContext(PageWidthContext);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLElement | null>(null);
  const now = useNow(30_000);
  const you = useContext(YouContext);
  const title = titleFromName(entry.name);
  const folder = folderOf(entry.path);
  const apple = useMemo(() => isApplePlatform(), []);
  const shortcut = apple ? '⌘E' : 'Ctrl+E';
  const sourceShortcut = apple ? '⌘⇧E' : 'Ctrl+Shift+E';
  // Live preview or the Markdown source: a per-device choice, while editing.
  const [editMode, setEditMode] = useEditMode();
  // What a screen reader is told when the mode changes under a shortcut (focus stays in the editor).
  const [modeStatus, setModeStatus] = useState('');
  const editRef = useRef<HTMLButtonElement | null>(null);
  const wasEditing = useRef(false);

  const body = useMemo(() => parseFrontmatter(state.text).body, [state.text]);
  const tags = useMemo(() => noteTags(state.text), [state.text]);
  const words = useMemo(() => countWords(state.text), [state.text]);

  // Why an image pasted or dropped wasn't added: the status line says it for a
  // while, in place of the word count, so typing on doesn't wipe it at once.
  const [imageNote, setImageNote] = useState<string | null>(null);
  const imageNoteTimer = useRef<number | undefined>(undefined);
  const reportImage = useCallback((message: string) => {
    window.clearTimeout(imageNoteTimer.current);
    setImageNote(message);
    imageNoteTimer.current = window.setTimeout(() => setImageNote(null), IMAGE_NOTE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(imageNoteTimer.current), []);

  useEffect(() => {
    if (state.status === 'ready') onStatus?.(imageNote ?? formatCount(words, 'word'));
  }, [onStatus, words, state.status, imageNote]);


  useEffect(() => {
    onDirty?.(state.dirty);
  }, [onDirty, state.dirty]);

  const toggleTask = useCallback(
    (offsetInBody: number) => {
      if (!session) return;
      const source = session.getState().text;
      const next = toggleTaskAt(source, parseFrontmatter(source).bodyOffset + offsetInBody);
      if (next === null) return;
      session.edit(next);
      void session.flush();
    },
    [session],
  );
  const noteContext = useMemo(() => ({ toggle: toggleTask }), [toggleTask]);

  const toggleEditing = useCallback(() => {
    if (editing) void session?.flush();
    const next = !editing && !readOnly;
    setWantEditing(next);
    setFocusEditor(next);
    setLongNote(null);
    setModeStatus('');
    // The person's choice, for the notes opened next. A note that can't be edited has none to make.
    if (!readOnly) writeOpensEditing(next);
  }, [editing, session, readOnly]);

  // 'Read it' on a long note's bar: this note is drawn for reading, whatever the
  // person's choice for other notes, which it leaves as it is.
  const readLongNote = useCallback(() => {
    void session?.flush();
    setWantEditing(false);
    setFocusEditor(false);
    setLongNote(null);
    setModeStatus('');
  }, [session]);

  // Leaving the editor removes it, and its focus with it: it goes to the Edit
  // button, where the keyboard was, instead of the top of the page.
  useEffect(() => {
    const was = wasEditing.current;
    wasEditing.current = editing;
    if (was && !editing && (!document.activeElement || document.activeElement === document.body)) editRef.current?.focus();
  }, [editing]);

  // Escape in the editor goes to the toolbar.
  const leaveEditor = useCallback(() => editRef.current?.focus(), []);

  // A note too long for live preview is edited as its source whatever the switch says.
  const plainSource = longNote !== null || state.text.length > longNoteChars;
  // Decided when the editor opens, as NoteEditor decides it: a note that grows
  // past the limit while it's edited keeps live preview, and its switch.
  const [plainAtOpen, setPlainAtOpen] = useState<boolean | null>(null);
  if (editing && plainAtOpen === null) setPlainAtOpen(plainSource);
  if (!editing && plainAtOpen !== null) setPlainAtOpen(null);
  const sourceForced = editing && (plainAtOpen ?? plainSource);
  const toggleSource = useCallback(() => {
    if (sourceForced) return;
    const next = editMode === 'source' ? 'live' : 'source';
    setEditMode(next);
    setModeStatus(next === 'source' ? 'Markdown source' : 'Live preview');
  }, [sourceForced, editMode, setEditMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (readOnly || !isShown(rootRef.current)) return;
      if (isModKey(event, 'e', apple)) {
        event.preventDefault();
        toggleEditing();
      } else if (editing && isModShiftKey(event, 'e', apple)) {
        event.preventDefault();
        toggleSource();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [apple, toggleEditing, toggleSource, editing, readOnly]);

  // Ctrl/⌘-A, with the person's selection in the page, takes the page's text.
  // The browser would take the whole document, chrome included.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const page = pageRef.current;
      if (!page || !isModKey(event, 'a', apple) || !isShown(page)) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (target.isContentEditable || target.closest('input, textarea, select'))) return;
      const selection = window.getSelection();
      if (!selection?.anchorNode || !page.contains(selection.anchorNode)) return;
      event.preventDefault();
      selection.selectAllChildren(page);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [apple]);

  // The page shows the file name as the title; a first '# Title' that only
  // repeats it is left out of the text.
  const rendered = useMemo(() => <NoteMarkdown body={body} title={title} />, [body, title]);
  // Its links and embeds read from this note's folder.
  const env = useMemo<NoteEnv>(() => ({ store, projectId, path: entry.path, depth: 0, chain: [entry.path] }), [store, projectId, entry.path]);

  if (state.status === 'error') return <OtherView {...props} error={state.error} />;
  if (state.status === 'loading' || !session) return <ViewLoading name={title} />;

  // A server that names who wrote the file gives its own time too, so the two agree; the session's
  // clock (its last save or reload on this device) is the time where no one is named.
  const edited =
    entry.modifiedBy && entry.modified !== undefined
      ? formatEdited(entry.modified, now, entry.modifiedBy, you)
      : formatEdited(state.modified ?? entry.modified, now);

  return (
    <div className="ws-note" ref={rootRef} data-editing={editing && !readOnly ? '' : undefined}>
      <SessionBars session={session} state={state} onDownload={() => void downloadEntry(store, entry).catch(() => undefined)} />
      <article className="ws-page" ref={pageRef}>
        {readOnly && !pageWidth ? null : (
          <div className="ws-page-tools" role="group" aria-label="Note tools">
            {pageWidth ? (
              <button
                type="button"
                className="ws-view-icon"
                data-no-arc
                aria-label="Stretch the page"
                aria-pressed={pageWidth.width === 'stretch'}
                title={pageWidth.width === 'stretch' ? 'Give the page its fixed width' : 'Stretch the page to the window'}
                onClick={() => pageWidth.setWidth(pageWidth.width === 'stretch' ? 'fixed' : 'stretch')}
              >
                <Glyph name={pageWidth.width === 'stretch' ? 'narrow' : 'widen'} />
              </button>
            ) : null}
            {editing && !readOnly ? (
              <button
                type="button"
                className="ws-view-icon ws-source-switch"
                data-no-arc
                aria-label="Markdown source"
                aria-pressed={sourceForced || editMode === 'source'}
                aria-disabled={sourceForced || undefined}
                aria-keyshortcuts={apple ? 'Meta+Shift+E' : 'Control+Shift+E'}
                title={
                  sourceForced
                    ? 'This note is long, so it’s edited as its source, which stays quick.'
                    : editMode === 'source'
                      ? `Back to live preview (${sourceShortcut})`
                      : `Show the Markdown source (${sourceShortcut})`
                }
                onClick={toggleSource}
              >
                <Glyph name="source" />
              </button>
            ) : null}
            {readOnly ? null : (
              <button
                type="button"
                className="ws-view-icon"
                data-no-arc
                ref={editRef}
                aria-label="Edit"
                aria-pressed={editing}
                aria-keyshortcuts={apple ? 'Meta+E' : 'Control+E'}
                title={editing ? `Back to reading (${shortcut})` : `Edit the source (${shortcut})`}
                onClick={toggleEditing}
              >
                <Glyph name={editing ? 'read' : 'pencil'} />
              </button>
            )}
          </div>
        )}
        <h1>{title}</h1>
        <div className="ws-meta">
          {folder && (
            <>
              <span>{folder.split('/').join(' / ')}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          {edited && <span>{edited}</span>}
          {/* The header's tags open search, and look as the ones in the text do: links. */}
          {tags.map((tag) => (
            <TagButton key={tag} tag={tag} />
          ))}
        </div>
        {!loadImages && heldImages > 0 && !(editing && !readOnly) ? (
          <div className="ws-remote-bar" role="status">
            <span className="ws-remote-text">
              <Glyph name="image" />
              Web images in this note load only when you ask.
            </span>
            <button type="button" className="ws-view-btn" data-no-arc onClick={allowImages}>
              Load images
            </button>
          </div>
        ) : null}
        {longNote !== null && editing ? (
          <div className="ws-remote-bar ws-long-note" role="status">
            <span className="ws-remote-text">
              <Glyph name="read" />
              This note is long ({formatBytes(longNote)}), so it opens as its source, which stays quick.
            </span>
            <button type="button" className="ws-view-btn" data-no-arc onClick={readLongNote}>
              Read it
            </button>
          </div>
        ) : null}
        {editing && !readOnly ? (
          <span className="ws-visually-hidden" role="status">
            {imageNote ?? modeStatus}
          </span>
        ) : null}
        {editing && !readOnly ? (
          <Suspense fallback={<ViewLoading name="the editor" />}>
            <NoteEditor
              value={state.text}
              revision={state.revision}
              onChange={session.edit}
              fileName={entry.name}
              path={entry.path}
              store={store}
              projectId={projectId}
              label={sourceForced || editMode === 'source' ? `${title}, Markdown source` : `${title}, live preview`}
              onLeave={leaveEditor}
              onStatus={reportImage}
              plainSource={plainSource}
              source={editMode === 'source'}
              autoFocus={focusEditor}
            />
          </Suspense>
        ) : (
          <NoteContext.Provider value={readOnly ? null : noteContext}>
            <WebImagesContext.Provider value={webImages}>
              <NoteEnvContext.Provider value={env}>
                <div className="ws-prose">{rendered}</div>
              </NoteEnvContext.Provider>
            </WebImagesContext.Provider>
          </NoteContext.Provider>
        )}
      </article>
    </div>
  );
}
