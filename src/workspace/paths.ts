/** The workspace's own name rules: how the tree shows a name, what a new
 * name may be, and where paths land after a move. The path helpers
 * themselves (basename, dirname, joinPath, isInside, uniqueName, extension,
 * stem) are src/files/paths.ts, shared with the stores. */
import { extension, newNameProblem, stem } from '../files/paths';

/** Where `path` lands when `from` (a file or a folder) moves to `to`. */
export function movePath(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return path;
}

const HIDDEN_EXTENSIONS = new Set(['md', 'markdown', 'excalidraw', 'excalidraw.md']);

/** What the tree shows: notes and canvases by name alone (their mark says
 * what they are), everything else with its last extension as a small tag. */
export function describeName(name: string): { label: string; tag: string } {
  const ext = extension(name).toLowerCase();
  if (!ext) return { label: name, tag: '' };
  if (HIDDEN_EXTENSIONS.has(ext)) return { label: stem(name), tag: '' };
  const tag = ext.slice(ext.lastIndexOf('.') + 1);
  return { label: name.slice(0, name.length - tag.length - 1), tag };
}

/** Why a file or folder name can't be used, or null when it can. */
export function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give it a name.';
  if (trimmed.includes('/')) return 'A name can’t contain /.';
  if (trimmed.includes('\\')) return 'A name can’t contain \\.';
  if (trimmed === '.' || trimmed === '..') return 'That name is reserved.';
  if (trimmed.toLowerCase() === '.nebula') return '.nebula holds the project’s settings.';
  // Names that won't unpack on Windows or macOS, or that hide what they are. Files that already have such names still open.
  return newNameProblem(trimmed);
}

/** The name a rename gives: what was typed, trimmed, keeping a file's
 * extension (the tree shows names without it, so people type them without
 * it too). */
export function renameTarget(oldName: string, typed: string, isDir: boolean): string {
  const name = typed.trim();
  if (isDir) return name;
  const ext = extension(oldName);
  if (!ext || name.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) return name;
  return `${name}.${ext}`;
}
