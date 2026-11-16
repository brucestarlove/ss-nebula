import { isInside, joinPath, normalizePath } from './paths';
import { isProjectSignal, type FileChange, type FileEntry, type FileStore } from './types';

const HIDDEN = '.nebula';

/** A view of one folder of another store, as a store of its own: the browser
 * registry's projects when it runs in memory. Its own `.nebula/` is hidden
 * from list(); the prefix must not lie inside the root's `.nebula/`. */
export function scopedStore(root: FileStore, prefix: string): FileStore {
  normalizePath(prefix);
  const outer = (path: string) => joinPath(prefix, normalizePath(path));
  const inner = (path: string) => path.slice(prefix.length + 1);
  const inside = (path: string) => path !== prefix && isInside(path, prefix);
  const scopeEntry = (entry: FileEntry): FileEntry => ({ ...entry, path: inner(entry.path) });

  // Validate scoped paths first, so errors name the path the caller gave.
  const run = async <T>(paths: string[], action: () => Promise<T>): Promise<T> => {
    for (const path of paths) normalizePath(path);
    return action();
  };

  // The folder itself, or one above it, removed or moved away: from in here,
  // everything is gone.
  const gone: FileChange = { type: 'remove', path: '' };

  function translate(change: FileChange): FileChange | null {
    // The tree's own reach is this scope's too.
    if (isProjectSignal(change)) return change;
    if (change.type === 'remove' && isInside(prefix, change.path)) return gone;
    if (change.type === 'rename' && isInside(prefix, change.from)) return gone;
    if (change.type !== 'rename') return inside(change.path) ? { ...change, path: inner(change.path) } : null;
    const from = inside(change.from);
    const to = inside(change.to);
    if (from && to) return { type: 'rename', from: inner(change.from), to: inner(change.to) };
    // Moves across the edge of the scope look like a removal or an arrival.
    if (from) return { type: 'remove', path: inner(change.from) };
    if (to) return { type: 'write', path: inner(change.to) };
    return null;
  }

  return {
    async list() {
      return (await root.list())
        .filter((entry) => inside(entry.path))
        .map(scopeEntry)
        .filter((entry) => entry.path !== HIDDEN && !entry.path.startsWith(`${HIDDEN}/`));
    },
    stat: (path) => run([path], async () => {
      const entry = await root.stat(outer(path));
      return entry ? scopeEntry(entry) : null;
    }),
    readText: (path) => run([path], () => root.readText(outer(path))),
    readBlob: (path) => run([path], () => root.readBlob(outer(path))),
    // The rest of the arguments whole, so no option is dropped.
    write: (path, ...rest) => run([path], () => root.write(outer(path), ...rest)),
    mkdir: (path) => run([path], () => root.mkdir(outer(path))),
    rename: (from, to) => run([from, to], () => root.rename(outer(from), outer(to))),
    remove: (path) => run([path], () => root.remove(outer(path))),
    watch(listener) {
      return root.watch((change) => {
        const scoped = translate(change);
        if (scoped) listener(scoped);
      });
    },
  };
}
