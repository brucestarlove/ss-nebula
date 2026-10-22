/**
 * Plain-text helpers for notes: frontmatter, tags, words and task toggling.
 * They work on the source text, so what the page shows and what the file
 * says can never drift apart.
 */

export type FrontmatterValue = string | string[];

export type Frontmatter = {
  /** The frontmatter's top-level scalars and lists (a small YAML subset). */
  data: Record<string, FrontmatterValue>;
  /** The note without its frontmatter. */
  body: string;
  /** Where the body starts in the source: body === source.slice(bodyOffset). */
  bodyOffset: number;
};

const OPENING = /^\uFEFF?---[ \t]*\r?\n/;
const CLOSING = /^(?:---|\.\.\.)[ \t]*$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function flowList(value: string): string[] {
  return value
    .slice(1, -1)
    .split(',')
    .map(unquote)
    .filter(Boolean);
}

function parseYamlSubset(lines: string[]): Record<string, FrontmatterValue> {
  const data: Record<string, FrontmatterValue> = {};
  let listKey: string | null = null;
  for (const line of lines) {
    const pair = /^([A-Za-z0-9_][^:]*):(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (pair) {
      const key = pair[1].trim();
      const value = (pair[2] ?? '').trim();
      listKey = null;
      if (value === '') {
        data[key] = [];
        listKey = key;
      } else if (value.startsWith('[') && value.endsWith(']')) {
        data[key] = flowList(value);
      } else {
        data[key] = unquote(value);
      }
      continue;
    }
    const item = /^[ \t]+-[ \t]*(.*)$/.exec(line) ?? /^-[ \t]+(.*)$/.exec(line);
    if (item && listKey) {
      const list = data[listKey];
      if (Array.isArray(list)) list.push(unquote(item[1]));
    }
  }
  return data;
}

/** Splits YAML frontmatter (a `---` fenced block at the very top) from the body. */
export function parseFrontmatter(source: string): Frontmatter {
  const opening = OPENING.exec(source);
  if (!opening) return { data: {}, body: source, bodyOffset: 0 };

  let cursor = opening[0].length;
  const lines: string[] = [];
  while (cursor <= source.length) {
    const newline = source.indexOf('\n', cursor);
    const end = newline === -1 ? source.length : newline;
    const line = source.slice(cursor, end).replace(/\r$/, '');
    if (CLOSING.test(line)) {
      const bodyOffset = newline === -1 ? source.length : newline + 1;
      return { data: parseYamlSubset(lines), body: source.slice(bodyOffset), bodyOffset };
    }
    lines.push(line);
    if (newline === -1) break;
    cursor = newline + 1;
  }
  return { data: {}, body: source, bodyOffset: 0 };
}

function frontmatterTags(data: Record<string, FrontmatterValue>): string[] {
  const value = data.tags ?? data.tag;
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : value.split(/[\s,]+/);
  return raw.map((tag) => tag.trim().replace(/^#/, '')).filter(Boolean);
}

/** Blanks out fenced code, inline code and HTML comments, keeping offsets. */
export function withoutCode(body: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, ' ');
  return body
    .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*|$)/gm, blank)
    .replace(/(`+)[^`\n]*?\1/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
}

/** Obsidian's tag shape: letters, digits, _ - and /, not only digits, after a
 * space or at the start of a line. */
export const INLINE_TAG = /(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

function inlineTags(body: string): string[] {
  const tags: string[] = [];
  for (const match of withoutCode(body).matchAll(INLINE_TAG)) tags.push(match[2]);
  return tags;
}

/** The note's tags: frontmatter `tags` (or `tag`) first, then inline #tags,
 * without the #, each once (case-insensitively). */
export function noteTags(source: string): string[] {
  const { data, body } = parseFrontmatter(source);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const tag of [...frontmatterTags(data), ...inlineTags(body)]) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

const LIST_MARKER = /^([ \t]*(?:>[ \t]*)*)(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm;

/** Words in the body: runs of non-space that hold a letter or a digit, so list
 * bullets, task boxes and dashes don't count. */
export function countWords(source: string): number {
  const { body } = parseFrontmatter(source);
  const text = body.replace(LIST_MARKER, '$1');
  let count = 0;
  for (const token of text.split(/\s+/)) {
    if (/[\p{L}\p{N}]/u.test(token)) count += 1;
  }
  return count;
}

const TASK_AT = /^(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\]/;

/** Ticks or unticks the task whose list item starts at `offset` (the item's
 * bullet, as markdown positions report it). Null when no task starts there. */
export function toggleTaskAt(source: string, offset: number): string | null {
  if (offset < 0 || offset >= source.length) return null;
  const match = TASK_AT.exec(source.slice(offset));
  if (!match) return null;
  const box = offset + match[0].length - 2;
  const next = match[1] === ' ' ? 'x' : ' ';
  return source.slice(0, box) + next + source.slice(box + 1);
}
