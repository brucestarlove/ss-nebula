/**
 * Wikilinks and embeds, the way Obsidian reads them: what the
 * text inside `[[ ]]` or `![[ ]]` means, and which file it names. Pure
 * functions with no React and no store, shared by the reading view and the
 * editor, so a link means the same in both.
 *
 *   [[Orion]]  [[Orion#M42|the nebula]]  [[Guides/Orion]]  [[#Targets]]
 *   ![[Winter hexagon.png|300]]  ![[Winter hexagon.excalidraw]]
 */
import type { FileEntry } from '../../../files/types';
import { comparePaths, dirname, joinPath, newNameProblem } from '../../../files/paths';
import { kindFromName } from '../../../files/kinds';

export type WikiTarget = {
  /** The text between the brackets, as written. */
  raw: string;
  /** The file part: a name, or a path from any folder up ('Guides/Orion'), without the heading. '' for a link inside this note. */
  target: string;
  /** After '#': the heading, nested ones joined by '#'. */
  heading: string | null;
  /** After '#^': a block id. */
  block: string | null;
  /** After '|': what the link shows (an embed's caption). */
  alias: string | null;
  embed: boolean;
  /** An embed's `|300` or `|300x200`. */
  size: { width: number; height?: number } | null;
};

const SIZE = /^(\d+)(?:x(\d+))?$/;

export function parseWikilink(raw: string, embed = false): WikiTarget {
  const bar = raw.indexOf('|');
  const place = (bar >= 0 ? raw.slice(0, bar) : raw).trim();
  const after = bar >= 0 ? raw.slice(bar + 1).trim() : '';
  let alias: string | null = after || null;
  let size: WikiTarget['size'] = null;
  if (embed && after) {
    const match = SIZE.exec(after);
    if (match) {
      size = match[2] ? { width: Number(match[1]), height: Number(match[2]) } : { width: Number(match[1]) };
      alias = null;
    }
  }
  const hash = place.indexOf('#');
  const target = (hash >= 0 ? place.slice(0, hash) : place).trim();
  let heading: string | null = null;
  let block: string | null = null;
  if (hash >= 0) {
    const rest = place.slice(hash + 1).trim();
    const caret = rest.indexOf('^');
    if (caret === 0) block = rest.slice(1) || null;
    else if (caret > 0 && rest[caret - 1] === '#') {
      heading = rest.slice(0, caret - 1) || null;
      block = rest.slice(caret + 1) || null;
    } else heading = rest || null;
  }
  return { raw, target, heading, block, alias, embed, size };
}

/** What a link shows: its alias, else its target with its heading ('Note > Heading'). */
export function wikilinkLabel(link: WikiTarget): string {
  if (link.alias) return link.alias;
  const heading = link.heading ? link.heading.split('#').join(' > ') : '';
  if (!link.target) return heading || link.block || '';
  return heading ? `${link.target} > ${heading}` : link.target;
}

function folderDepth(path: string): number {
  return path.split('/').length;
}

/** How many leading folders two paths share. */
function sharedFolders(a: string, b: string): number {
  const left = dirname(a) ? dirname(a).split('/') : [];
  const right = dirname(b) ? dirname(b).split('/') : [];
  let n = 0;
  while (n < left.length && n < right.length && left[n].toLowerCase() === right[n].toLowerCase()) n += 1;
  return n;
}

/**
 * The file a link names, or null. A name without a folder matches any file
 * called that, or that plus `.md` (so `Orion` is the note, and a canvas is
 * `Name.excalidraw`, an image `Name.png`). A name with folders matches the
 * end of a path ('Archive/Orion'), or all of it with a leading '/'. Case is
 * ignored. Several matches: the file in the link's own folder, else the one
 * sharing the most folders with it, else the shallowest, else the first by
 * name. Folders never match.
 */
export function resolveLink(target: string, from: string, files: readonly FileEntry[]): FileEntry | null {
  const matches = linkMatches(target, files);
  if (matches.length === 0) return null;
  const home = dirname(from);
  return (
    [...matches].sort((a, b) => {
      const beside = Number(dirname(b.path) === home) - Number(dirname(a.path) === home);
      if (beside) return beside;
      const near = sharedFolders(b.path, from) - sharedFolders(a.path, from);
      if (near) return near;
      const shallow = folderDepth(a.path) - folderDepth(b.path);
      if (shallow) return shallow;
      return comparePaths(a.path, b.path);
    })[0] ?? null
  );
}

/** Every file a link's target could mean (before the ties are broken): see resolveLink. */
export function linkMatches(target: string, files: readonly FileEntry[]): FileEntry[] {
  const wanted = target.trim().replace(/\\/g, '/').toLowerCase();
  if (!wanted) return [];
  const anchored = wanted.startsWith('/');
  const name = anchored ? wanted.slice(1) : wanted;
  if (!name) return [];
  return files.filter((entry) => {
    if (entry.type !== 'file') return false;
    const path = entry.path.toLowerCase();
    const candidates = [name, `${name}.md`];
    return candidates.some((candidate) => (anchored ? path === candidate : path === candidate || path.endsWith(`/${candidate}`)));
  });
}

/**
 * Whether a link to a file that isn't there can become a note. A name that
 * ends in a type Nebula knows as something else (`Sketch.excalidraw`,
 * `chart.png`, `notes.txt`) names that file, not a note, and Nebula never
 * makes one of those from a link. Anything else, dots and all ('Orion v2.1'),
 * is a note's name.
 */
export function makesNote(target: string): boolean {
  const name = target.trim().replace(/\\/g, '/').split('/').pop() ?? '';
  if (!name || !name.includes('.')) return true;
  const kind = kindFromName(name);
  return kind === 'note' || kind === 'other';
}

export type NewNotePlan = { path: string } | { problem: string };

/**
 * Where the note a missing link names is made: in the folder of the note
 * holding the link, or from the top of the project when the link starts with
 * '/'. A link with folders ('Guides/New') makes them, so the link resolves
 * to the new note again (a path matches the end of a file's path). The name
 * must be one Nebula's own rules accept (`newNameProblem`); otherwise its
 * message comes back.
 */
export function planNewNote(target: string, from: string): NewNotePlan {
  const wanted = target.trim().replace(/\\/g, '/');
  const anchored = wanted.startsWith('/');
  const segments = (anchored ? wanted.slice(1) : wanted).split('/').map((segment) => segment.trim());
  if (segments.every((segment) => segment === '')) return { problem: 'Give the note a name.' };
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return { problem: 'That isn’t a name Nebula can make a note from.' };
    if (segment.toLowerCase() === '.nebula') return { problem: '.nebula holds the project’s settings.' };
    const problem = newNameProblem(segment);
    if (problem) return { problem };
  }
  const last = segments[segments.length - 1];
  segments[segments.length - 1] = /\.(md|markdown)$/i.test(last) ? last : `${last}.md`;
  try {
    return { path: joinPath(anchored ? '' : dirname(from), ...segments) };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : 'That isn’t a name Nebula can make a note from.' };
  }
}

/** The heading a link opens: the last of nested ones ('Note#A#B' is B). */
export function linkHeading(link: WikiTarget): string | undefined {
  return link.heading?.split('#').pop() || undefined;
}

/** A path with its `.` and `..` folded in; null when `..` climbs out of the project. */
function foldPath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

/** Where a markdown link's address points: relative to the note holding it
 * (`../Photos/x.png`), or from the top of the project with a leading '/'.
 * `%20` and the other escapes are decoded; a `?query` or `#fragment` is
 * dropped. Null for a web address, an empty one, or one outside the project. */
export function markdownPath(src: string, from: string): string | null {
  const raw = src.trim().split(/[?#]/)[0];
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // An address with a stray % is taken as written.
  }
  decoded = decoded.replace(/\\/g, '/');
  return foldPath(decoded.startsWith('/') ? decoded : [dirname(from), decoded].filter(Boolean).join('/'));
}

/** The file a markdown link's address names, or null: an exact path, else the one that differs only in case. */
export function resolveMarkdownPath(src: string, from: string, files: readonly FileEntry[]): FileEntry | null {
  const path = markdownPath(src, from);
  if (!path) return null;
  const lower = path.toLowerCase();
  const found = files.filter((entry) => entry.type === 'file' && entry.path.toLowerCase() === lower);
  return found.find((entry) => entry.path === path) ?? found[0] ?? null;
}

/**
 * The shortest link target that names `path` alone among `files`: the bare
 * name (a note without `.md`, a canvas as `Name.excalidraw`, anything else
 * with its extension), else with as many of its folders as it takes, else
 * the full path from the top ('/Name'). What wikilink completion writes; the
 * same rule as updateLinks.ts's `targetFor` for a bare link.
 */
export function shortestTarget(path: string, files: readonly FileEntry[]): string {
  const segments = path.split('/');
  const shown = (count: number): string => {
    const tail = segments.slice(segments.length - count);
    tail[tail.length - 1] = tail[tail.length - 1].replace(/\.md$/i, '');
    return tail.join('/');
  };
  for (let count = 1; count <= segments.length; count += 1) {
    const candidate = shown(count);
    const matches = linkMatches(candidate, files);
    if (matches.length === 1 && matches[0].path === path) return candidate;
  }
  return `/${shown(segments.length)}`;
}
