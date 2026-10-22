import { Component, Suspense, useEffect, useMemo, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import type { FileEntry, FileKind, FileStore, FileViewProps } from '../../files/types';
import type { Heading } from '../outline';
import { ViewActionsContext, type ViewActions } from '../views/shared/viewActions';
import { Button } from './Button';
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
};

/** The open file, in the view for its kind (src/workspace/views, loaded on
 * demand), or what to do next when nothing is open. */
export function Stage({ viewFor, projectId, store, entry, kind, labelledBy, empty, onStatus, onDirty, onOpenAs }: StageProps) {
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

/** Scrolls the stage to the nth heading with this text, if the view drew one. */
function jumpTo(heading: Heading, nth: number) {
  const stage = document.getElementById('ws-stage');
  if (!stage) return;
  const matches = [...stage.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].filter(
    (element) => element.textContent?.trim() === heading.text,
  );
  const target = matches[nth] ?? matches[0];
  if (!target) return;
  target.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

type OutlineProps = { headings: Heading[] | null; isNote: boolean };

/** The right panel: the active note's outline. Backlinks arrive with search
 * (docs/slice-3.md, decision 7). */
export function OutlinePanel({ headings, isNote }: OutlineProps) {
  const seen = new Map<string, number>();
  return (
    <aside id="ws-panel" className="ws-panel" aria-label="Outline">
      <section>
        <h3>Outline</h3>
        {!isNote ? (
          <p className="ws-panel-empty">Open a note to see its headings here.</p>
        ) : headings === null ? null : headings.length === 0 ? (
          <p className="ws-panel-empty">This note has no headings yet.</p>
        ) : (
          <ul className="ws-outline">
            {headings.map((heading, index) => {
              const nth = seen.get(heading.text) ?? 0;
              seen.set(heading.text, nth + 1);
              return (
                <li key={`${index}:${heading.text}`} data-depth={heading.depth > 1 ? Math.min(heading.depth, 6) : undefined}>
                  <Button onClick={() => jumpTo(heading, nth)}>{heading.text}</Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </aside>
  );
}

type StatusLineProps = { ephemeral: boolean; saving: boolean; status: string | null; message: string | null };

/** Where the files are kept, whether they're saved, the view's own status
 * ('76 words'), and the signature. */
export function StatusLine({ ephemeral, saving, status, message }: StatusLineProps) {
  const kept = ephemeral ? 'Kept in this tab only' : 'Saved in this browser';
  return (
    <footer className="ws-status">
      <span className="ws-store-dot" data-ephemeral={ephemeral ? '' : undefined} aria-hidden="true" />
      <span>{saving ? 'Saving…' : kept}</span>
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
