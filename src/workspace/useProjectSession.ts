import { useCallback, useEffect, useReducer, useRef, useState, type Dispatch } from 'react';
import { kindFromName } from '../files/kinds';
import { isInside } from '../files/paths';
import type { FileEntry, FileKind, FileStore, ProjectRegistry, WorkspaceState } from '../files/types';
import { resolveKind } from './fileKind';
import {
  EMPTY_WORKSPACE,
  WORKSPACE_FILE,
  parseWorkspaceState,
  serializeWorkspaceState,
  workspaceReducer,
  type WorkspaceAction,
} from './workspaceState';

const SAVE_DELAY = 300;
const REFRESH_DELAY = 60;

export type ProjectSession = {
  /** The project these files belong to, once its store is open. */
  projectId: string | null;
  store: FileStore | null;
  entries: FileEntry[];
  /** True once the first listing (and workspace.json) has arrived. */
  ready: boolean;
  ws: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  /** Kinds by path. A plain `.md` appears once its content has been
   * checked (it may be a drawing); everything else at once. */
  kinds: Readonly<Record<string, FileKind>>;
  /** Lists the files again; the newest listing wins. */
  refresh: () => Promise<FileEntry[]>;
  /** A project that wouldn't open. */
  error: string | null;
  /** The file on screen, deleted elsewhere: its tab stays while it's the
   * active one, so its view can say so; choosing another tab lets it go. */
  gone: FileEntry | null;
  /** Says that this workspace is about to remove `path` itself, so its tabs
   * close at once. Call the returned function once it's done. */
  removing: (path: string) => () => void;
};

function needsContentCheck(name: string): boolean {
  return kindFromName(name) === 'note';
}

function signature(entry: FileEntry): string {
  return `${entry.size ?? ''}:${entry.modified ?? ''}`;
}

function sameKinds(a: Readonly<Record<string, FileKind>>, b: Readonly<Record<string, FileKind>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** One open project: its store, its files, and what was open in it
 * (`.nebula/workspace.json`), restored on open and saved as it changes.
 * Follows store.watch(), so changes from other tabs show up. */
export function useProjectSession(registry: ProjectRegistry, projectId: string | null): ProjectSession {
  const [ws, dispatch] = useReducer(workspaceReducer, EMPTY_WORKSPACE);
  const [store, setStore] = useState<FileStore | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kinds, setKinds] = useState<Record<string, FileKind>>({});

  const listSeq = useRef(0);
  const storeRef = useRef<FileStore | null>(null);
  const savedText = useRef<string | null>(null);
  const pending = useRef<{ store: FileStore; text: string } | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const kindCache = useRef(new Map<string, { sig: string; kind: FileKind }>());
  const [gone, setGone] = useState<FileEntry | null>(null);
  const goneRef = useRef<FileEntry | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = ws.active;
  const entriesRef = useRef<FileEntry[]>([]);
  entriesRef.current = entries;
  const ownRemovals = useRef(new Set<string>());
  /** Counts the changes heard, so a listing knows which came after it began. */
  const changeSeq = useRef(0);
  /** Files updated from a stat after a write, and when (review finding 26). */
  const patches = useRef(new Map<string, { seq: number; entry: FileEntry }>());

  const setGoneEntry = useCallback((entry: FileEntry | null) => {
    goneRef.current = entry;
    setGone(entry);
  }, []);

  const removing = useCallback((path: string) => {
    ownRemovals.current.add(path);
    return () => {
      ownRemovals.current.delete(path);
    };
  }, []);

  const flush = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const job = pending.current;
    pending.current = null;
    if (!job) return;
    job.store.write(WORKSPACE_FILE, job.text).catch((reason: unknown) => {
      console.warn('Nebula could not save workspace.json', reason);
    });
  }, []);

  const listInto = useCallback(async (target: FileStore): Promise<FileEntry[]> => {
    const seq = ++listSeq.current;
    const since = changeSeq.current;
    const listed = await target.list();
    if (seq === listSeq.current && storeRef.current === target) {
      // A file updated from a write while this list was being made keeps the newer word.
      const list = listed.map((entry) => {
        const patch = patches.current.get(entry.path);
        return patch && patch.seq > since ? patch.entry : entry;
      });
      for (const [path, patch] of patches.current) if (patch.seq <= since) patches.current.delete(path);
      setEntries(list);
      let ghost = goneRef.current;
      // Back again (written anew): it's a file like any other.
      if (ghost && list.some((entry) => entry.path === ghost?.path)) {
        ghost = null;
        setGoneEntry(null);
      }
      dispatch({ type: 'prune', entries: ghost ? [...list, ghost] : list });
      return list;
    }
    return listed;
  }, [setGoneEntry]);

  const refresh = useCallback(async () => {
    const target = storeRef.current;
    if (!target) return [];
    return listInto(target);
  }, [listInto]);

  /* ---- open the project, restore what was open, follow changes ---- */

  useEffect(() => {
    let cancelled = false;
    let unwatch: (() => void) | undefined;
    let refreshTimer: number | undefined;

    storeRef.current = null;
    savedText.current = null;
    kindCache.current = new Map();
    patches.current = new Map();
    setStore(null);
    setOpenId(null);
    setEntries([]);
    setKinds({});
    setReady(false);
    setError(null);
    setGoneEntry(null);
    dispatch({ type: 'load', state: EMPTY_WORKSPACE });
    if (!projectId) return;

    (async () => {
      try {
        const opened = await registry.open(projectId);
        if (cancelled) return;
        storeRef.current = opened;
        const [list, text] = await Promise.all([opened.list(), opened.readText(WORKSPACE_FILE).catch(() => null)]);
        if (cancelled) return;
        const restored = workspaceReducer(parseWorkspaceState(text), { type: 'prune', entries: list });
        savedText.current = serializeWorkspaceState(restored);
        dispatch({ type: 'load', state: restored });
        setEntries(list);
        setStore(opened);
        setOpenId(projectId);
        setReady(true);

        const listSoon = () => {
          window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => {
            if (!cancelled) void listInto(opened).catch(() => {});
          }, REFRESH_DELAY);
        };

        unwatch = opened.watch((change) => {
          if (cancelled) return;
          const touched = change.type === 'rename' ? [change.from, change.to] : [change.path];
          if (touched.every((path) => path === '.nebula' || path.startsWith('.nebula/'))) return;
          const seq = ++changeSeq.current;
          if (change.type === 'write' && entriesRef.current.some((entry) => entry.path === change.path && entry.type === 'file')) {
            // A file the tree already has, saved again (a canvas while it's
            // drawn on): one stat, not a walk of the whole project (review
            // finding 26).
            opened.stat(change.path).then(
              (entry) => {
                if (cancelled || storeRef.current !== opened) return;
                if (!entry || entry.type !== 'file') {
                  listSoon();
                  return;
                }
                const newer = patches.current.get(entry.path);
                if (newer && newer.seq > seq) return;
                patches.current.set(entry.path, { seq, entry });
                setEntries((current) => current.map((item) => (item.path === entry.path ? entry : item)));
              },
              () => listSoon(),
            );
            return;
          }
          if (change.type === 'rename') dispatch({ type: 'renamed', from: change.from, to: change.to });
          if (change.type === 'remove') {
            const active = activeRef.current;
            const elsewhere = !ownRemovals.current.has(change.path);
            const shown = active && isInside(active, change.path) ? entriesRef.current.find((entry) => entry.path === active) : undefined;
            // The file on screen, deleted elsewhere, stays until another tab is
            // chosen, so its view can say what happened.
            if (elsewhere && shown && shown.type === 'file') setGoneEntry(shown);
            dispatch({ type: 'removed', path: change.path, keep: elsewhere && shown ? shown.path : undefined });
          }
          listSoon();
        });
      } catch (reason) {
        if (cancelled) return;
        console.error('Nebula could not open the project', reason);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimer);
      unwatch?.();
      flush();
    };
  }, [registry, projectId, listInto, flush, setGoneEntry]);

  // Another tab chosen (or this one closed): the deleted file goes.
  useEffect(() => {
    if (!gone || ws.active === gone.path) return;
    setGoneEntry(null);
    dispatch({ type: 'close', path: gone.path });
  }, [gone, ws.active, setGoneEntry]);

  /* ---- save workspace.json as it changes ---------------------------- */

  useEffect(() => {
    if (!ready || !store) return;
    const text = serializeWorkspaceState(ws);
    if (text === savedText.current) return;
    savedText.current = text;
    pending.current = { store, text };
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flush, SAVE_DELAY);
  }, [ws, ready, store, flush]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [flush]);

  /* ---- kinds: by name, and by content for plain .md ----------------- */

  const firstTabs = useRef<string[]>([]);
  firstTabs.current = ws.active ? [ws.active, ...ws.tabs] : ws.tabs;

  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    const cache = kindCache.current;
    const next: Record<string, FileKind> = {};
    const queue: FileEntry[] = [];
    for (const entry of gone ? [...entries, gone] : entries) {
      if (entry.type !== 'file') continue;
      if (!needsContentCheck(entry.name)) {
        next[entry.path] = kindFromName(entry.name);
        continue;
      }
      const cached = cache.get(entry.path);
      // A file that changed keeps its kind while it's checked again, so its
      // view stays on screen (review finding 4); one never checked waits.
      if (cached) next[entry.path] = cached.kind;
      if (!cached || cached.sig !== signature(entry)) queue.push(entry);
    }
    setKinds((current) => (sameKinds(current, next) ? current : next));
    if (queue.length === 0) return;

    // Open files first, so the stage isn't kept waiting.
    const first = new Set(firstTabs.current);
    queue.sort((a, b) => Number(first.has(b.path)) - Number(first.has(a.path)));

    (async () => {
      for (const entry of queue) {
        const kind = await resolveKind(store, entry);
        if (cancelled) return;
        cache.set(entry.path, { sig: signature(entry), kind });
        setKinds((current) => (current[entry.path] === kind ? current : { ...current, [entry.path]: kind }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store, entries, gone]);

  return { projectId: openId, store, entries, ready, ws, dispatch, kinds, refresh, error, gone, removing };
}
