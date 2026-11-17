/**
 * The project index's pure parts: what a note or a canvas holds
 * for search and for "Linked from", how its links resolve against the
 * project's files, and the search itself. No React, no store and nothing
 * heavy: the workspace's first load carries this file, and a canvas's words
 * are read by indexCanvas.ts, loaded only when a project has a canvas.
 * useProjectIndexBuild.ts reads the files and keeps the index current.
 */
import type { FileEntry } from '../files/types';
import { basename, comparePaths } from '../files/paths';
import { extractOutline, type Heading } from './outline';
import { describeName } from './paths';
import type { IndexedDoc, IndexedLink, ProjectIndex, SearchHit, SearchRange } from './projectIndex';
import { extractTags } from './tags';
import { markdownPath, parseWikilink, resolveLink, resolveMarkdownPath, wikilinkLabel } from './views/note/links';
import { parseFrontmatter, withoutCode } from './views/note/markdown';
import { wikilinkText } from './views/note/remarkNebula';

/**
 * Above this many characters a note is indexed by its name, headings, tags
 * and links, without its text: search finds it by name and heading only. The
 * same limit at which NoteView opens a note as its source; such a note is
 * rare, and holding a few megabytes of it twice (the text and its folded
 * copy) for search isn't worth it.
 */
export const INDEX_TEXT_LIMIT = 200_000;

/* ---- folding: case and accents ------------------------------------- */

/** Anything but printable ASCII, tabs and line breaks. */
const NOT_ASCII = /[^\t\n\r -~]/;
const MARKS = /\p{M}/gu;
const folds = new Map<string, string>();

/**
 * Text lowercased and without accents ('Éclair' → 'eclair'), the same
 * length as it was, so a place found in the folded copy is the same place
 * in the text. A character that would change length when folded (a
 * decomposed accent, a Hangul syllable) is only lowercased, or kept.
 */
export function fold(text: string): string {
  if (!NOT_ASCII.test(text)) return text.toLowerCase();
  let out = '';
  for (const char of text) {
    if (char.charCodeAt(0) < 128) {
      out += char.toLowerCase();
      continue;
    }
    let folded = folds.get(char);
    if (folded === undefined) {
      const lower = char.toLowerCase();
      const bare = lower.normalize('NFD').replace(MARKS, '');
      folded = bare.length === char.length ? bare : lower.length === char.length ? lower : char;
      folds.set(char, folded);
    }
    out += folded;
  }
  return out;
}

/* ---- links, as written ------------------------------------------- */

/** A link as written in a file, before it's resolved against the project's files. */
export type WrittenLink = {
  /** `[[ ]]` (resolved by name, as links.ts does) or `[text](path)` (by path). */
  form: 'wiki' | 'markdown';
  /** IndexedLink's target: the name between the brackets, or the address without its `#` or `?`. */
  target: string;
  /** The address as written, for a markdown link (markdownPath reads it). */
  address?: string;
  heading?: string;
  embed: boolean;
  line?: number;
  context: string;
  contextRange?: SearchRange;
};

const WIKI = /(!?)\[\[([^[\]\n]+?)\]\]/g;
// `[text](address "title")` and `![alt](address)`: the text may hold one
// level of brackets, the address one level of parentheses or be in `< >`.
const MARKDOWN_LINK = /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;
const WEB = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** A heading or block marker at the start of a line, a list's bullet and its task box. */
const LEAD = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;
const INLINE = /(!?)\[\[([^[\]\n]+?)\]\]|(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(([^)\n]*)\)/g;

function plainRun(text: string): string {
  return text.replace(/\*\*|__|~~|==|`/g, '');
}

/** What a markdown link shows: its text, else the last part of its address. */
function markdownLabel(text: string, address: string): string {
  if (text.trim()) return plainRun(text.trim());
  const last = address.trim().replace(/^<|>$/g, '').split(/[?#]/)[0].split('/').pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * A line as a reader sees it: its heading or list marker gone, links shown
 * as their words (`[[Orion|the nebula]]` → 'the nebula'), and bold, code and
 * strike marks dropped. With `mark`, the start column of a link in the line,
 * `range` says where that link's words are in the result.
 */
export function displayLine(line: string, mark?: number): { text: string; range?: SearchRange } {
  const lead = LEAD.exec(line)?.[0].length ?? 0;
  let out = '';
  let at = lead;
  let range: SearchRange | undefined;
  for (const match of line.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start < at) continue;
    out += plainRun(line.slice(at, start));
    // An embed's `|300` is its size, not words: its name stands for it.
    const label = match[2] !== undefined ? (match[1] ? wikilinkLabel(parseWikilink(match[2], true)) : wikilinkText(match[2])) : markdownLabel(match[4] ?? '', match[5] ?? '');
    if (mark === start) range = [out.length, out.length + label.length];
    out += label;
    at = start + match[0].length;
  }
  out += plainRun(line.slice(at));
  const text = out.replace(/\s+$/, '');
  if (range && range[1] > text.length) range = [Math.min(range[0], text.length), text.length];
  return { text, range };
}

const CONTEXT_CHARS = 140;

/** Text cut to about `max` characters around `range`, with an ellipsis where it was cut. */
export function clip(text: string, range: SearchRange | undefined, max = CONTEXT_CHARS): { text: string; shift: number } {
  if (text.length <= max) return { text, shift: 0 };
  let start = range ? Math.max(0, range[0] - Math.floor(max / 3)) : 0;
  if (start > 0) {
    // Start at a word where one is near.
    const space = text.indexOf(' ', start);
    if (space !== -1 && space - start < 16 && (!range || space < range[0])) start = space + 1;
    while (start < text.length && /\s/.test(text[start]) && (!range || start < range[0])) start += 1;
  }
  const end = Math.min(text.length, start + max);
  const head = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  return { text: `${head}${text.slice(start, end).trimEnd()}${tail}`, shift: head.length - start };
}

/** How much of a long line around a link is read for its context: a few times what's shown. */
const CONTEXT_WINDOW = 600;

/**
 * A link's context: its line as a reader sees it, cut around the link. A long
 * line is first cut to a window around the link (at spaces), so a note of one
 * 200,000-character line with 8,000 links costs 8,000 small windows, not
 * 8,000 readings of the whole line (which held the page for a minute).
 */
function linkContext(full: string, at: number): { context: string; contextRange?: SearchRange } {
  let line = full;
  let column = at;
  if (full.length > CONTEXT_WINDOW * 2) {
    let start = Math.max(0, at - CONTEXT_WINDOW);
    if (start > 0) {
      const space = full.indexOf(' ', start);
      if (space !== -1 && space < at) start = space + 1;
    }
    let end = Math.min(full.length, at + CONTEXT_WINDOW);
    if (end < full.length) {
      const space = full.lastIndexOf(' ', end);
      if (space > at) end = space;
    }
    line = full.slice(start, end);
    column = at - start;
  }
  const shown = displayLine(line, column);
  const { text, shift } = clip(shown.text, shown.range);
  if (!shown.range) return { context: text };
  const start = Math.max(0, shown.range[0] + shift);
  const end = Math.min(text.length, shown.range[1] + shift);
  return end > start ? { context: text, contextRange: [start, end] } : { context: text };
}

/**
 * Every link a note writes: `[[ ]]` and `![[ ]]`, and `[text](path)` and
 * `![alt](path)` to a place in the project (web addresses aren't links
 * between files). Front matter, fenced and inline code are passed over, as
 * the reading view passes them over.
 */
export function noteLinks(markdown: string): WrittenLink[] {
  const { bodyOffset } = parseFrontmatter(markdown);
  const masked = markdown.slice(0, bodyOffset).replace(/[^\n]/g, ' ') + withoutCode(markdown.slice(bodyOffset));
  const links: WrittenLink[] = [];
  let lineStart = 0;
  for (let line = 0; lineStart <= masked.length; line += 1) {
    const newline = masked.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? masked.length : newline;
    const text = masked.slice(lineStart, lineEnd);
    if (text.includes('[')) {
      const source = markdown.slice(lineStart, lineEnd).replace(/\r$/, '');
      for (const match of text.matchAll(WIKI)) {
        const parsed = parseWikilink(match[2], match[1] === '!');
        links.push({
          form: 'wiki',
          target: parsed.target,
          heading: parsed.heading ?? undefined,
          embed: parsed.embed,
          line,
          ...linkContext(source, match.index ?? 0),
        });
      }
      for (const match of text.matchAll(MARKDOWN_LINK)) {
        const address = match[3].replace(/^<|>$/g, '');
        if (!address || WEB.test(address) || address.startsWith('#')) continue;
        const [beforeHash, hash] = address.split('#', 2);
        let heading: string | undefined;
        if (hash) {
          try {
            heading = decodeURIComponent(hash);
          } catch {
            heading = hash;
          }
        }
        links.push({
          form: 'markdown',
          target: beforeHash.split('?')[0],
          address,
          heading,
          embed: match[1] === '!',
          line,
          ...linkContext(source, match.index ?? 0),
        });
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return links;
}

/** The `[[ ]]` links written in one line of a canvas's text (or an element's own link). */
export function canvasLinks(text: string, context: string): WrittenLink[] {
  const links: WrittenLink[] = [];
  for (const match of text.matchAll(WIKI)) {
    const parsed = parseWikilink(match[2], match[1] === '!');
    const at = context.indexOf(match[0]);
    links.push({
      form: 'wiki',
      target: parsed.target,
      heading: parsed.heading ?? undefined,
      embed: parsed.embed,
      ...(at === -1 ? { context: clip(displayLine(context).text, undefined).text } : linkContext(context, at)),
    });
  }
  return links;
}

/* ---- records ------------------------------------------------------ */

/** One file in the index: what the contract shows of it, and what search needs. */
export type IndexRecord = {
  doc: IndexedDoc;
  /** The file's title, as the tree shows it. */
  name: string;
  /** `name`, folded. */
  title: string;
  /** `doc.text`, folded: the same length, so places line up. */
  folded: string;
  /** Its headings' text, folded, one per line: how a long note is searched. */
  headingText: string;
  /** Its tags, folded. */
  tagKeys: string[];
  written: WrittenLink[];
  /** The link resolver's generation `doc.links` were resolved with (-1: not yet). */
  resolvedWith: number;
};

/** The file's name as quick open and the tree show it: a note or a canvas without its extension. */
export function titleOf(path: string): string {
  return describeName(basename(path)).label;
}

function makeRecord(path: string, kind: IndexedDoc['kind'], text: string, headings: Heading[], tags: string[], written: WrittenLink[]): IndexRecord {
  return {
    doc: { path, kind, text, headings, tags, links: [] },
    name: titleOf(path),
    title: fold(titleOf(path)),
    folded: fold(text),
    headingText: fold(headings.map((heading) => heading.text).join('\n')),
    tagKeys: tags.map((tag) => fold(tag.replace(/^#/, ''))),
    written,
    resolvedWith: -1,
  };
}

/** A note's record. A note longer than INDEX_TEXT_LIMIT keeps no text. */
export function noteRecord(path: string, markdown: string): IndexRecord {
  const text = markdown.length > INDEX_TEXT_LIMIT ? '' : markdown;
  return makeRecord(path, 'note', text, extractOutline(markdown), extractTags(markdown), noteLinks(markdown));
}

/** A canvas's record: its text elements' words, one element per line, and the links in them. */
export function canvasRecord(path: string, lines: string[], written: WrittenLink[]): IndexRecord {
  return makeRecord(path, 'canvas', lines.join('\n'), [], [], written);
}

/** The same file under a new path (a rename): the links resolve again from there. */
export function movedRecord(record: IndexRecord, path: string): IndexRecord {
  const doc = { ...record.doc, path, links: [] };
  return { ...record, doc, name: titleOf(path), title: fold(titleOf(path)), resolvedWith: -1 };
}

/* ---- resolving links ------------------------------------------------ */

/**
 * Resolves links the way links.ts does, without walking every file for each
 * link: files are looked up by name (a `[[link]]`'s last part) and by path (a
 * markdown link's), and only those few go to resolveLink or
 * resolveMarkdownPath, which break the ties exactly as the reading view does.
 */
export class LinkResolver {
  private readonly byName = new Map<string, FileEntry[]>();
  private readonly byPath = new Map<string, FileEntry[]>();

  constructor(files: readonly FileEntry[]) {
    for (const entry of files) {
      if (entry.type !== 'file') continue;
      const name = entry.name.toLowerCase();
      const path = entry.path.toLowerCase();
      const named = this.byName.get(name);
      if (named) named.push(entry);
      else this.byName.set(name, [entry]);
      const at = this.byPath.get(path);
      if (at) at.push(entry);
      else this.byPath.set(path, [entry]);
    }
  }

  resolve(link: WrittenLink, from: string): string | null {
    if (link.form === 'wiki') {
      // `[[#Heading]]`: a place in the file itself.
      if (!link.target) return from;
      const last = (link.target.trim().replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase();
      if (!last) return null;
      const candidates = [...(this.byName.get(last) ?? []), ...(this.byName.get(`${last}.md`) ?? [])];
      return candidates.length > 0 ? (resolveLink(link.target, from, candidates)?.path ?? null) : null;
    }
    const address = link.address ?? link.target;
    const path = markdownPath(address, from);
    const candidates = path ? this.byPath.get(path.toLowerCase()) : undefined;
    return candidates ? (resolveMarkdownPath(address, from, candidates)?.path ?? null) : null;
  }
}

/** The record's links resolved now; the same doc when nothing changed. */
export function resolveRecord(record: IndexRecord, resolver: LinkResolver, generation: number): IndexRecord {
  if (record.resolvedWith === generation) return record;
  const from = record.doc.path;
  const before = record.doc.links;
  let changed = before.length !== record.written.length;
  const links: IndexedLink[] = record.written.map((written, index) => {
    const resolved = resolver.resolve(written, from);
    const link: IndexedLink = { from, target: written.target, resolved, embed: written.embed, context: written.context };
    if (written.heading !== undefined) link.heading = written.heading;
    if (written.line !== undefined) link.line = written.line;
    if (written.contextRange) link.contextRange = written.contextRange;
    const old = before[index];
    if (!old || old.resolved !== resolved || old.from !== from) changed = true;
    return link;
  });
  return { ...record, doc: changed ? { ...record.doc, links } : record.doc, resolvedWith: generation };
}

/* ---- search ------------------------------------------------------- */

type Query = { words: string[]; tags: string[] };

/** A query's words, folded; `#tag` words are tags. */
export function parseQuery(query: string): Query {
  const words: string[] = [];
  const tags: string[] = [];
  for (const part of fold(query).split(/\s+/)) {
    if (!part) continue;
    if (part.startsWith('#')) {
      const tag = part.replace(/^#+/, '');
      if (tag) tags.push(tag);
    } else if (!words.includes(part)) words.push(part);
  }
  return { words, tags };
}

/** How well a file's tags answer a `#tag`: 0 the tag or one nested under it, 1 a tag that starts with it, null none. */
function tagTier(keys: string[], wanted: string): number | null {
  let best: number | null = null;
  for (const key of keys) {
    if (key === wanted || key.startsWith(`${wanted}/`)) return 0;
    if (key.startsWith(wanted)) best = 1;
  }
  return best;
}

/** The ranges of every word in `text` (folded here), at most a few dozen. */
export function wordRanges(text: string, words: string[]): SearchRange[] {
  const folded = fold(text);
  const ranges: SearchRange[] = [];
  for (const word of words) {
    let at = folded.indexOf(word);
    while (at !== -1 && ranges.length < 40) {
      ranges.push([at, at + word.length]);
      at = folded.indexOf(word, at + word.length);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** The text's lines, as [start, end) pairs, read lazily. */
function* lines(text: string): Generator<[number, number, number]> {
  let start = 0;
  for (let line = 0; ; line += 1) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    yield [line, start, end];
    if (newline === -1) return;
    start = newline + 1;
  }
}

/** The line holding the most of the words (the first of equals), or null when none has any. */
function bestLine(record: IndexRecord, words: string[]): { line: number; text: string } | null {
  let best: { line: number; start: number; end: number; score: number } | null = null;
  const { folded } = record;
  for (const [line, start, end] of lines(folded)) {
    if (end === start) continue;
    const slice = folded.slice(start, end);
    let score = 0;
    for (const word of words) if (slice.includes(word)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { line, start, end, score };
    if (best && best.score === words.length) break;
  }
  if (!best) return null;
  return { line: best.line, text: record.doc.text.slice(best.start, best.end) };
}

function snippetOf(line: string, words: string[]): { snippet: string; ranges: SearchRange[] } {
  const shown = displayLine(line).text;
  const ranges = wordRanges(shown, words);
  const { text, shift } = clip(shown, ranges[0]);
  const kept = ranges
    .map(([start, end]): SearchRange => [start + shift, end + shift])
    .filter(([start, end]) => start >= 0 && end <= text.length && end > start);
  return { snippet: text, ranges: kept };
}

function hitFor(record: IndexRecord, query: Query): SearchHit {
  const { path, kind, text } = record.doc;
  // The words mark the snippet; a query of tags alone marks the `#tag` where it's written.
  let marks = query.words.length > 0 ? query.words : query.tags.map((tag) => `#${tag}`);
  let found = text ? bestLine(record, marks) : null;
  if (!found && query.words.length === 0 && text) {
    // A tag from front matter: the line that names it.
    marks = query.tags;
    found = bestLine(record, marks);
  }
  if (found) return { path, kind, line: found.line, ...snippetOf(found.text, marks) };
  // A long note keeps no text: the heading that holds the words, if one does.
  const heading = record.doc.headings.find((item) => marks.some((word) => fold(item.text).includes(word)));
  if (heading) return { path, kind, ...snippetOf(heading.text, marks) };
  // The words are only in its name.
  return { path, kind, snippet: '', ranges: [] };
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/**
 * Every file holding every word of the query (in its name or its text; the
 * words may be on different lines), and with every `#tag` asked for, best
 * first: files whose name holds the words, then those whose headings do,
 * then the rest; within each, by name. Cheap enough for each keystroke over
 * thousands of notes: one indexOf a word in each file's folded text, and
 * lines read only for the hits returned.
 */
export function searchRecords(records: readonly IndexRecord[], text: string, limit = 50): SearchHit[] {
  const query = parseQuery(text);
  if (query.words.length === 0 && query.tags.length === 0) return [];
  const found: { record: IndexRecord; rank: number }[] = [];
  for (const record of records) {
    let rank = 0;
    let missing = false;
    for (const tag of query.tags) {
      const tier = tagTier(record.tagKeys, tag);
      if (tier === null) {
        missing = true;
        break;
      }
      rank = Math.max(rank, tier * 3);
    }
    if (missing) continue;
    if (query.words.length > 0) {
      let inTitle = true;
      let inHeadings = true;
      for (const word of query.words) {
        const title = record.title.includes(word);
        const heading = record.headingText.includes(word);
        if (!title && !heading && !record.folded.includes(word)) {
          missing = true;
          break;
        }
        inTitle &&= title;
        inHeadings &&= heading;
      }
      if (missing) continue;
      rank += inTitle ? 0 : inHeadings ? 1 : 2;
    }
    found.push({ record, rank });
  }
  found.sort((a, b) => a.rank - b.rank || collator.compare(a.record.name, b.record.name) || comparePaths(a.record.doc.path, b.record.doc.path));
  return found.slice(0, limit).map(({ record }) => hitFor(record, query));
}

/** Whether the folded text names `title` as whole words. */
function namesAt(folded: string, title: string, at: number): boolean {
  const before = at > 0 ? folded[at - 1] : ' ';
  const after = folded[at + title.length] ?? ' ';
  return !/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after);
}

/**
 * Files whose text names `path`'s title, as whole words, without a link to
 * it: "Not linked yet". The first line naming it in each, by path.
 */
export function mentionRecords(records: readonly IndexRecord[], path: string, limit = 20): SearchHit[] {
  const title = fold(titleOf(path)).trim();
  if (title.length < 3) return [];
  const hits: SearchHit[] = [];
  const sorted = [...records].sort((a, b) => comparePaths(a.doc.path, b.doc.path));
  for (const record of sorted) {
    if (record.doc.path === path || record.doc.links.some((link) => link.resolved === path)) continue;
    const { folded } = record;
    let at = folded.indexOf(title);
    while (at !== -1 && !namesAt(folded, title, at)) at = folded.indexOf(title, at + 1);
    if (at === -1) continue;
    const lineStart = folded.lastIndexOf('\n', at) + 1;
    const lineEnd = folded.indexOf('\n', at);
    const line = record.doc.text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    let lineNumber = 0;
    for (let index = folded.indexOf('\n'); index !== -1 && index < at; index = folded.indexOf('\n', index + 1)) lineNumber += 1;
    hits.push({ path: record.doc.path, kind: record.doc.kind, line: lineNumber, ...snippetOf(line, [title]) });
    if (hits.length >= limit) break;
  }
  return hits;
}

/* ---- the index ------------------------------------------------------ */

/** An index over these records, as they are now (their links already resolved). */
export function makeIndex(records: readonly IndexRecord[], ready: boolean): ProjectIndex {
  const docs = new Map<string, IndexedDoc>();
  for (const record of records) docs.set(record.doc.path, record.doc);
  let incoming: Map<string, IndexedLink[]> | null = null;
  let tagMap: Map<string, string[]> | null = null;

  return {
    ready,
    docs,
    backlinks(path) {
      if (!incoming) {
        incoming = new Map();
        for (const doc of docs.values()) {
          for (const link of doc.links) {
            if (!link.resolved || link.resolved === doc.path) continue;
            const list = incoming.get(link.resolved);
            if (list) list.push(link);
            else incoming.set(link.resolved, [link]);
          }
        }
        for (const list of incoming.values()) list.sort((a, b) => comparePaths(a.from, b.from) || (a.line ?? 0) - (b.line ?? 0));
      }
      return incoming.get(path) ?? [];
    },
    tags() {
      if (!tagMap) {
        const collected = new Map<string, string[]>();
        for (const doc of docs.values()) {
          for (const tag of new Set(doc.tags)) {
            const list = collected.get(tag);
            if (list) list.push(doc.path);
            else collected.set(tag, [doc.path]);
          }
        }
        tagMap = new Map([...collected.entries()].sort(([a], [b]) => collator.compare(a, b) || (a < b ? -1 : 1)));
        for (const list of tagMap.values()) list.sort(comparePaths);
      }
      return tagMap;
    },
    search(query, limit) {
      return searchRecords(records, query, limit);
    },
    mentions(path, limit) {
      return mentionRecords(records, path, limit);
    },
  };
}
