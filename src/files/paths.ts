/** Project paths: POSIX-style, relative to the project's root (src/files/types.ts). */

export class InvalidPathError extends Error {
  constructor(path: unknown, reason: string) {
    super(`Invalid path ${JSON.stringify(path)}: ${reason}`);
    this.name = 'InvalidPathError';
  }
}

const MAX_SEGMENT_BYTES = 255;
// C0 controls (NUL included), DEL and the C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const encoder = new TextEncoder();

function segmentProblem(segment: string): string | null {
  if (segment === '') return 'empty segment';
  if (segment === '.' || segment === '..') return `'${segment}' segment`;
  if (encoder.encode(segment).length > MAX_SEGMENT_BYTES) return `segment longer than ${MAX_SEGMENT_BYTES} bytes`;
  return null;
}

function pathProblem(path: unknown): string | null {
  if (typeof path !== 'string') return 'not a string';
  if (path === '') return 'empty';
  if (path.startsWith('/')) return 'absolute';
  if (path.includes('\\')) return 'backslash';
  if (CONTROL_CHARACTERS.test(path)) return 'control character';
  for (const segment of path.split('/')) {
    const problem = segmentProblem(segment);
    if (problem) return problem;
  }
  return null;
}

/** The canonical form of a project path, or InvalidPathError. Valid paths are
 * already canonical, so a valid path comes back unchanged. */
export function normalizePath(path: string): string {
  const problem = pathProblem(path);
  if (problem) throw new InvalidPathError(path, problem);
  return path;
}

export function isValidPath(path: string): boolean {
  return pathProblem(path) === null;
}

/** Joins path parts with '/', treating '' as the root, and validates the result. */
export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter((part) => part !== '').join('/'));
}

/** The folder holding the entry: '' for a top-level entry. */
export function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** The last path segment. */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

// Two-part extensions, matched without regard to case. A name keeps them
// together when Nebula adds ' 2' or changes the stem.
const DOUBLE_EXTENSIONS = ['excalidraw.md', 'excalidraw.json', 'excalidraw.svg', 'excalidraw.png', 'tar.gz', 'tar.bz2', 'tar.xz', 'tar.zst'];

function extensionStart(name: string): number {
  const lower = name.toLowerCase();
  for (const double of DOUBLE_EXTENSIONS) {
    const start = name.length - double.length;
    if (start > 1 && lower.endsWith(double) && name[start - 1] === '.') return start;
  }
  const dot = name.lastIndexOf('.');
  // A leading dot names a dotfile, and a trailing dot starts no extension.
  if (dot <= 0 || dot === name.length - 1) return -1;
  return dot + 1;
}

/** The extension without its dot, case kept: 'md', or 'excalidraw.md' for the
 * double extensions Nebula knows. '' when there is none. */
export function extension(path: string): string {
  const name = basename(path);
  const start = extensionStart(name);
  return start < 0 ? '' : name.slice(start);
}

/** The name without its extension: 'Winter hexagon' for 'Winter hexagon.excalidraw.md'. */
export function stem(path: string): string {
  const name = basename(path);
  const start = extensionStart(name);
  return start < 0 ? name : name.slice(0, start - 1);
}

/** The folders above a path, outermost first: ['a', 'a/b'] for 'a/b/c.txt'. */
export function ancestors(path: string): string[] {
  const segments = path.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

/** True when `path` is `folder` itself or anything inside it. */
export function isInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** `stemPart` + `suffix`, the stem shortened (by whole characters) until
 * the name fits in 255 bytes; the suffix is always kept whole. */
export function fitSegment(stemPart: string, suffix: string): string {
  let shortened = stemPart;
  while (shortened && encoder.encode(shortened + suffix).length > MAX_SEGMENT_BYTES) {
    shortened = Array.from(shortened).slice(0, -1).join('');
  }
  return shortened + suffix;
}

/** `desired`, or the first free 'Name 2.ext', 'Name 3.ext'… among a folder's
 * entry names. Names that differ only in case or Unicode composition count as
 * taken, so a project still unpacks on macOS and Windows. */
export function uniqueName(existingNames: Iterable<string>, desired: string): string {
  normalizePath(desired);
  if (desired.includes('/')) throw new InvalidPathError(desired, 'not a single name');
  const taken = new Set(Array.from(existingNames, nameKey));
  if (!taken.has(nameKey(desired))) return desired;
  const ext = extension(desired);
  const base = stem(desired);
  for (let n = 2; ; n += 1) {
    const candidate = fitSegment(base, ` ${n}${ext ? `.${ext}` : ''}`);
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}

/** Sort order for project paths: segment by segment, in code-unit order, so a
 * folder comes straight before its contents ('Guides', 'Guides/Orion.md',
 * 'Guides 2'). Swapping '/' for NUL, which no valid path contains, gives the
 * same order as comparing segment arrays. */
export function comparePaths(a: string, b: string): number {
  const keyA = a.replaceAll('/', '\u0000');
  const keyB = b.replaceAll('/', '\u0000');
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

// Names a project should never be given, so it unpacks and reads the same
// everywhere. Stores still take them: files that already
// have them keep working, and projectToZip maps them (portableName).
const DIRECTION_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;
const LINE_SEPARATORS = /[\u2028\u2029]/g;
const WINDOWS_RESERVED_CHARACTERS = /[<>:"|?*]/g;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// eslint-disable-next-line no-control-regex
const ALL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** The part Windows checks for device names: up to the first dot, trailing spaces dropped. */
function deviceStem(name: string): string {
  const dot = name.indexOf('.');
  return (dot < 0 ? name : name.slice(0, dot)).trimEnd();
}

/** Why `name` can't be the name of a new file or folder (one typed in a
 * create or rename, or an upload's), or null when it can: no invisible
 * text-direction controls (they make 'report\u202Efdp.exe' read 'reportexe.pdf'),
 * no line separators or control characters, none of the characters or names
 * Windows reserves (<>:"|?*, CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or
 * without an extension), and no trailing dot or space. The workspace's
 * validateName() adds its own rules (empty, '/', '.nebula'). */
export function newNameProblem(name: string): string | null {
  if (name.match(DIRECTION_CONTROLS)) return 'A name can’t contain invisible text-direction characters.';
  if (name.match(LINE_SEPARATORS)) return 'A name can’t contain a line break.';
  if (name.match(ALL_CONTROL_CHARACTERS)) return 'A name can’t contain control characters.';
  const reserved = name.match(WINDOWS_RESERVED_CHARACTERS);
  if (reserved) return `A name can’t contain ${reserved[0]}, which Windows reserves.`;
  if (/[. ]$/.test(name)) return 'A name can’t end with a dot or a space.';
  if (WINDOWS_RESERVED_NAME.test(deviceStem(name))) return `${deviceStem(name).toUpperCase()} is reserved on Windows.`;
  return null;
}

/** `name` as it can unpack on Windows and macOS and read as it does here:
 * direction controls dropped, line separators made spaces, reserved and
 * control characters made '_', trailing dots and spaces dropped (as Windows
 * would), and '_' after a reserved device name. An ordinary name comes back
 * unchanged. Two names can map to one: callers keep them apart (uniqueName). */
export function portableName(name: string): string {
  let portable = name
    .replace(DIRECTION_CONTROLS, '')
    .replace(LINE_SEPARATORS, ' ')
    .replace(ALL_CONTROL_CHARACTERS, '_')
    .replace(WINDOWS_RESERVED_CHARACTERS, '_')
    .replace(/[. ]+$/, '');
  if (portable === '') portable = '_';
  const device = deviceStem(portable);
  if (WINDOWS_RESERVED_NAME.test(device)) portable = `${device}_${portable.slice(portable.indexOf(device) + device.length)}`;
  return portable;
}

/** Groups of paths that are one name on a case-insensitive disk (macOS,
 * Windows), such as `Docs` and `docs`, or `a/Note.md` and `a/note.md`. Only
 * the topmost of each: `Docs/a.md` and `docs/a.md` follow from `Docs` and
 * `docs`, so they aren't named again. Each group is sorted. */
export function caseCollisions(paths: string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const path of new Set(paths)) {
    const key = path.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), path]);
  }
  const colliding = new Set([...groups].filter(([, members]) => members.length > 1).map(([key]) => key));
  const out: string[][] = [];
  for (const key of colliding) {
    let inside = false;
    for (let at = key.indexOf('/'); at !== -1 && !inside; at = key.indexOf('/', at + 1)) inside = colliding.has(key.slice(0, at));
    if (!inside) out.push([...groups.get(key)!].sort(comparePaths));
  }
  return out.sort((a, b) => comparePaths(a[0], b[0]));
}
