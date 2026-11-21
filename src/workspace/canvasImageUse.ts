/**
 * What links to a file or folder about to be deleted (2.0.4), for the
 * warning before it goes: a canvas that names a deleted image shows it as
 * missing, and a note's link to a deleted file leads nowhere. Read from the
 * project index, where links and embeds in notes and canvases are recorded
 * (a canvas's `## Embedded Files` lines are embed links, indexCanvas.ts).
 */
import { isInside } from '../files/paths';
import type { FileEntry } from '../files/types';
import type { ProjectIndex } from './projectIndex';

/** The canvases outside `path` that hold a file at or under `path` by
 * reference, by path, sorted. */
export function canvasesUsing(index: ProjectIndex, path: string, files: readonly FileEntry[]): string[] {
  const targets = files.filter((entry) => entry.type === 'file' && isInside(entry.path, path)).map((entry) => entry.path);
  const users = new Set<string>();
  for (const target of targets) {
    for (const link of index.backlinks(target)) {
      if (!link.embed || isInside(link.from, path)) continue;
      if (index.docs.get(link.from)?.kind === 'canvas') users.add(link.from);
    }
  }
  return [...users].sort();
}

/** The files outside `path` with a link or embed to a file at or under
 * `path`, by path, sorted, leaving out the canvases `canvasesUsing` names
 * (their warning says more). */
export function filesLinking(index: ProjectIndex, path: string, files: readonly FileEntry[], canvases: readonly string[] = []): string[] {
  const named = new Set(canvases);
  const targets = files.filter((entry) => entry.type === 'file' && isInside(entry.path, path)).map((entry) => entry.path);
  const users = new Set<string>();
  for (const target of targets) {
    for (const link of index.backlinks(target)) {
      if (isInside(link.from, path) || named.has(link.from)) continue;
      users.add(link.from);
    }
  }
  return [...users].sort();
}

/** How many files the delete dialog names before it says “and N more”: the
 * list stays this short however many files point at what's deleted. */
export const REFERENCES_SHOWN = 6;

/** One file that refers to what's about to be deleted, for the dialog's list. */
export type Reference = { path: string; /** A canvas that uses an image as a file beside it. */ canvas: boolean };

/** What the delete dialog lists under “Referenced by”: every file outside
 * `path` that links to, embeds or (a canvas) uses a file at or under it,
 * sorted by path, and how many there are beyond the shown ones. */
export function referencesTo(index: ProjectIndex, path: string, files: readonly FileEntry[]): { shown: Reference[]; more: number } {
  const canvases = canvasesUsing(index, path, files);
  const all: Reference[] = [...canvases.map((from) => ({ path: from, canvas: true })), ...filesLinking(index, path, files, canvases).map((from) => ({ path: from, canvas: false }))];
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Six fit; a seventh would cost the same line as “and 2 more”, so past six the list shows five.
  if (all.length <= REFERENCES_SHOWN) return { shown: all, more: 0 };
  return { shown: all.slice(0, REFERENCES_SHOWN - 1), more: all.length - (REFERENCES_SHOWN - 1) };
}

/** Whether a canvas can hold its images as files: an Obsidian drawing
 * (`.excalidraw.md`, or a `.md` the plugin made), not Excalidraw's own JSON,
 * which has no such convention. Here, not in moveImagesOut.ts, so the menu
 * can ask without loading the drawing code. */
export function movableCanvas(path: string): boolean {
  return /\.md$/i.test(path);
}
