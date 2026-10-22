import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ComponentProps } from 'react';
import Markdown, { type Components, type ExtraProps, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FileViewProps } from '../../../files/types';
import OtherView from '../other/OtherView';
import { downloadEntry } from '../shared/download';
import { folderOf, formatCount, formatEdited, titleFromName } from '../shared/format';
import { Glyph } from '../shared/Glyph';
import { isApplePlatform, isModKey, isShown, useNow } from '../shared/hooks';
import { SessionBars, ViewLoading } from '../shared/SessionBars';
import { useTextSession } from '../shared/useTextSession';
import { countWords, noteTags, parseFrontmatter, toggleTaskAt } from './markdown';
import { remarkHideTitle, remarkNebula } from './remarkNebula';
import '../views.css';
import './note.css';

// CodeMirror loads only when a note is edited (PLAN §10's load budget).
const CodeEditor = lazy(() => import('../code/CodeEditor'));

type HastElement = NonNullable<ExtraProps['node']>;
type HastNode = HastElement | HastElement['children'][number];

const NoteContext = createContext<{ toggle(offsetInBody: number): void } | null>(null);

/** Whether this note's web images may load, and a way for a held-back one
 * to say it's there (it returns its goodbye). */
type WebImages = { load: boolean; hold(): () => void };
const WebImagesContext = createContext<WebImages>({ load: false, hold: () => () => undefined });

/** Notes whose web images were asked for, while this page is open. */
const webImagesAllowed = new Set<string>();

function isElement(node: HastNode): node is HastElement {
  return node.type === 'element';
}

/** The state of the checkbox remark-gfm put at the start of a task item. */
function taskChecked(item: HastElement): boolean {
  for (const child of item.children) {
    if (!isElement(child)) continue;
    if (child.tagName === 'input') return Boolean(child.properties?.checked);
    if (child.tagName === 'p') {
      const input = child.children.find((grandchild) => isElement(grandchild) && grandchild.tagName === 'input');
      if (input && isElement(input)) return Boolean(input.properties?.checked);
    }
  }
  return false;
}

/** A task's own words (not its subtasks'), for the checkbox's name. */
function ownText(node: HastNode): string {
  if (node.type === 'text') return node.value;
  if (!isElement(node) || node.tagName === 'ul' || node.tagName === 'ol') return '';
  return node.children.map(ownText).join('');
}

function hasClass(className: unknown, name: string): boolean {
  return typeof className === 'string' && className.split(/\s+/).includes(name);
}

function withTaskClass(className: string | undefined): string | undefined {
  return hasClass(className, 'contains-task-list') ? `${className} ws-tasks` : className;
}

function ProseList(props: ComponentProps<'ul'> & ExtraProps) {
  const { node, className, ...rest } = props;
  void node;
  return <ul className={withTaskClass(className)} {...rest} />;
}

function ProseOrderedList(props: ComponentProps<'ol'> & ExtraProps) {
  const { node, className, ...rest } = props;
  void node;
  return <ol className={withTaskClass(className)} {...rest} />;
}

/** A list item; a task item gets a real checkbox that writes back to the
 * exact source line, found from the item's markdown position. */
function ProseItem(props: ComponentProps<'li'> & ExtraProps) {
  const { node, className, children, ...rest } = props;
  const note = useContext(NoteContext);
  if (!node || !hasClass(className, 'task-list-item')) {
    return (
      <li className={className} {...rest}>
        {children}
      </li>
    );
  }
  const checked = taskChecked(node);
  const offset = node.position?.start.offset;
  const label = ownText(node).trim() || 'Task';
  return (
    <li className={`${className} ws-task`} data-done={checked ? '' : undefined} {...rest}>
      <input
        type="checkbox"
        className="ws-check"
        checked={checked}
        aria-label={label}
        disabled={offset === undefined || !note}
        onChange={() => {
          if (offset !== undefined) note?.toggle(offset);
        }}
      />
      <div className="ws-task-body">{children}</div>
    </li>
  );
}

const EXTERNAL_LINK = /^(?:https?:|mailto:|tel:)/i;

/** Web links open in a new tab; links inside the project wait for slice 5. */
function ProseLink(props: ComponentProps<'a'> & ExtraProps) {
  const { node, href, children, className, ...rest } = props;
  void node;
  void className;
  if (href && EXTERNAL_LINK.test(href)) {
    return (
      <a {...rest} className="ws-link" href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <span className="ws-link-local" title={href || undefined}>
      {children}
    </span>
  );
}

function hostOf(src: string): string {
  try {
    return new URL(src).host;
  } catch {
    return src;
  }
}

/** A web image held back until it's asked for: its words and where it's from. */
function HeldImage({ src, alt }: { src: string; alt: string }) {
  const images = useContext(WebImagesContext);
  useEffect(() => images.hold(), [images]);
  return (
    <span className="ws-remote-image" title={src}>
      <Glyph name="image" />
      {alt || 'Image'}
      <span className="ws-remote-host"> · {hostOf(src)}</span>
    </span>
  );
}

/** Web images load only once asked for, per note (review finding 20), so a
 * note can't tell anyone it was opened; images inside the project wait for
 * embeds (slice 5). */
function ProseImage(props: ComponentProps<'img'> & ExtraProps) {
  const { node, src, alt, title } = props;
  void node;
  const images = useContext(WebImagesContext);
  if (typeof src === 'string' && /^https?:/i.test(src)) {
    if (!images.load) return <HeldImage src={src} alt={alt ?? ''} />;
    return <img src={src} alt={alt ?? ''} title={title} loading="lazy" referrerPolicy="no-referrer" />;
  }
  return (
    <span className="ws-embed-pending" title={typeof src === 'string' ? src : undefined}>
      {alt || (typeof src === 'string' ? src : '')}
    </span>
  );
}

// Raw HTML never renders (no rehype-raw): react-markdown shows it as text.
// The only inputs left are remark-gfm's task boxes, which ProseItem draws.
const COMPONENTS: Components = {
  ul: ProseList,
  ol: ProseOrderedList,
  li: ProseItem,
  input: () => null,
  a: ProseLink,
  img: ProseImage,
};

type RemarkPlugins = NonNullable<Options['remarkPlugins']>;

/** A note: rendered markdown on a page, with a source editor (⌘E / Ctrl+E). */
export default function NoteView(props: FileViewProps) {
  const { projectId, store, entry, onStatus, onDirty } = props;
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const now = useNow(30_000);
  const title = titleFromName(entry.name);
  const folder = folderOf(entry.path);
  const apple = useMemo(() => isApplePlatform(), []);
  const shortcut = apple ? '⌘E' : 'Ctrl+E';

  const body = useMemo(() => parseFrontmatter(state.text).body, [state.text]);
  // The page shows the file name as the title; a first '# Title' that only
  // repeats it is left out of the text below.
  const remarkPlugins = useMemo<RemarkPlugins>(() => [remarkGfm, [remarkHideTitle, title], remarkNebula], [title]);
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
  }, [editing, session, readOnly]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (readOnly || !isModKey(event, 'e', apple) || !isShown(rootRef.current)) return;
      event.preventDefault();
      toggleEditing();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [apple, toggleEditing, readOnly]);

  const rendered = useMemo(
    () => (
      <Markdown remarkPlugins={remarkPlugins} components={COMPONENTS}>
        {body}
      </Markdown>
    ),
    [body, remarkPlugins],
  );

  if (state.status === 'error') return <OtherView {...props} error={state.error} />;
  if (state.status === 'loading' || !session) return <ViewLoading name={title} />;

  const edited = formatEdited(state.modified ?? entry.modified, now);

  return (
    <div className="ws-note" ref={rootRef} data-editing={editing && !readOnly ? '' : undefined}>
      <SessionBars session={session} state={state} onDownload={() => void downloadEntry(store, entry).catch(() => undefined)} />
      <article className="ws-page">
        {readOnly ? null : (
          <div className="ws-page-tools">
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
        {editing && !readOnly ? (
          <Suspense fallback={<ViewLoading name="the editor" />}>
            <CodeEditor
              value={state.text}
              revision={state.revision}
              onChange={session.edit}
              fileName={entry.name}
              variant="note"
              label={`${title}, markdown source`}
              autoFocus
            />
          </Suspense>
        ) : (
          <NoteContext.Provider value={readOnly ? null : noteContext}>
            <WebImagesContext.Provider value={webImages}>
              <div className="ws-prose">{rendered}</div>
            </WebImagesContext.Provider>
          </NoteContext.Provider>
        )}
      </article>
    </div>
  );
}
