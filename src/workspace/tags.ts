import { EXTRAS } from './views/note/remarkNebula';

/**
 * A note's tags: inline `#tags` as the reading view draws them and
 * front matter's `tags:` / `tag:`. Lowercase, without the `#`, nested tags
 * keep their slashes (`project/nebula`), each once, in the order first
 * written (front matter comes first because it's written first).
 *
 * The project index calls this for every note when a project opens, so it's
 * one pass over the lines with a cheap skip for lines that can't hold a tag,
 * and no dependencies (this file is in the shell's first load).
 *
 * The tag rule is the page's own (remarkNebula's EXTRAS, which is
 * markdown.ts's INLINE_TAG): a `#` at the start of a line or after a space,
 * then letters, digits, `_`, `-` and `/`, at least one of them a letter. So
 * `#123` isn't a tag, a heading's `# ` isn't, and neither is the fragment of
 * an address (`page#top`). On top of that, tags aren't looked for where the
 * page doesn't draw them: fenced and indented code, inline code, HTML
 * comments, the front matter's own lines, and the inside of a `[[wikilink]]`.
 */

const TAG_NAME = /^[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*$/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_START = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/;
const ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const OPENING = /^\uFEFF?---[ \t]*$/;
const CLOSING = /^(?:---|\.\.\.)[ \t]*$/;
const INLINE_CODE = /(`+)[^`]*?\1(?!`)/g;
const KEY = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/;
/** A front matter that never closes isn't one; this many lines is already a long one. */
const FRONTMATTER_LINES = 500;

const blank = (match: string) => ' '.repeat(match.length);

function normalise(raw: string): string | null {
  let tag = raw.trim();
  if (tag.length >= 2 && (tag[0] === '"' || tag[0] === "'") && tag.at(-1) === tag[0]) tag = tag.slice(1, -1).trim();
  if (tag.startsWith('#')) tag = tag.slice(1);
  return TAG_NAME.test(tag) ? tag.toLowerCase() : null;
}

/** Splits a front matter value into tags; `commasOnly` for list items, where a space is part of a (then invalid) name. */
function valueTags(value: string, commasOnly: boolean): string[] {
  const found: string[] = [];
  for (const part of value.split(commasOnly ? /,/ : /[\s,]+/)) {
    const tag = normalise(part);
    if (tag) found.push(tag);
  }
  return found;
}

/**
 * The tags a front matter block holds, from its lines: `tags:` as a list
 * (`- a`), an inline list (`[a, b]`, even over several lines) or a comma or
 * space separated string, and `tag:` the same. A small reader for those
 * shapes, not YAML.
 */
function frontMatterTags(lines: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const pair = KEY.exec(lines[i]);
    const key = pair?.[1].toLowerCase();
    if (!pair || (key !== 'tags' && key !== 'tag')) continue;
    const value = pair[2].trim();
    if (value === '') {
      // A block list: the lines that follow, up to the next key.
      for (let j = i + 1; j < lines.length; j += 1) {
        const item = /^[ \t]*-[ \t]+(.*)$/.exec(lines[j]);
        if (item) found.push(...valueTags(item[1], true));
        else if (lines[j].trim() !== '' && !/^[ \t]/.test(lines[j])) break;
      }
    } else if (value.startsWith('[')) {
      let flow = value;
      for (let j = i + 1; !flow.includes(']') && j < lines.length && j <= i + 20; j += 1) flow += ` ${lines[j].trim()}`;
      const close = flow.indexOf(']');
      found.push(...valueTags(flow.slice(1, close === -1 ? undefined : close), true));
    } else {
      found.push(...valueTags(value, false));
    }
  }
  return found;
}

/** Where the body starts (after the front matter's closing line, else 0), and the tags the front matter holds. */
function frontMatter(markdown: string): { start: number; tags: string[] } {
  const first = markdown.indexOf('\n');
  if (first === -1 || !OPENING.test(markdown.slice(0, first).replace(/\r$/, ''))) return { start: 0, tags: [] };
  const lines: string[] = [];
  let at = first + 1;
  while (at <= markdown.length && lines.length <= FRONTMATTER_LINES) {
    const next = markdown.indexOf('\n', at);
    const line = markdown.slice(at, next === -1 ? undefined : next).replace(/\r$/, '');
    if (CLOSING.test(line)) return { start: next === -1 ? markdown.length : next + 1, tags: frontMatterTags(lines) };
    lines.push(line);
    if (next === -1) break;
    at = next + 1;
  }
  return { start: 0, tags: [] };
}

/** A line with what can't hold a tag blanked out, and the marks the page reads through turned into spaces. */
function scannable(line: string): string {
  return line
    .replace(INLINE_CODE, blank)
    .replace(/^[ \t]*(?:>[ \t]?)+/, blank)
    // `**#idea**`: the page draws a tag whose text starts right after an emphasis mark.
    .replace(/[*~]+(?=#)/g, blank);
}

export function extractTags(markdown: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  const add = (tag: string) => {
    if (seen.has(tag)) return;
    seen.add(tag);
    tags.push(tag);
  };

  const front = frontMatter(markdown);
  front.tags.forEach(add);

  const pattern = new RegExp(EXTRAS.source, 'gu');
  let fence: string | null = null;
  let comment = false;
  // Whether an indented line here would start a code block (after a blank
  // line, a heading, a fence or another indented line), whether we're in a
  // list (whose indented lines are its own), and whether this line is code.
  let codeMayStart = true;
  let inList = false;
  let indentedCode = false;

  for (let at = front.start; at <= markdown.length; ) {
    const next = markdown.indexOf('\n', at);
    let line = markdown.slice(at, next === -1 ? undefined : next);
    at = next === -1 ? markdown.length + 1 : next + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);

    if (fence) {
      const close = FENCE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && line.trim() === close[1]) {
        fence = null;
        codeMayStart = true;
      }
      continue;
    }
    if (comment) {
      const end = line.indexOf('-->');
      if (end === -1) continue;
      comment = false;
      line = blank(line.slice(0, end + 3)) + line.slice(end + 3);
    }

    const open = FENCE.exec(line);
    if (open && !(open[1][0] === '`' && line.indexOf('`', open[0].length) !== -1)) {
      fence = open[1];
      continue;
    }

    if (line.trim() === '') {
      codeMayStart = true;
      indentedCode = false;
      continue;
    }

    const indent = /^[ \t]*/.exec(line)![0].replace(/\t/g, '    ').length;
    indentedCode = indent >= 4 && !inList && (codeMayStart || indentedCode);
    if (indentedCode) continue;
    if (LIST_START.test(line)) inList = true;
    else if (indent < 2 && codeMayStart) inList = false;
    codeMayStart = ATX.test(line);

    if (!line.includes('#')) {
      if (line.lastIndexOf('<!--') > line.lastIndexOf('-->')) comment = true;
      continue;
    }

    // A comment that closes on this line is blanked; one that doesn't runs on to a later line.
    line = line.replace(/<!--[\s\S]*?-->/g, blank);
    const opens = line.lastIndexOf('<!--');
    if (opens !== -1) {
      comment = true;
      line = line.slice(0, opens);
    }

    for (const match of scannable(line).matchAll(pattern)) {
      // Groups 1 and 2 are a wikilink or an embed: consumed, so a `#` inside one isn't a tag.
      if (match[4] !== undefined) add(match[4].toLowerCase());
    }
  }
  return tags;
}

/** A tag and everything under it: `project` holds `project/nebula` and `project/orbit`. */
export type TagNode = {
  /** This level's own name (`nebula`). */
  name: string;
  /** The whole tag (`project/nebula`), which is what a search is for. */
  tag: string;
  /** The files that carry this tag or any tag under it. */
  files: Set<string>;
  children: TagNode[];
};

/**
 * The project's tags (the index's `tags()`) as a tree on their slashes, each
 * level in name order. A parent that no note carries by itself (`project`
 * when only `project/nebula` is written) is still there, counting its children's files.
 */
export function tagTree(tags: ReadonlyMap<string, readonly string[]>): TagNode[] {
  const roots: TagNode[] = [];
  const byTag = new Map<string, TagNode>();
  for (const [tag, paths] of tags) {
    let level = roots;
    let whole = '';
    for (const name of tag.split('/').filter(Boolean)) {
      whole = whole ? `${whole}/${name}` : name;
      let node = byTag.get(whole);
      if (!node) {
        node = { name, tag: whole, files: new Set(), children: [] };
        byTag.set(whole, node);
        level.push(node);
      }
      for (const path of paths) node.files.add(path);
      level = node.children;
    }
  }
  const sort = (nodes: TagNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}
