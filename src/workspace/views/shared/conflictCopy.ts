import { errorName } from '../../../files/errors';
import { basename, dirname, extension, fitSegment, joinPath, stem, uniqueName } from '../../../files/paths';
import type { FileStore } from '../../../files/types';

/**
 * Where a change held in a conflict goes when its view closes (re-review
 * R1): beside the file, as '<stem> (conflict YYYY-MM-DD HH.MM)<ext>', so
 * neither the other tab's save nor this one's is lost.
 */

const pad = (value: number) => String(value).padStart(2, '0');

/** The copy's name, in local time, with '.' in the time (':' isn't portable
 * in names), free among `taken` (the folder's names), and at most 255 bytes:
 * the stem is shortened, never the stamp, the counter or the extension. */
export function conflictCopyName(path: string, taken: Iterable<string>, now: Date): string {
  const ext = extension(path);
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
  const names = Array.from(taken);
  for (let n = 1; ; n += 1) {
    const name = fitSegment(stem(path), ` (conflict ${stamp})${n > 1 ? ` ${n}` : ''}${ext ? `.${ext}` : ''}`);
    // uniqueName gives back a free name as it is; names differing only in
    // case or composition count as taken.
    if (uniqueName(names, name) === name) return name;
  }
}

/** How many names writeConflictCopy tries before it gives up. Each miss
 * means another copy of this file landed in the same minute meanwhile. */
const COPY_ATTEMPTS = 10;

/** Writes `data` beside `path` under a free conflict name; returns its path.
 * The write only creates: a copy written at the same moment
 * by another session or tab, under the same name, is never overwritten, and
 * this one takes the next name. */
export async function writeConflictCopy(store: FileStore, path: string, data: string, now = new Date()): Promise<string> {
  const folder = dirname(path);
  const taken = (await store.list()).filter((entry) => dirname(entry.path) === folder).map((entry) => basename(entry.path));
  for (let attempt = 1; ; attempt += 1) {
    const name = conflictCopyName(path, taken, now);
    const copy = joinPath(folder, name);
    try {
      await store.write(copy, data, { exclusive: true });
      return copy;
    } catch (error: unknown) {
      if (errorName(error) !== 'FileExistsError' || attempt >= COPY_ATTEMPTS) throw error;
      taken.push(name);
    }
  }
}
