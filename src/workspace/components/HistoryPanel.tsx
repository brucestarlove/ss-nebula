import { lazy, Suspense, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { FileChangedError, FileNotFoundError } from '../../files/errors';
import { hasHistory, type ChangeRecord, type HistoryStore } from '../../files/history';
import { formatBytes as formatSize } from '../../files/persist';
import type { VersionInfo, VersionsPage } from '../../files/serverContract';
import type { Actor, FileEntry, FileKind, FileStore, ProjectTier } from '../../files/types';
import { errorMessage } from '../views/shared/download';
import { formatActor, formatDateTime, formatWhen } from '../views/shared/format';
import { useNow } from '../views/shared/hooks';
import { Button } from './Button';
import { ConfirmDialog } from './Dialogs';

// The preview draws notes and canvases, so it comes with the first preview, not with the panel.
const HistoryPreview = lazy(() => import('./HistoryPreview'));

/** How many versions the panel asks for at a time. */
const PAGE = 20;
/** After the file or its version changes, the list waits for writing to settle, as the project index does. */
export const SETTLE_MS = 600;
/** After another file is opened there's nothing to settle: a short pause, so flicking through tabs asks once. */
const SWITCH_MS = 150;

export type HistoryProps = {
  projectId: string;
  /** The active file, or null when none is open. */
  entry: FileEntry | null;
  kind: FileKind | null;
  store: FileStore | null;
  /** Where the project lives: only a server's keeps history. */
  tier: ProjectTier | null;
  /** The server keeps earlier versions (`capabilities.versions`). */
  versions: boolean;
  /** Who is using the app: the server's records name them, and the panel says "you". */
  you?: Actor;
  /** Says something in the status line ("Restored …"). */
  onNotify?: (text: string) => void;
};

type Slot<T> = { scope: string; value?: T; error?: unknown };

/** A list asked of the server when the file or its version changes, and not on every keystroke:
 * saves land one at a time, and each waits SETTLE_MS for the next. Nothing is kept on the device. */
function useServerList<T>(scope: string | null, fingerprint: string, fetch: () => Promise<T>) {
  const [slot, setSlot] = useState<Slot<T> | null>(null);
  const [nonce, setNonce] = useState(0);
  const forced = useRef(false);
  const seen = useRef<string | null>(null);
  const fetchRef = useRef(fetch);
  useLayoutEffect(() => {
    fetchRef.current = fetch;
  });
  useLayoutEffect(() => {
    if (scope === null) return undefined;
    const switched = seen.current !== scope;
    seen.current = scope;
    const delay = forced.current ? 0 : switched ? SWITCH_MS : SETTLE_MS;
    forced.current = false;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      fetchRef.current().then(
        (value) => !cancelled && setSlot({ scope, value }),
        (error: unknown) => !cancelled && setSlot({ scope, error }),
      );
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [scope, fingerprint, nonce]);
  // What was asked for another file is not this file's.
  const current = slot && slot.scope === scope ? slot : null;
  const reload = useCallback(() => {
    forced.current = true;
    setNonce((count) => count + 1);
  }, []);
  const replace = useCallback((value: T) => scope !== null && setSlot({ scope, value }), [scope]);
  return { slot: current, reload, replace };
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Who wrote a version or made a change: "you", a name, or no one Nebula knows. */
function whoOf(actor: Actor | undefined, you?: Actor): string {
  return actor ? capital(formatActor(actor, you)) : 'Outside Nebula';
}

/** How the file's size moved from the version before it: '+1.2 KB', '−340 B', 'Same size'; the size alone for the oldest known. */
function sizeChange(version: VersionInfo, older: VersionInfo | undefined): string {
  if (!older) return formatSize(version.size);
  const delta = version.size - older.size;
  if (delta === 0) return 'Same size';
  return `${delta > 0 ? '+' : '−'}${formatSize(Math.abs(delta))}`;
}

function Time({ at, now }: { at: string; now: number }) {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return (
    <time className="ws-history-when" dateTime={at} title={formatDateTime(ms)}>
      {formatWhen(ms, now)}
    </time>
  );
}

function Problem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof FileNotFoundError) return <p className="ws-panel-empty">Nothing is kept for this file yet.</p>;
  return (
    <>
      <p className="ws-panel-empty" role="alert">
        Couldn’t read this file’s history. {errorMessage(error)}
      </p>
      <Button className="ws-history-act" onClick={onRetry}>
        Try again
      </Button>
    </>
  );
}

/** What a change did to the path, in a few words. */
function changeText(change: ChangeRecord, path: string): string {
  if (change.type === 'remove') return 'Deleted';
  if (change.type === 'rename') return change.from === path ? `Renamed to ${change.to ?? ''}` : `Renamed from ${change.from ?? ''}`;
  return 'Edited';
}

/** A server that keeps no versions (a folder): who changed the file and when, from its log, and no Restore. */
function ChangeLog({ store, projectId, path, fingerprint, you }: { store: FileStore & HistoryStore; projectId: string; path: string; fingerprint: string; you?: Actor }) {
  const now = useNow(30_000);
  const { slot, reload } = useServerList(`${projectId}\u0000${path}`, fingerprint, () => store.changes(path, { limit: 30 }));
  const changes = slot?.value?.filter((change) => change.type === 'write' || change.type === 'remove' || change.type === 'rename');
  return (
    <>
      {slot?.error ? (
        <Problem error={slot.error} onRetry={reload} />
      ) : !changes ? null : changes.length === 0 ? (
        <p className="ws-panel-empty">No changes are recorded for this file since the server started.</p>
      ) : (
        <ul className="ws-history-list" aria-label="Who changed this file">
          {changes.map((change) => (
            <li key={change.cursor} className="ws-history-row">
              <div className="ws-history-line">
                <span className="ws-history-who">{whoOf(change.actor, you)}</span>
                <Time at={change.at} now={now} />
              </div>
              <div className="ws-history-note">{changeText(change, path)}</div>
            </li>
          ))}
        </ul>
      )}
      <p className="ws-panel-empty ws-history-keep">This server keeps no earlier versions. For a folder, its own history, such as git or backups, is where they live.</p>
    </>
  );
}

type Asked = { versions: VersionInfo[]; next: string | null };

/** The file's versions, newest first, each with who, when and what it changed; earlier ones can be looked at and restored. */
function Versions({ store, projectId, entry, kind, fingerprint, you, onNotify }: { store: FileStore & HistoryStore; projectId: string; entry: FileEntry; kind: FileKind | null; fingerprint: string; you?: Actor; onNotify?: (text: string) => void }) {
  const path = entry.path;
  const now = useNow(30_000);
  const { slot, reload, replace } = useServerList<Asked>(`${projectId}\u0000${path}`, fingerprint, () => store.versions(path, { limit: PAGE }));
  const [more, setMore] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [preview, setPreview] = useState<VersionInfo | null>(null);
  const [confirm, setConfirm] = useState<VersionInfo | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const asked = slot?.value;
  const list = asked?.versions ?? [];
  const current = list.find((version) => version.current);
  const nameOf = (version: VersionInfo) => `the version from ${formatDateTime(Date.parse(version.at))} by ${version.actor ? formatActor(version.actor, you) : 'someone outside Nebula'}`;

  const showEarlier = useCallback(async () => {
    if (!asked?.next) return;
    setMore('loading');
    try {
      const page: VersionsPage = await store.versions(path, { before: asked.next, limit: PAGE });
      replace({ versions: [...asked.versions, ...page.versions], next: page.next });
      setMore('idle');
    } catch {
      setMore('failed');
    }
  }, [asked, store, path, replace]);

  const restore = async (version: VersionInfo) => {
    setConfirm(null);
    setBusy(true);
    setProblem(null);
    try {
      // Over the version this list showed as the file's, or into the gap where it was deleted.
      await store.restore(path, version.version, current ? { ifMatch: current.version } : { ifAbsent: true });
      onNotify?.(`Restored ${entry.name} to ${nameOf(version)}.`);
      reload();
    } catch (error) {
      if (error instanceof FileChangedError) setChanged(true);
      else setProblem(`Couldn’t restore: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {slot?.error ? (
        <Problem error={slot.error} onRetry={reload} />
      ) : !asked ? null : list.length === 0 ? (
        <p className="ws-panel-empty">Nothing is kept for this file yet.</p>
      ) : (
        <ul className="ws-history-list" aria-label={`Versions of ${entry.name}`}>
          {list.map((version, index) => {
            const older = list[index + 1];
            const source = version.restoredFrom ? list.find((other) => other.version === version.restoredFrom) : undefined;
            const sourceMs = source ? Date.parse(source.at) : NaN;
            return (
              <li key={version.version} className="ws-history-row" data-current={version.current ? '' : undefined}>
                <div className="ws-history-line">
                  <span className="ws-history-who">{whoOf(version.actor, you)}</span>
                  <Time at={version.at} now={now} />
                </div>
                <div className="ws-history-note">
                  {version.current ? 'Current · ' : ''}
                  {sizeChange(version, older)}
                </div>
                {version.restoredFrom ? <div className="ws-history-note">{Number.isFinite(sourceMs) ? `Restored from ${formatDateTime(sourceMs)}` : 'Restored from an earlier version'}</div> : null}
                {version.context ? <div className="ws-history-note ws-history-context">From an Orbit card</div> : null}
                {version.current ? null : (
                  <div className="ws-history-actions">
                    <Button className="ws-history-act" aria-label={`Preview ${nameOf(version)}`} disabled={busy} onClick={() => setPreview(version)}>
                      Preview
                    </Button>
                    <Button className="ws-history-act" aria-label={`Restore ${nameOf(version)}`} disabled={busy} onClick={() => setConfirm(version)}>
                      Restore
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {asked?.next ? (
        <Button className="ws-history-act ws-history-more" disabled={more === 'loading'} onClick={() => void showEarlier()}>
          {more === 'loading' ? 'Loading…' : more === 'failed' ? 'Couldn’t load more. Try again' : 'Show earlier'}
        </Button>
      ) : null}
      {problem ? (
        <p className="ws-panel-empty" role="alert">
          {problem}
        </p>
      ) : null}

      {preview ? (
        <Suspense fallback={null}>
          <HistoryPreview
            store={store}
            projectId={projectId}
            path={path}
            name={entry.name}
            kind={kind}
            version={preview}
            who={whoOf(preview.actor, you)}
            when={formatDateTime(Date.parse(preview.at))}
            onClose={() => setPreview(null)}
            onRestore={() => {
              const version = preview;
              setPreview(null);
              setConfirm(version);
            }}
          />
        </Suspense>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        title="Restore this version?"
        body={confirm ? `${capital(nameOf(confirm))} becomes the file. The current one stays in History.` : ''}
        confirmLabel="Restore"
        onConfirm={() => confirm && void restore(confirm)}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={changed}
        title="This file changed meanwhile"
        body="Someone saved it after this list was read, so nothing was restored. Look again to see its history as it is now."
        confirmLabel="Look again"
        onConfirm={() => {
          setChanged(false);
          reload();
        }}
        onCancel={() => setChanged(false)}
      />
    </>
  );
}

/**
 * The right panel's "History" section, for the active file. A server project that keeps versions
 * lists them, newest first, to look at and restore; a server without versions (a folder) lists who
 * changed the file and when, from its log; a project in the browser or in a folder on this computer
 * says that Nebula keeps no earlier versions there. It reads the server each time the active file or
 * its version changes (after the writing settles), and keeps nothing on this device.
 */
export function HistoryPanel({ projectId, entry, kind, store, tier, versions, you, onNotify }: HistoryProps) {
  const fingerprint = entry ? `${entry.modified ?? ''}:${entry.size ?? ''}:${entry.modifiedBy?.id ?? ''}` : '';
  let body;
  if (!entry) body = <p className="ws-panel-empty">Open a file to see its history here.</p>;
  else if (tier === 'folder') body = <p className="ws-panel-empty">Earlier versions of a folder’s files are kept by git or your backups, not by Nebula.</p>;
  else if (tier !== 'server' || !hasHistory(store)) body = <p className="ws-panel-empty">Earlier versions aren’t kept for a project in this browser.</p>;
  else if (versions) body = <Versions key={`${projectId}:${entry.path}`} store={store} projectId={projectId} entry={entry} kind={kind} fingerprint={fingerprint} you={you} onNotify={onNotify} />;
  else body = <ChangeLog key={`${projectId}:${entry.path}`} store={store} projectId={projectId} path={entry.path} fingerprint={fingerprint} you={you} />;

  return (
    <section aria-labelledby="ws-history-title" className="ws-history">
      <h3 id="ws-history-title">History</h3>
      {body}
    </section>
  );
}
