import { Component, Suspense, useEffect, useMemo, useRef, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import type { Actor, FileEntry, FileKind, FileStore, FileViewProps } from '../../files/types';
import { occurrences, type Heading } from '../outline';
import { BacklinksPanel } from './BacklinksPanel';
import { TagsPanel } from './TagsPanel';
import { HistoryPanel, type HistoryProps } from './HistoryPanel';
import { formatEdited } from '../views/shared/format';
import { useNow } from '../views/shared/hooks';
import { ViewActionsContext, type ViewActions } from '../views/shared/viewActions';
import { Button } from './Button';
import { findHeading, findJump, HEADING_JUMP_MS, type HeadingJump } from './headings';
import { hasEditor, jumpInEditor, useReadingHeading } from './outlineFollow';
import { prefersReducedMotion } from './ui';

class ViewBoundary extends Component<{ children: ReactNode; name: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('A Nebula file view failed', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="ws-empty" role="alert">
        <h2>This file didn’t open</h2>
        <p>
          Nebula couldn’t show {this.props.name}: {this.state.error.message}
        </p>
      </div>
    );
  }
}

type StageProps = {
  /** The view for a kind (src/workspace/views' viewFor, unless a test swaps it). */
  viewFor: (kind: FileKind) => ComponentType<FileViewProps>;
  projectId: string;
  store: FileStore | null;
  entry: FileEntry | null;
  kind: FileKind | null;
  labelledBy?: string;
  empty: ReactNode;
  onStatus: (path: string, text: string) => void;
  onDirty: (path: string, dirty: boolean) => void;
  /** Shows the open file in another kind's view. */
  onOpenAs?: (path: string, kind: FileKind) => void;
  /** Scrolls the open file to a heading once its view has drawn it. */
  jump?: HeadingJump | null;
};

function scrollToHeading(target: HTMLElement) {
  target.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

/** The open file, in the view for its kind (src/workspace/views, loaded on
 * demand), or what to do next when nothing is open. */
export function Stage({ viewFor, projectId, store, entry, kind, labelledBy, empty, onStatus, onDirty, onOpenAs, jump }: StageProps) {
  const View = useMemo(() => (kind ? viewFor(kind) : null), [viewFor, kind]);
  const path = entry?.path ?? null;
  const handlers = useMemo(
    () =>
      path
        ? { onStatus: (text: string) => onStatus(path, text), onDirty: (dirty: boolean) => onDirty(path, dirty) }
        : null,
    [path, onStatus, onDirty],
  );
  const actions = useMemo<ViewActions>(() => (path && onOpenAs ? { openAs: (next: FileKind) => onOpenAs(path, next) } : {}), [path, onOpenAs]);

  // A view that goes reports nothing more: its tab's unsaved mark goes with
  // it. Its session's last save is tracked until it lands (fileSessions.ts).
  useEffect(() => {
    if (!path) return undefined;
    return () => onDirty(path, false);
  }, [path, onDirty]);

  // A link to a heading: scroll to it now if the view has drawn it, else as
  // soon as it does (the note may still be loading, or only just opened). A
  // heading that never comes leaves the file open at its top.
  const jumped = useRef(0);
  useEffect(() => {
    if (!jump || !path || jump.path !== path || jumped.current === jump.n) return undefined;
    jumped.current = jump.n;
    const stage = document.getElementById('ws-stage');
    if (!stage) return undefined;
    const attempt = () => {
      const target = findJump(stage, jump);
      if (target) scrollToHeading(target);
      return target !== null;
    };
    if (attempt()) return undefined;
    const observer = new MutationObserver(() => {
      if (attempt()) observer.disconnect();
    });
    observer.observe(stage, { childList: true, subtree: true, characterData: true });
    const giveUp = window.setTimeout(() => observer.disconnect(), HEADING_JUMP_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(giveUp);
    };
  }, [jump, path]);

  if (!entry || !store) {
    return <section className="ws-stage" aria-label="No file open">{empty}</section>;
  }

  return (
    <section id="ws-stage" className="ws-stage" role="tabpanel" aria-labelledby={labelledBy} data-kind={kind ?? undefined}>
      {View && kind && handlers ? (
        <ViewBoundary key={`${projectId}:${entry.path}`} name={entry.name}>
          <Suspense fallback={<div className="ws-view-loading">Opening {entry.name}…</div>}>
            <ViewActionsContext.Provider value={actions}>
              <View projectId={projectId} store={store} entry={entry} kind={kind} onStatus={handlers.onStatus} onDirty={handlers.onDirty} />
            </ViewActionsContext.Provider>
          </Suspense>
        </ViewBoundary>
      ) : (
        <div className="ws-view-loading">Opening {entry.name}…</div>
      )}
    </section>
  );
}

/** Scrolls the stage to the nth heading with this text, if the view drew one; in the editor, puts the cursor on its line. */
function jumpTo(heading: Heading, nth: number) {
  const stage = document.getElementById('ws-stage');
  if (!stage) return;
  // An editor draws no <h2>s: its headings are lines of its text.
  if (hasEditor(stage)) {
    void jumpInEditor(stage, heading, nth);
    return;
  }
  const target = findHeading(stage, heading.text, nth, true);
  if (target) scrollToHeading(target);
}

type OutlineProps = {
  headings: Heading[] | null;
  isNote: boolean;
  /** The active tab's file. */
  path?: string | null;
  /** What History needs to know of the project and the file; without it there's no History section. */
  history?: HistoryProps;
};

/** The right panel: the active note's outline, what links to it, its tags, and the file's history. */
export function OutlinePanel({ headings, isNote, path = null, history }: OutlineProps) {
  const nths = headings ? occurrences(headings) : [];
  const current = useReadingHeading(isNote ? path : null, isNote ? headings : null);
  const list = useRef<HTMLUListElement>(null);

  // A long outline scrolls inside the panel, and the heading being read stays in it.
  // Not while focus is in the outline: someone moving through it with the keys isn't moved from under them.
  useEffect(() => {
    const container = list.current;
    const marked = container?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!container || !marked || container.contains(document.activeElement)) return;
    const top = marked.offsetTop;
    if (top < container.scrollTop || top + marked.offsetHeight > container.scrollTop + container.clientHeight) {
      container.scrollTo({ top: top - container.clientHeight / 3, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }, [current]);

  return (
    <aside id="ws-panel" className="ws-panel" aria-label="Outline">
      <section>
        <h3>Outline</h3>
        {!isNote ? (
          <p className="ws-panel-empty">Open a note to see its headings here.</p>
        ) : headings === null ? null : headings.length === 0 ? (
          <p className="ws-panel-empty">This note has no headings yet.</p>
        ) : (
          <ul className="ws-outline" ref={list}>
            {headings.map((heading, index) => (
              <li key={`${index}:${heading.text}`} data-depth={heading.depth > 1 ? Math.min(heading.depth, 6) : undefined}>
                <Button aria-current={current === index ? 'location' : undefined} onClick={() => jumpTo(heading, nths[index])}>
                  {heading.text}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <BacklinksPanel path={path} />
      <TagsPanel path={path} />
      {history ? <HistoryPanel {...history} /> : null}
    </aside>
  );
}

type StatusLineProps = {
  ephemeral: boolean;
  /** The open project lives in a folder on this computer. */
  inFolder?: boolean;
  /** A server project's server ('vps-starscape'): saved there. */
  place?: string | null;
  /** Its folder can't be opened now: nothing is being saved. */
  folderClosed?: boolean;
  saving: boolean;
  status: string | null;
  message: string | null;
  /** The open file's entry: when it was edited, and by whom where the server says. */
  edited?: Pick<FileEntry, 'modified' | 'modifiedBy'> | null;
  /** Who is using the app, so "Edited by you" says it. */
  you?: Actor;
};

/** Where the files are kept, whether they're saved, when the open file was last edited and by whom,
 * the view's own status ('76 words'), and the signature. */
export function StatusLine({ ephemeral, inFolder = false, place = null, folderClosed = false, saving, status, message, edited = null, you }: StatusLineProps) {
  // The same clock the note's own line uses, so the two never disagree.
  const now = useNow(30_000);
  const editedText = edited ? formatEdited(edited.modified, now, edited.modifiedBy, you) : '';
  const kept = folderClosed ? 'The folder isn’t open' : place ? `Saved on ${place}` : inFolder ? 'Saved on this computer' : ephemeral ? 'Kept in this tab only' : 'Saved in this browser';
  return (
    <footer className="ws-status">
      <span className="ws-store-dot" data-ephemeral={ephemeral ? '' : undefined} data-attention={folderClosed ? '' : undefined} aria-hidden="true" />
      <span>{saving ? 'Saving…' : kept}</span>
      {editedText ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="ws-status-edited">{editedText}</span>
        </>
      ) : null}
      {message ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="ws-status-text">{message}</span>
        </>
      ) : status ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="ws-status-text">{status}</span>
        </>
      ) : null}
      <span className="ws-sign">
        <b>Nebula</b>
        <em>a Starscape app</em>
      </span>
    </footer>
  );
}
