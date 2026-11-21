/**
 * Links that follow a rename or a move (reading lane, task 3): the text of a
 * note in, the text with its links rewritten out. Pure: no store, no React.
 * `updateLinksRun.ts` reads and writes the notes; this only decides what a
 * note's text becomes.
 *
 * A link is rewritten only when it would otherwise stop pointing at the file
 * it pointed at. Each link is resolved twice with the rules of links.ts: as
 * the note and the files were before the move, and as they are after it. If
 * the same words still reach the same file, the link is left as written (a
 * move that changes nothing costs nothing); if they reach another file or none,
 * the target is rewritten to name the moved file again:
 *
 *   - the alias, the heading, the block id and an embed's size stay;
 *   - a bare name stays bare while it names the file alone, else it becomes
 *     the shortest path that does; a link by path follows the new path
 *     (a leading '/' stays a leading '/');
 *   - a link that named no file stays as it was;
 *   - `.md` stays on a link that wrote it, and a canvas stays `Name.excalidraw`;
 *   - a markdown link `[](path)` / `![](path)` keeps its title, its #fragment,
 *     and its way of writing spaces (`<…>` or `%20`); a relative one is
 *     written relative to where the note is now, so a note that itself moved
 *     keeps pointing at what it pointed at.
 *
 * Text in a code fence or a code span is never touched, nor anything that is
 * not a link. Line ends and every other byte stay as they were.
 */
import { basename, dirname } from '../files/paths';
import type { FileEntry } from '../files/types';
import { mayHaveEmbeddedFiles, rewriteEmbeddedLinks } from '../nebula/excalidraw/embeddedFiles';
import { linkMatches, markdownPath, resolveLink, resolveMarkdownPath } from './views/note/links';

/** The project's files before and after a move, and where each moved file went. Built once per move, used for every note. */
export type LinkWorld = {
  before: FileEntry[];
  after: FileEntry[];
  /** Old path → new path, for each file that moved. */
  moved: ReadonlyMap<string, string>;
  afterPaths: ReadonlySet<string>;
};

const entry = (path: string): FileEntry => ({ path, name: basename(path), type: 'file' });

export function linkWorld(before: readonly string[], after: readonly string[], moved: ReadonlyMap<string, string>): LinkWorld {
  return { before: before.map(entry), after: after.map(entry), moved, afterPaths: new Set(after) };
}

export type LinkUpdate = { text: string; count: number };

/* ---- where links can be: not in code ------------------------------------ */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const BLANK = /^\s*$/;

/** The ranges of the text that are not inside a code fence or a code span. */
function proseRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let fence: string | null = null;
  let blockStart: number | null = null;
  let offset = 0;
  const closeBlock = (end: number) => {
    if (blockStart !== null) ranges.push(...withoutCodeSpans(text, blockStart, end));
    blockStart = null;
  };
  for (const line of text.split('\n')) {
    const lineEnd = offset + line.length;
    const marker = FENCE_OPEN.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.slice(line.indexOf(marker) + marker.length).trim() === '') fence = null;
    } else if (marker && !(marker[0] === '`' && line.slice(line.indexOf(marker) + marker.length).includes('`'))) {
      closeBlock(offset);
      fence = marker;
    } else if (BLANK.test(line)) {
      closeBlock(offset);
    } else if (blockStart === null) {
      blockStart = offset;
    }
    offset = lineEnd + 1;
  }
  closeBlock(text.length);
  return ranges;
}

/** [start, end) with the code spans cut out: a run of n backticks opens a span the next run of n closes. */
function withoutCodeSpans(text: string, start: number, end: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let last = start;
  const runAt = (at: number): number => {
    let n = 0;
    while (at + n < end && text[at + n] === '`') n += 1;
    return n;
  };
  let at = start;
  while (at < end) {
    if (text[at] !== '`' || text[at - 1] === '\\') {
      at += 1;
      continue;
    }
    const n = runAt(at);
    let close = -1;
    for (let scan = at + n; scan < end; ) {
      if (text[scan] !== '`') {
        scan += 1;
        continue;
      }
      const run = runAt(scan);
      if (run === n) {
        close = scan;
        break;
      }
      scan += run;
    }
    if (close < 0) {
      at += n;
      continue;
    }
    if (at > last) ranges.push([last, at]);
    last = close + n;
    at = last;
  }
  if (end > last) ranges.push([last, end]);
  return ranges;
}

/* ---- how a target is written -------------------------------------------- */

/** A file's name as a link writes it: a note without `.md`, a canvas without its `.md`, anything else whole; `keepMd` keeps what was written. */
function linkName(name: string, keepMd: boolean): string {
  if (keepMd) return name;
  return name.replace(/\.md$/i, '');
}

/** The target to write for `file`: the form the link had (bare, path, anchored), made to name that file alone. */
function targetFor(original: string, file: string, after: readonly FileEntry[]): string {
  const written = original.trim().replace(/\\/g, '/');
  const anchored = written.startsWith('/');
  const parts = (anchored ? written.slice(1) : written).split('/').filter(Boolean);
  const keepMd = /\.md$/i.test(parts[parts.length - 1] ?? '');
  const segments = file.split('/');
  const shown = (count: number): string => {
    const tail = segments.slice(segments.length - count);
    tail[tail.length - 1] = linkName(tail[tail.length - 1], keepMd);
    return tail.join('/');
  };
  if (anchored) return `/${shown(segments.length)}`;
  const first = parts.length <= 1 ? 1 : Math.min(parts.length, segments.length);
  for (let count = first; count <= segments.length; count += 1) {
    const candidate = shown(count);
    const matches = linkMatches(candidate, after);
    if (matches.length === 1 && matches[0].path === file) return candidate;
  }
  return `/${shown(segments.length)}`;
}

function relativePath(fromFolder: string, target: string): string {
  const from = fromFolder ? fromFolder.split('/') : [];
  const to = target.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common += 1;
  return [...Array<string>(from.length - common).fill('..'), ...to.slice(common)].join('/');
}

/* ---- the rewriting ------------------------------------------------------ */

// `[[target#heading|alias]]` and `![[…]]`, then `[text](dest "title")` and `![alt](dest)`
// (a link's text may hold one level of brackets: an image inside a link).
const LINKS = new RegExp(
  String.raw`(!?)\[\[([^\[\]\n]+?)\]\]|(!?\[(?:[^\[\]\\\n]|\\.|\[[^\[\]\n]*\])*\])\(([ \t]*)(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)([ \t]*(?:"[^"\n]*"|'[^'\n]*')?[ \t]*)\)`,
  'g',
);

type Context = { from: string; to: string; world: LinkWorld };

/** The inside of `[[ ]]` with its target changed, or null to leave it. */
function rewriteWikilink(raw: string, { from, to, world }: Context): string | null {
  const cut = raw.search(/[#|]/);
  let head = cut < 0 ? raw : raw.slice(0, cut);
  let rest = cut < 0 ? '' : raw.slice(cut);
  // In a table the bar is written \| : the slash belongs to the bar.
  if (rest.startsWith('|') && head.endsWith('\\')) {
    head = head.slice(0, -1);
    rest = `\\${rest}`;
  }
  const target = head.trim();
  if (!target) return null;
  const was = resolveLink(target, from, world.before);
  if (!was) return null;
  const now = world.moved.get(was.path) ?? was.path;
  if (!world.afterPaths.has(now)) return null;
  if (resolveLink(target, to, world.after)?.path === now) return null;
  const written = targetFor(target, now, world.after);
  const lead = /^\s*/.exec(head)?.[0] ?? '';
  const trail = /\s*$/.exec(head)?.[0] ?? '';
  return `${lead}${written}${trail}${rest}`;
}

/** The address of a markdown link rewritten, as it was written (wrapped, percent-encoded, with its fragment), or null to leave it. */
function rewriteAddress(dest: string, { from, to, world }: Context): string | null {
  const angle = dest.startsWith('<');
  const raw = angle ? dest.slice(1, -1) : dest;
  if (!raw || markdownPath(raw, from) === null) return null;
  const was = resolveMarkdownPath(raw, from, world.before);
  if (!was) return null;
  const now = world.moved.get(was.path) ?? was.path;
  if (!world.afterPaths.has(now)) return null;
  if (resolveMarkdownPath(raw, to, world.after)?.path === now) return null;
  const cut = raw.search(/[#?]/);
  const base = cut < 0 ? raw : raw.slice(0, cut);
  const suffix = cut < 0 ? '' : raw.slice(cut);
  const absolute = base.startsWith('/');
  let written = absolute ? `/${now}` : relativePath(dirname(to), now);
  if (!absolute && base.startsWith('./') && !written.startsWith('..')) written = `./${written}`;
  const percent = /%[0-9a-f]{2}/i.test(base);
  if (percent) written = written.split('/').map(encodeURIComponent).join('/');
  const text = written + suffix;
  return angle || (!percent && /[\s()<>]/.test(text)) ? `<${text}>` : text;
}

function rewrite(segment: string, context: Context, tally: { count: number }): string {
  return segment.replace(LINKS, (whole: string, bang: string | undefined, raw: string | undefined, label: string | undefined, space: string, dest: string, tail: string) => {
    if (raw !== undefined) {
      const next = rewriteWikilink(raw, context);
      if (next === null) return whole;
      tally.count += 1;
      return `${bang}[[${next}]]`;
    }
    const address = rewriteAddress(dest, context);
    // An image in a link's text is a link too.
    const inner = label!.slice(label!.indexOf('[') + 1, -1);
    const text = rewrite(inner, context, tally);
    const shown = text === inner ? label! : `${label!.slice(0, label!.indexOf('[') + 1)}${text}]`;
    if (address === null) return `${shown}(${space}${dest}${tail})`;
    tally.count += 1;
    return `${shown}(${space}${address}${tail})`;
  });
}

/** Whether the text could hold a link at all: the cheap look before the real one. */
export function mayHaveLinks(text: string): boolean {
  return text.includes('[[') || text.includes('](');
}

/**
 * A note's text with its links following the move. `from` and `to` are the
 * note's path before and after (the same when only other files moved).
 */
export function updateLinks(text: string, from: string, to: string, world: LinkWorld): LinkUpdate {
  if (!mayHaveLinks(text)) return { text, count: 0 };
  const context: Context = { from, to, world };
  const tally = { count: 0 };
  let out = '';
  let at = 0;
  for (const [start, end] of proseRanges(text)) {
    out += text.slice(at, start) + rewrite(text.slice(start, end), context, tally);
    at = end;
  }
  out += text.slice(at);
  return tally.count === 0 ? { text, count: 0 } : { text: out, count: tally.count };
}

/**
 * A canvas's text with the image references in its `## Embedded Files`
 * section following the move (2.0.4), by the same rules as a note's
 * `[[links]]`: a reference that still finds its file is left as written,
 * and one that wouldn't is rewritten in its own form (bare name, path,
 * alias). Only those lines change: the section is plain markdown even in a
 * compressed drawing, and the drawing itself (its text elements' links
 * included) is left byte for byte.
 */
export function updateCanvasLinks(text: string, from: string, to: string, world: LinkWorld): LinkUpdate {
  if (!mayHaveEmbeddedFiles(text)) return { text, count: 0 };
  const context: Context = { from, to, world };
  return rewriteEmbeddedLinks(text, (link) => rewriteWikilink(link, context));
}
