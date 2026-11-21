import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { blobToText } from '../../files/bytes';
import type { HistoryStore } from '../../files/history';
import type { VersionInfo } from '../../files/serverContract';
import type { FileKind, FileStore } from '../../files/types';
import { errorMessage } from '../views/shared/download';
import { titleFromName } from '../views/shared/format';
import { typedBlob } from '../views/shared/mime';
import { NoteEnvContext, type NoteEnv } from '../views/note/embeds/NoteEnv';
import { useDocumentTheme } from '../views/note/embeds/useDocumentTheme';
import { parseFrontmatter } from '../views/note/markdown';
import { NoteContext } from '../views/note/noteContexts';
import { NoteMarkdown } from '../views/note/prose';
import { Button } from './Button';
import { WsDialog } from './Dialogs';

/** How much of a version is drawn: a longer text is cut, and the rest is there once it's restored. */
const PREVIEW_CHARS = 100_000;

type Shown =
  | { status: 'loading' }
  | { status: 'note'; body: string; cut: boolean }
  | { status: 'text'; text: string; cut: boolean }
  | { status: 'picture'; url: string }
  /** Nothing to draw here: restoring is how to see it. */
  | { status: 'none' }
  | { status: 'error'; message: string };

/** One version's bytes, read from the server and drawn by the file's kind, as read-only as can be: a note as notes are rendered, text and code as text, an image as an image, a canvas as the picture notes show of one. */
function useVersionShown(store: FileStore & HistoryStore, path: string, kind: FileKind | null, version: string, name: string): Shown {
  const theme = useDocumentTheme();
  const [shown, setShown] = useState<Shown>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    const done = (next: Shown) => {
      if (!cancelled) setShown(next);
    };
    (async () => {
      const blob = await store.readVersion(path, version);
      if (kind === 'note' || kind === 'text' || kind === 'canvas') {
        const text = await blobToText(blob);
        if (kind === 'canvas') {
          const { renderCanvasSvg } = await import('../views/note/embeds/canvasSvg');
          const svg = await renderCanvasSvg(store, path, theme, text);
          if (!svg || cancelled) return done({ status: 'none' });
          url = URL.createObjectURL(svg);
          return done({ status: 'picture', url });
        }
        const cut = text.length > PREVIEW_CHARS;
        const clipped = cut ? text.slice(0, PREVIEW_CHARS) : text;
        return done(kind === 'note' ? { status: 'note', body: parseFrontmatter(clipped).body, cut } : { status: 'text', text: clipped, cut });
      }
      if (kind === 'image') {
        url = URL.createObjectURL(typedBlob(blob, name));
        return done({ status: 'picture', url });
      }
      return done({ status: 'none' });
    })().catch((error: unknown) => {
      // A drawing that won't draw is no reason for a failure: the version is still there to restore.
      if (kind === 'canvas') done({ status: 'none' });
      else done({ status: 'error', message: errorMessage(error) });
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [store, path, kind, version, name, theme]);
  return shown;
}

type PreviewProps = {
  store: FileStore & HistoryStore;
  projectId: string;
  path: string;
  name: string;
  kind: FileKind | null;
  version: VersionInfo;
  who: string;
  when: string;
  onClose: () => void;
  onRestore: () => void;
};

/** A dialog showing one earlier version of the file, to look at before restoring it. Nothing in it
 * is editable, and a link in a note does nothing here. */
export default function HistoryPreview({ store, projectId, path, name, kind, version, who, when, onClose, onRestore }: PreviewProps) {
  const id = useId();
  const close = useRef<HTMLButtonElement>(null);
  const shown = useVersionShown(store, path, kind, version.version, name);
  const title = titleFromName(name);
  const env = useMemo<NoteEnv>(() => ({ store, projectId, path, depth: 0, chain: [path] }), [store, projectId, path]);
  return (
    <WsDialog open onClose={onClose} className="ws-hist-preview" labelledBy={id} initialFocus={close}>
      <div className="ws-hist-preview-inner">
        <header>
          <h2 id={id}>{title}</h2>
          <p>
            {who}, {when}
          </p>
        </header>
        <div
          className="ws-hist-preview-body"
          // Looked at, not used: a link or a button inside the version does nothing.
          onClickCapture={(event) => {
            if ((event.target as HTMLElement).closest('a, button, [role="button"]')) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          {shown.status === 'loading' ? <p className="ws-hist-preview-quiet">Opening this version…</p> : null}
          {shown.status === 'error' ? (
            <p className="ws-hist-preview-quiet" role="alert">
              Couldn’t read this version. {shown.message}
            </p>
          ) : null}
          {shown.status === 'none' ? <p className="ws-hist-preview-quiet">Restore it to see it.</p> : null}
          {shown.status === 'picture' ? <img className="ws-hist-preview-picture" src={shown.url} alt={`${title}, the version from ${when}`} /> : null}
          {shown.status === 'note' ? (
            <NoteEnvContext.Provider value={env}>
              <NoteContext.Provider value={null}>
                <div className="ws-prose">
                  <NoteMarkdown body={shown.body} title={title} />
                </div>
              </NoteContext.Provider>
            </NoteEnvContext.Provider>
          ) : null}
          {shown.status === 'text' ? <pre className="ws-hist-preview-text">{shown.text}</pre> : null}
          {(shown.status === 'note' || shown.status === 'text') && shown.cut ? <p className="ws-hist-preview-quiet">The rest of this version is there once it’s restored.</p> : null}
        </div>
        <footer className="ws-dialog-foot">
          <Button ref={close} className="ws-btn-quiet" onClick={onClose}>
            Close
          </Button>
          {version.current ? null : (
            <Button className="welcome-dialog-cta" onClick={onRestore}>
              Restore this version
            </Button>
          )}
        </footer>
      </div>
    </WsDialog>
  );
}
