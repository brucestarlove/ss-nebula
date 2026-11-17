import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ExcalidrawProps } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import type { FileViewProps } from '../../../files/types';
import { LazyNebulaExcalidrawShell } from '../../../nebula/LazyNebulaExcalidrawShell';
import OtherView from '../other/OtherView';
import { errorMessage } from '../shared/download';
import { unreachableMessage } from '../shared/fileSessions';
import { formatCount, titleFromName } from '../shared/format';
import { ViewLoading } from '../shared/SessionBars';
import { useLeaveFlush } from '../shared/useTextSession';
import { ViewActionsContext } from '../shared/viewActions';
import { useProjectLinks } from '../shared/projectLinks';
import { linkHeading, makesNote, parseWikilink, resolveLink, resolveMarkdownPath } from '../note/links';
import '../views.css';
import './canvas.css';
import { createFileSceneStore, type FileSceneState, type FileSceneStore } from './fileSceneStore';

const IDLE: FileSceneState = { pending: false, elementCount: null, zoom: 1, conflict: false, removed: false, revision: 0 };
const noSubscription = () => () => undefined;

type Phase = { status: 'loading' } | { status: 'ready' } | { status: 'error'; error: unknown };

/**
 * A canvas tab: Nebula's Excalidraw, without its old chrome, in the sketch's
 * framed board, saving to its own file through a FileSceneStore. The library
 * collections belong to the project (its id is the board id).
 *
 * A change made to the file elsewhere reloads the canvas when nothing here is
 * unsaved, and otherwise waits for Reload or Keep mine, as notes do; a file
 * deleted elsewhere says so, and nothing more is written.
 */
export default function CanvasView(props: FileViewProps) {
  const { projectId, store, entry, onStatus, onDirty } = props;
  const actions = useContext(ViewActionsContext);
  const [sceneStore, setSceneStore] = useState<FileSceneStore | null>(null);
  const [phase, setPhase] = useState<Phase>({ status: 'loading' });

  // One scene store per open file; disposing it writes what is pending.
  useEffect(() => {
    const created = createFileSceneStore({ store, path: entry.path, scope: projectId });
    let cancelled = false;
    setSceneStore(created);
    setPhase({ status: 'loading' });
    created.load({ boardId: projectId, canvasId: entry.path }).then(
      () => !cancelled && setPhase({ status: 'ready' }),
      (error: unknown) => !cancelled && setPhase({ status: 'error', error }),
    );
    return () => {
      cancelled = true;
      void created.dispose();
    };
  }, [store, entry.path, projectId]);

  const state = useSyncExternalStore(
    sceneStore?.subscribe ?? noSubscription,
    sceneStore?.getState ?? (() => IDLE),
  );
  useLeaveFlush(sceneStore?.flush);

  useEffect(() => {
    if (phase.status === 'ready' && state.elementCount !== null) {
      onStatus?.(`${formatCount(state.elementCount, 'element')} \u00b7 ${Math.round(state.zoom * 100)}%`);
    }
  }, [onStatus, phase.status, state.elementCount, state.zoom]);

  useEffect(() => {
    onDirty?.(state.pending);
  }, [onDirty, state.pending]);

  const context = useMemo(() => ({ boardId: projectId, canvasId: entry.path }), [projectId, entry.path]);

  // An element's link: `[[Note]]`, as Obsidian Excalidraw
  // writes it on text that holds a link, opens the note in a tab, and a link to
  // a note that isn't there makes it, as in a note. A path in the project
  // opens that file. Anything else that isn't a web address is kept from
  // Excalidraw, which would load it in this tab and leave Nebula.
  // Read when a link is clicked, so the handler (and Excalidraw) stays the
  // same while the project's files change with every save.
  const project = useProjectLinks();
  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  });
  const onLinkOpen = useCallback<NonNullable<ExcalidrawProps['onLinkOpen']>>(
    (element, event) => {
      const project = projectRef.current;
      const link = (element.link ?? '').trim();
      const wiki = /^!?\[\[([^[\]\n]+)\]\]$/.exec(link);
      if (wiki) {
        event.preventDefault();
        const target = parseWikilink(wiki[1]);
        if (!target.target) return;
        const file = resolveLink(target.target, entry.path, project.files);
        if (file) project.open(file.path, linkHeading(target));
        else if (makesNote(target.target)) project.create(target.target, entry.path);
        return;
      }
      if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('//')) return;
      event.preventDefault();
      const file = resolveMarkdownPath(link, entry.path, project.files);
      if (file) project.open(file.path);
    },
    [entry.path],
  );

  if (phase.status === 'error') {
    // A file that isn't a drawing after all can still be read: a note for markdown, text for an .excalidraw file.
    const { openAs } = actions;
    const json = entry.name.toLowerCase().endsWith('.excalidraw');
    const alternative = openAs ? { label: json ? 'Open as text' : 'Open as note', onOpen: () => openAs(json ? 'text' : 'note') } : undefined;
    return <OtherView {...props} error={phase.error} alternative={alternative} />;
  }

  const title = titleFromName(entry.name);
  return (
    <div className="ws-board ws-canvas" data-view-of="canvas" aria-label={`Canvas: ${title}`} role="region">
      {state.moving ? (
        <div className="ws-conflict ws-canvas-bar" role="status">
          <span className="ws-conflict-text">This project is moving to a folder. Your changes are kept here until it’s moved.</span>
        </div>
      ) : state.unreachable ? (
        <div className="ws-conflict ws-canvas-bar" role="status">
          <span className="ws-conflict-text">{unreachableMessage(state.unreachable)}</span>
        </div>
      ) : state.removed ? (
        <div className="ws-conflict ws-canvas-bar" role="status">
          <span className="ws-conflict-text">Deleted elsewhere. Edits here aren&rsquo;t saved.</span>
        </div>
      ) : state.conflict ? (
        <div className="ws-conflict ws-canvas-bar" role="alert">
          <span className="ws-conflict-text">Changed elsewhere:</span>
          <button type="button" className="ws-view-btn" data-no-arc onClick={() => void sceneStore?.reload()}>
            Reload
          </button>
          <button type="button" className="ws-view-btn" data-no-arc onClick={() => void sceneStore?.keepMine()}>
            Keep mine
          </button>
        </div>
      ) : state.error !== undefined ? (
        <div className="ws-conflict ws-canvas-bar" role="alert">
          <span className="ws-conflict-text">Couldn&rsquo;t save. {errorMessage(state.error)}</span>
          <button type="button" className="ws-view-btn" data-no-arc onClick={() => void sceneStore?.flush()}>
            Try again
          </button>
        </div>
      ) : null}
      {phase.status === 'ready' && sceneStore ? (
        <LazyNebulaExcalidrawShell
          // A new revision is the file as changed elsewhere: load it afresh.
          key={state.revision}
          chrome={false}
          context={context}
          store={sceneStore}
          onLinkOpen={onLinkOpen}
          linksFromText
          fallback={<ViewLoading name={entry.name} />}
        />
      ) : (
        <ViewLoading name={entry.name} />
      )}
    </div>
  );
}
