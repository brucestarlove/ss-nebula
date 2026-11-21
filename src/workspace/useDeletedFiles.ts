import { useCallback, useEffect, useState } from 'react';
import { FileChangedError } from '../files/errors';
import { hasDeletedFiles, type DeletedFile } from '../files/history';
import type { FileStore } from '../files/types';
import { errorMessage } from './views/shared/download';

export type DeletedFilesState = {
  /** The open project's deleted files, newest first; null until the server has answered. */
  files: DeletedFile[] | null;
  /** The server held back older ones past what it lists. */
  more: boolean;
  /** Why the list couldn't be read, or a restore couldn't be made, in words. */
  error: string | null;
  /** The path being restored now. */
  busy: string | null;
  /** Paths whose restore met a file already there: they stay listed, and are not tried again. */
  taken: ReadonlySet<string>;
  restore: (file: DeletedFile) => void;
  /** Asks the server again. */
  reload: () => void;
};

/** A server's refusal (`ServerError`) says its status; asked by shape, so the workspace doesn't
 * load the server tier's code (src/files/serverStore.ts) to read it. */
const isNotSupported = (reason: unknown): boolean => typeof reason === 'object' && reason !== null && (reason as { status?: unknown }).status === 405;

/**
 * "Recently deleted" for files: the files deleted from the open server project, where the server
 * keeps them (`store.deletedFiles`), asked while `wanted` (Settings is open on the Project tab) and
 * nothing of them kept on this device. Undefined where there is no such list: a folder, the
 * browser, or a server that answers 405. A restore never writes over a file: it asks for a path
 * that is empty (`ifAbsent`), and a path taken meanwhile is marked, not overwritten. `restored`
 * runs once a file is back.
 */
export function useDeletedFiles(store: FileStore | null, wanted: boolean, restored: (file: DeletedFile) => void): DeletedFilesState | undefined {
  const source = hasDeletedFiles(store) ? store : null;
  const [files, setFiles] = useState<DeletedFile[] | null>(null);
  const [more, setMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  // A restore's own, kept across the list's re-reading that follows it.
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [taken, setTaken] = useState<ReadonlySet<string>>(new Set());
  const [unsupported, setUnsupported] = useState<FileStore | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!source || !wanted) return undefined;
    let cancelled = false;
    source.deletedFiles().then(
      (page) => {
        if (cancelled) return;
        setFiles(page.files);
        setMore(page.more);
        setTaken(new Set());
        setListError(null);
      },
      (reason: unknown) => {
        if (cancelled) return;
        if (isNotSupported(reason)) setUnsupported(source);
        else setListError(errorMessage(reason));
      },
    );
    return () => {
      cancelled = true;
      // Closed, or another project: the next reading shows nothing stale meanwhile.
      setFiles(null);
      setMore(false);
    };
  }, [source, wanted, nonce]);

  const reload = useCallback(() => setNonce((count) => count + 1), []);
  const restore = useCallback(
    (file: DeletedFile) => {
      if (!source) return;
      setBusy(file.path);
      setRestoreError(null);
      void (async () => {
        try {
          await source.restore(file.path, file.version, { ifAbsent: true });
          restored(file);
          reload();
        } catch (reason) {
          if (reason instanceof FileChangedError) setTaken((now) => new Set(now).add(file.path));
          else {
            setRestoreError(`Couldn’t restore ${file.path}. ${errorMessage(reason)}`);
            reload();
          }
        } finally {
          setBusy(null);
        }
      })();
    },
    [source, restored, reload],
  );

  if (!source || unsupported === source) return undefined;
  return { files, more, error: restoreError ?? listError, busy, taken, restore, reload };
}
