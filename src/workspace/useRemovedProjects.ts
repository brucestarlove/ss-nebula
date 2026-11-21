import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemovedProjects } from '../files/places';
import type { RemovedProject } from '../files/serverContract';
import type { Actor } from '../files/types';
import type { DeletedFilesState } from './useDeletedFiles';
import { errorMessage } from './views/shared/download';

/** How long the server keeps a deleted project before it goes for good (contract §2's `keepDays`).
 * The words in Settings say it; each project's own date comes from the server (`purgeAfter`). */
export const REMOVED_KEEP_DAYS = 14;

/** The open project's deleted files, as Settings shows them: the hook's state, and who is looking. */
export type DeletedFilesView = DeletedFilesState & { you?: Actor; projectName?: string };

export type RecentlyDeleted = {
  /** Beside the projects, where the open project's server lists its deleted files. */
  files?: DeletedFilesView;
  /** The projects deleted and still restorable; null until the server has answered. */
  projects: RemovedProject[] | null;
  /** Why the list couldn't be read, or a restore couldn't be made, in words. */
  error: string | null;
  /** The project being restored now. */
  busy: string | null;
  restore: (id: string) => void;
  /** Asks the server again. */
  reload: () => void;
};

/**
 * "Recently deleted": the server's removed projects, asked while `wanted` (Settings is open on the
 * Project tab) and each time it opens, and nothing of them kept on this device. `restored` runs once
 * the server has brought one back, to bring it into the project list.
 */
export function useRemovedProjects(source: RemovedProjects | undefined, wanted: boolean, restored: (project: RemovedProject) => Promise<void> | void): RecentlyDeleted {
  const [projects, setProjects] = useState<RemovedProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const keepError = useRef(false);

  useEffect(() => {
    if (!source || !wanted) return undefined;
    let cancelled = false;
    source.list().then(
      (list) => {
        if (cancelled) return;
        setProjects(list);
        // A refused restore's error outlives the read that follows it; a reload the person asked for clears
        // it. The flag is read here, not inside a state updater, which React may run after it's reset.
        const keep = keepError.current;
        keepError.current = false;
        if (!keep) setError(null);
      },
      (reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      },
    );
    return () => {
      cancelled = true;
      // Closed: the next opening asks again, and shows nothing stale meanwhile.
      setProjects(null);
    };
  }, [source, wanted, nonce]);

  const reload = useCallback(() => setNonce((count) => count + 1), []);
  const restore = useCallback(
    (id: string) => {
      const project = projects?.find((item) => item.id === id);
      if (!source || !project) return;
      setBusy(id);
      setError(null);
      void (async () => {
        try {
          await source.restore(id);
          await restored(project);
        } catch (reason) {
          // One purged meanwhile answers 404: the list is read again so it's gone from it.
          setError(`Couldn’t restore ${project.name}. ${errorMessage(reason)}`);
          keepError.current = true;
        } finally {
          setBusy(null);
          reload();
        }
      })();
    },
    [source, projects, restored, reload],
  );

  return { projects, error, busy, restore, reload };
}
