/** Errors the file stores reject with. Callers tell them apart by `name`,
 * which also matches the DOMException OPFS throws for a missing entry, so code
 * can check `error.name === 'NotFoundError'` whatever the tier. */

export class FileNotFoundError extends Error {
  constructor(path: string) {
    super(`Nothing exists at ${JSON.stringify(path)}`);
    this.name = 'NotFoundError';
  }
}

export class FileExistsError extends Error {
  constructor(path: string) {
    super(`Something already exists at ${JSON.stringify(path)}`);
    this.name = 'FileExistsError';
  }
}

/** A write's `ifUnchanged` didn't hold: the file isn't what the
 * writer last saw. `absent`: nothing is there (it was moved or deleted), or
 * a folder is, where a text was expected. */
export class FileChangedError extends Error {
  readonly absent: boolean;

  constructor(path: string, absent = false) {
    super(absent ? `${JSON.stringify(path)} is gone, or isn't a file any more` : `${JSON.stringify(path)} changed since it was read`);
    this.name = 'FileChangedError';
    this.absent = absent;
  }
}

/** A rename that had to copy and remove (no move() for folders in Chromium)
 * found a file changed by another app meanwhile, and stopped with the source
 * as it was (S14). */
export class MoveChangedError extends Error {
  constructor(path: string) {
    super(`${JSON.stringify(path)} changed while it was being moved, so it stays where it was`);
    this.name = 'MoveChangedError';
  }
}

/** A file where a folder was needed, or the other way round. */
export class EntryTypeError extends Error {
  constructor(path: string, expected: 'file' | 'folder') {
    super(`${JSON.stringify(path)} is not a ${expected}`);
    this.name = 'TypeMismatchError';
  }
}

export function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string'
    ? (error as { name: string }).name
    : undefined;
}

/** What a folder too big to show says (S8). */
export function folderTooBigMessage(folder: string, max = 10_000): string {
  return `‘${folder}’ holds more than ${max.toLocaleString('en-US')} files, more than Nebula can show. Choose a folder of notes and drawings inside it.`;
}

/** A folder with more in it than Nebula shows (S8). */
export class FolderTooBigError extends Error {
  readonly folder: string;
  constructor(folder: string, max = 10_000) {
    super(folderTooBigMessage(folder, max));
    this.name = 'FolderTooBigError';
    this.folder = folder;
  }
}
