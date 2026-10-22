import { useEffect, useState } from 'react';
import type { FileStore } from '../../../files/types';
import { typedBlob } from './mime';

export type FileBlobState =
  | { status: 'loading' }
  | { status: 'ready'; url: string; blob: Blob }
  | { status: 'error'; error: unknown };

/**
 * The file's bytes as an object URL, typed by its name (never by the store),
 * re-read when the file is written elsewhere, and revoked when the view lets
 * go of it.
 */
export function useFileBlob(store: FileStore, path: string, name: string): FileBlobState {
  const [state, setState] = useState<FileBlobState>({ status: 'loading' });
  const [version, setVersion] = useState(0);

  useEffect(
    () =>
      store.watch((change) => {
        if (change.type === 'write' && change.path === path) setVersion((value) => value + 1);
      }),
    [store, path],
  );

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    store.readBlob(path).then(
      (raw) => {
        if (cancelled) return;
        const blob = typedBlob(raw, name);
        url = URL.createObjectURL(blob);
        setState({ status: 'ready', url, blob });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', error });
      },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [store, path, name, version]);

  return state;
}
