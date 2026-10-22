import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import '@excalidraw/excalidraw/index.css';
import type { FileViewProps } from '../../../files/types';
import { LazyNebulaExcalidrawShell } from '../../../nebula/LazyNebulaExcalidrawShell';
import OtherView from '../other/OtherView';
import { errorMessage } from '../shared/download';
import { formatCount, titleFromName } from '../shared/format';
import { ViewLoading } from '../shared/SessionBars';
import { useLeaveFlush } from '../shared/useTextSession';
import { ViewActionsContext } from '../shared/viewActions';
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

  if (phase.status === 'error') {
    // A file that isn't a drawing after all can still be read (review
    // finding 8): a note for markdown, text for an .excalidraw file.
    const { openAs } = actions;
    const json = entry.name.toLowerCase().endsWith('.excalidraw');
    const alternative = openAs ? { label: json ? 'Open as text' : 'Open as note', onOpen: () => openAs(json ? 'text' : 'note') } : undefined;
    return <OtherView {...props} error={phase.error} alternative={alternative} />;
  }

  const title = titleFromName(entry.name);
  return (
    <div className="ws-board ws-canvas" data-view-of="canvas" aria-label={`Canvas: ${title}`} role="region">
      {state.removed ? (
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
          fallback={<ViewLoading name={entry.name} />}
        />
      ) : (
        <ViewLoading name={entry.name} />
      )}
    </div>
  );
}
