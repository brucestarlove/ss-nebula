import { basename, dirname } from '../../files/paths';
import { formatActor, formatDay, formatWhen } from '../views/shared/format';
import { useNow } from '../views/shared/hooks';
import { REMOVED_KEEP_DAYS, type DeletedFilesView, type RecentlyDeleted as RecentlyDeletedState } from '../useRemovedProjects';
import { Button, Planet } from './Button';

/** The open project's deleted files: each with its folder, when and who deleted it, and Restore,
 * which puts it back at its path and never over a file that is there now. */
function DeletedFiles({ files, error, busy, taken, more, restore, reload, you, projectName }: DeletedFilesView) {
  const now = useNow(30_000);
  return (
    <div className="ws-removed-files" data-testid="deleted-files">
      <p className="ws-set-help">
        {projectName ? `Deleted files in ${projectName}` : 'Deleted files'} can be restored for {REMOVED_KEEP_DAYS} days, to where they were.
      </p>
      {error ? (
        <p className="ws-set-help ws-bg-problem" role="alert">
          {error}
        </p>
      ) : null}
      {files === null ? (
        error ? (
          <div className="ws-set-actions">
            <Button className="ws-btn" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : (
          <p className="ws-set-help">Looking…</p>
        )
      ) : files.length === 0 ? (
        <p className="ws-set-help">No files have been deleted lately.</p>
      ) : (
        <>
          <ul className="ws-removed-list" aria-label="Recently deleted files">
            {files.map((file) => {
              const folder = dirname(file.path);
              const at = Date.parse(file.deletedAt);
              const who = file.deletedBy ? ` by ${formatActor(file.deletedBy, you)}` : '';
              return (
                <li key={file.path} className="ws-removed-row" data-path={file.path}>
                  <span className="ws-removed-text">
                    <span className="ws-removed-name" title={file.path}>
                      {basename(file.path)}
                    </span>
                    <span className="ws-removed-when">
                      {folder ? `${folder} · ` : ''}Deleted {formatWhen(at, now)}
                      {who}
                    </span>
                  </span>
                  {taken.has(file.path) ? (
                    <span className="ws-removed-when" data-testid="deleted-file-taken">
                      Something is there now
                    </span>
                  ) : (
                    <Button className="ws-btn" aria-label={`Restore ${file.path}`} disabled={busy !== null} onClick={() => restore(file)}>
                      {busy === file.path ? 'Restoring…' : 'Restore'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {more ? <p className="ws-set-help">Only the newest are shown.</p> : null}
        </>
      )}
    </div>
  );
}

/** Settings → Project → "Recently deleted": the projects deleted on the server, each with the day it
 * goes for good, and Restore. */
export function RecentlyDeleted({ projects, error, busy, restore, reload, files }: RecentlyDeletedState) {
  return (
    <div className="drawer-section">
      <h3 className="ws-set-h">Recently deleted</h3>
      <p className="ws-set-help">A deleted project can be restored for {REMOVED_KEEP_DAYS} days. After that it goes for good.</p>
      {error ? (
        <p className="ws-set-help ws-bg-problem" role="alert">
          {error}
        </p>
      ) : null}
      {projects === null ? (
        error ? (
          <div className="ws-set-actions">
            <Button className="ws-btn" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : (
          <p className="ws-set-help">Looking…</p>
        )
      ) : projects.length === 0 ? (
        <p className="ws-set-help">No projects have been deleted lately.</p>
      ) : (
        <ul className="ws-removed-list" aria-label="Recently deleted projects">
          {projects.map((project) => {
            const goes = Date.parse(project.purgeAfter);
            return (
              <li key={project.id} className="ws-removed-row">
                <Planet color={project.color} size={14} />
                <span className="ws-removed-text">
                  <span className="ws-removed-name">{project.name}</span>
                  {Number.isFinite(goes) ? <span className="ws-removed-when">Goes for good on {formatDay(goes)}</span> : null}
                </span>
                <Button className="ws-btn" aria-label={`Restore ${project.name}`} disabled={busy !== null} onClick={() => restore(project.id)}>
                  {busy === project.id ? 'Restoring…' : 'Restore'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {files ? <DeletedFiles {...files} /> : null}
    </div>
  );
}
