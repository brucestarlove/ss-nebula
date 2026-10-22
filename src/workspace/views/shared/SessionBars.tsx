import type { TextSession, TextSessionState } from './textSession';
import { errorMessage } from './download';

/** The small bars above an editable file: changed elsewhere, a failed save,
 * a file deleted elsewhere, a file that can only be read. */
export function SessionBars({ session, state, onDownload }: { session: TextSession | null; state: TextSessionState; onDownload?: () => void }) {
  if (!session) return null;
  if (state.removed) {
    return (
      <div className="ws-conflict" role="status">
        <span className="ws-conflict-text">Deleted elsewhere. Edits here aren&rsquo;t saved.</span>
      </div>
    );
  }
  if (state.conflict) {
    return (
      <div className="ws-conflict" role="alert">
        <span className="ws-conflict-text">Changed elsewhere:</span>
        <button type="button" className="ws-view-btn" data-no-arc onClick={() => void session.reload()}>
          Reload
        </button>
        <button type="button" className="ws-view-btn" data-no-arc onClick={() => void session.keepMine()}>
          Keep mine
        </button>
      </div>
    );
  }
  if (state.saveError !== undefined) {
    return (
      <div className="ws-conflict" role="alert">
        <span className="ws-conflict-text">Couldn&rsquo;t save. {errorMessage(state.saveError)}</span>
        <button type="button" className="ws-view-btn" data-no-arc onClick={() => void session.flush()}>
          Try again
        </button>
      </div>
    );
  }
  if (state.readOnly) {
    return (
      <div className="ws-conflict" role="status">
        <span className="ws-conflict-text">Read-only: this file isn&rsquo;t UTF-8 text, so saving it here would change its bytes.</span>
        {onDownload ? (
          <button type="button" className="ws-view-btn" data-no-arc onClick={onDownload}>
            Download
          </button>
        ) : null}
      </div>
    );
  }
  return null;
}

/** "Opening …", shown only if opening takes a moment (views.css delays it). */
export function ViewLoading({ name }: { name: string }) {
  return (
    <div className="ws-view-state" role="status">
      Opening {name}…
    </div>
  );
}
