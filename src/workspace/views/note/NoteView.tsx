import { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { FileViewProps } from '../../../files/types';
import OtherView from '../other/OtherView';
import { downloadEntry } from '../shared/download';
import { folderOf, formatBytes, formatCount, formatEdited, titleFromName } from '../shared/format';
import { Glyph } from '../shared/Glyph';
import { isApplePlatform, isModKey, isShown, useNow } from '../shared/hooks';
import { PageWidthContext } from '../shared/pageWidth';
import { SessionBars, ViewLoading } from '../shared/SessionBars';
import { useTextSession } from '../shared/useTextSession';
import { useEditMode } from './editor/editMode';
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
  const [editing, setEditing] = useState(false);
  // A long note opens as its source once, when it first loads; 'Read it' still renders it.
  const [longNote, setLongNote] = useState<number | null>(null);
  const [sized, setSized] = useState(false);
  // Decided while rendering, so the reading view, the slow part, never reaches the page first.
  if (!sized && state.status === 'ready') {
    setSized(true);
    if (state.text.length > longNoteChars && !state.readOnly) {
      setLongNote(new Blob([state.text]).size);
      setEditing(true);
    }
  }
  const pageWidth = useContext(PageWidthContext);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const now = useNow(30_000);
  const title = titleFromName(entry.name);
  const folder = folderOf(entry.path);
  const apple = useMemo(() => isApplePlatform(), []);
  const shortcut = apple ? '⌘E' : 'Ctrl+E';
  const sourceShortcut = apple ? '⌘⇧E' : 'Ctrl+Shift+E';
  // Live preview or the Markdown source: a per-device choice, while editing.
  const [editMode, setEditMode] = useEditMode();

  const body = useMemo(() => parseFrontmatter(state.text).body, [state.text]);
  const tags = useMemo(() => noteTags(state.text), [state.text]);
  const words = useMemo(() => countWords(state.text), [state.text]);

  useEffect(() => {
    if (state.status === 'ready') onStatus?.(formatCount(words, 'word'));
  }, [onStatus, words, state.status]);


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

  // A note that isn't UTF-8 is only read (its bytes would change on save).
  const readOnly = state.readOnly;
  const toggleEditing = useCallback(() => {
    if (editing) void session?.flush();
    setEditing(!editing && !readOnly);
    setLongNote(null);
  }, [editing, session, readOnly]);

  // A note too long for live preview is edited as its source whatever the switch says.
  const plainSource = longNote !== null || state.text.length > longNoteChars;
  // Decided when the editor opens, as NoteEditor decides it: a note that grows
  // past the limit while it's edited keeps live preview, and its switch.
  const [plainAtOpen, setPlainAtOpen] = useState<boolean | null>(null);
  if (editing && plainAtOpen === null) setPlainAtOpen(plainSource);
  if (!editing && plainAtOpen !== null) setPlainAtOpen(null);
  const sourceForced = editing && (plainAtOpen ?? plainSource);
  const toggleSource = useCallback(() => {
    if (!sourceForced) setEditMode(editMode === 'source' ? 'live' : 'source');
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

  // The page shows the file name as the title; a first '# Title' that only
  // repeats it is left out of the text.
  const rendered = useMemo(() => <NoteMarkdown body={body} title={title} />, [body, title]);
  // Its links and embeds read from this note's folder.
  const env = useMemo<NoteEnv>(() => ({ store, projectId, path: entry.path, depth: 0, chain: [entry.path] }), [store, projectId, entry.path]);

  if (state.status === 'error') return <OtherView {...props} error={state.error} />;
  if (state.status === 'loading' || !session) return <ViewLoading name={title} />;

  const edited = formatEdited(state.modified ?? entry.modified, now);

  return (
    <div className="ws-note" ref={rootRef} data-editing={editing && !readOnly ? '' : undefined}>
      <SessionBars session={session} state={state} onDownload={() => void downloadEntry(store, entry).catch(() => undefined)} />
      <article className="ws-page">
        {readOnly && !pageWidth ? null : (
          <div className="ws-page-tools">
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
                aria-label="Edit"
                aria-pressed={editing}
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
          {tags.map((tag) => (
            <span key={tag} className="ws-tag">
              #{tag}
            </span>
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
            <button type="button" className="ws-view-btn" data-no-arc onClick={toggleEditing}>
              Read it
            </button>
          </div>
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
              label={`${title}, markdown source`}
              plainSource={plainSource}
              source={editMode === 'source'}
              autoFocus
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
