/**
 * Link updates after a rename, a move or a batch of replaced images, run
 * against a store (reading lane, task 3; the batch form, 2.0.2). `updateLinks.ts` decides what a note's text becomes; this reads
 * the project's notes, and writes each one that changed, safely:
 *
 *   - a write is `ifUnchanged` against the text read, as a tab's save is: a
 *     note that changed meanwhile is left as the other writer made it;
 *   - a note with unsaved changes open in a tab is left alone, and said so;
 *   - a canvas (`.excalidraw.md`, or a plain `.md` that is an Excalidraw
 *     drawing), a file that isn't UTF-8 text, and a note over 200,000
 *     characters are never rewritten;
 *   - each note on its own: one that can't be read or written doesn't stop
 *     the others.
 * It resolves with what it did; it rejects only when the project can't be
 * listed (a folder that isn't reachable), which the caller leaves unsaid.
 */
import { errorName } from '../files/errors';
import { kindFromContent, kindFromName } from '../files/kinds';
import { basename, isInside } from '../files/paths';
import type { FileStore } from '../files/types';
import { readFileText } from './views/shared/textSession';
import { linkWorld, mayHaveLinks, updateLinks } from './updateLinks';

/** A note longer than this (in characters) is not read for links: the reading view won't draw it either (NoteView). */
export const MAX_LINK_NOTE_CHARS = 200_000;
const MANY = 300;

export type LinkRun = {
  /** Links rewritten, and the notes they were in. */
  links: number;
  notes: number;
  /** Notes left as they were, and why. */
  unsaved: number;
  changed: number;
  long: number;
  failed: number;
};

export type LinkRunOptions = {
  /** What was renamed or moved: a file or a folder, from and to. */
  from: string;
  to: string;
  /** Whether a note (by its path now) has changes open in a tab that aren't saved yet. */
  unsaved(path: string): boolean;
};

const noteName = (path: string) => /\.(md|markdown)$/i.test(path) && kindFromName(path) === 'note';

/** The words a link to a moved file would carry: its name, and the name without its extension, in plain and percent-encoded writing. */
function namesOf(oldPaths: string[]): string[] {
  const names = new Set<string>();
  for (const path of oldPaths) {
    const name = basename(path).toLowerCase();
    const stem = name.replace(/\.excalidraw\.md$/, '.excalidraw').replace(/\.md$/, '');
    for (const form of [name, stem]) {
      names.add(form);
      names.add(encodeURIComponent(form).toLowerCase());
    }
  }
  return [...names];
}

/** What each run reads before it rewrites: the files as they are now, and where each moved file was. */
type MoveSet = {
  /** Every file now. */
  files: Array<{ path: string; size?: number }>;
  /** Old path → new path, for each file that moved. */
  moved: Map<string, string>;
  /** Where a file (by its path now) was before the move. */
  oldPath(path: string): string;
};

/** The one run behind a rename and a batch: reads each note once and writes the ones whose links change. */
async function followMoves(store: FileStore, { files, moved, oldPath }: MoveSet, unsaved: (path: string) => boolean): Promise<LinkRun> {
  const run: LinkRun = { links: 0, notes: 0, unsaved: 0, changed: 0, long: 0, failed: 0 };
  if (moved.size === 0) return run;
  const world = linkWorld(
    files.map((entry) => oldPath(entry.path)),
    files.map((entry) => entry.path),
    moved,
  );
  const names = moved.size > MANY ? null : namesOf([...moved.keys()]);

  const one = async (path: string, size: number | undefined): Promise<void> => {
    const moving = oldPath(path) !== path;
    try {
      const { text, utf8 } = await readFileText(store, path);
      if (!utf8 || !mayHaveLinks(text)) return;
      // A note that didn't move only matters if it says the name of something that did.
      const lower = names && !moving ? text.toLowerCase() : '';
      if (names && !moving && !names.some((name) => lower.includes(name))) return;
      if (text.length > MAX_LINK_NOTE_CHARS || (size ?? 0) > MAX_LINK_NOTE_CHARS) {
        run.long += 1;
        return;
      }
      if (kindFromContent(basename(path), text) !== 'note') return;
      const result = updateLinks(text, oldPath(path), path, world);
      if (result.count === 0) return;
      if (unsaved(path)) {
        run.unsaved += 1;
        return;
      }
      try {
        await store.write(path, result.text, { ifUnchanged: { text } });
        run.links += result.count;
        run.notes += 1;
      } catch (error) {
        if (errorName(error) === 'FileChangedError') run.changed += 1;
        else run.failed += 1;
      }
    } catch {
      run.failed += 1;
    }
  };

  const notes = files.filter((entry) => noteName(entry.path));
  const queue = [...notes];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await one(next.path, next.size);
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return run;
}

export async function updateLinksAfterMove(store: FileStore, { from, to, unsaved }: LinkRunOptions): Promise<LinkRun> {
  const files = (await store.list()).filter((entry) => entry.type === 'file');
  const oldPath = (path: string) => (isInside(path, to) ? from + path.slice(to.length) : path);
  const moved = new Map<string, string>();
  for (const { path } of files) if (isInside(path, to) && oldPath(path) !== path) moved.set(oldPath(path), path);
  return followMoves(store, { files, moved, oldPath }, unsaved);
}

/** One file that went and the file that took its place (an image Convert images replaced). */
export type FileMove = { from: string; to: string };

/**
 * The same run for a batch of single-file moves, as a folder's *Convert
 * images* makes them: each note is read once and every move is applied to it
 * together, with the rules above. The files are already at their new paths
 * (and the old ones gone) when it runs. Notes themselves don't move here.
 */
export async function updateLinksAfterMoves(store: FileStore, moves: readonly FileMove[], { unsaved }: Pick<LinkRunOptions, 'unsaved'>): Promise<LinkRun> {
  const moved = new Map(moves.filter((move) => move.from !== move.to).map((move) => [move.from, move.to] as const));
  if (moved.size === 0) return { links: 0, notes: 0, unsaved: 0, changed: 0, long: 0, failed: 0 };
  const files = (await store.list()).filter((entry) => entry.type === 'file');
  const back = new Map([...moved].map(([from, to]) => [to, from] as const));
  return followMoves(store, { files, moved, oldPath: (path) => back.get(path) ?? path }, unsaved);
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** What the status line says about a run, or null when there is nothing to say. */
export function linkRunMessage(run: LinkRun): string | null {
  const said: string[] = [];
  if (run.links > 0) said.push(`Updated ${run.links} ${plural(run.links, 'link', 'links')} in ${run.notes} ${plural(run.notes, 'note', 'notes')}.`);
  if (run.unsaved > 0) said.push(`Left ${run.unsaved} ${plural(run.unsaved, 'note as it was: it has', 'notes as they were: they have')} unsaved changes.`);
  if (run.changed > 0) said.push(`Left ${run.changed} ${plural(run.changed, 'note as it was: it changed', 'notes as they were: they changed')} meanwhile.`);
  if (run.long > 0) said.push(`Left ${run.long} ${plural(run.long, 'note as it was: it is', 'notes as they were: they are')} over 200,000 characters.`);
  if (run.failed > 0) said.push(`Couldn’t update ${run.failed} ${plural(run.failed, 'note', 'notes')}.`);
  return said.length > 0 ? said.join(' ') : null;
}
