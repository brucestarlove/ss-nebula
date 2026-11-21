/**
 * The `## Embedded Files` section of an Obsidian Excalidraw drawing: where
 * the plugin keeps a canvas's images as references to files beside it,
 * one line each, `<file id>: [[<link>]]`. Pure text work, with no lz-string
 * and no Excalidraw, so the link updater and the index can read it without
 * loading the canvas's code.
 *
 * The plugin's own lines (ExcalidrawData, 2.x) take these forms, and each
 * is kept as written:
 *
 *   - `<id>: [[Garden photo 01.png]]`, the shortest name that finds the file
 *     in the vault, or a path when the name alone is ambiguous
 *     (`[[Photos/Garden photo 01.png]]`);
 *   - `[[…|…]]` and `[[…#…]]`: an alias, an embed size, a PDF's page, after
 *     the target;
 *   - ` {"#000":"#fff"}` after the brackets: an SVG's colour map;
 *   - `<id>: https://…` and `<id>: $$…$$`: a link and an equation, which aren't
 *     files at all.
 *
 * Only `[[…]]` lines are file references here; every other line is left
 * byte for byte. The plugin writes a blank line after each entry; a section
 * written without them stays that way.
 */

/** One `<id>: [[link]]` line in the section. */
export type EmbeddedFile = {
  /** Excalidraw's file id, which the image elements name as `fileId`. */
  id: string;
  /** What's between the brackets, alias and all. */
  link: string;
  /** The file it names: the link before any `#` or `|`, trimmed. */
  target: string;
  /** Where the link (inside the brackets) is in the text. */
  linkStart: number;
  linkEnd: number;
};

const DATA_RE = /(^|\n)(?:%%[ \t]*\r?\n)?# Excalidraw Data[ \t]*\r?(?=\n|$)/;
const HEADING_RE = /(^|\n)#{1,2} Embedded Files[ \t]*\r?\n/i;
// The section runs to the next heading, the `%%` that opens the drawing's
// comment, or a fence.
const SECTION_END_RE = /(^|\n)(?:#{1,6}[ \t]|%%|```|~~~)/;
const LINE_RE = /^([A-Za-z0-9_-]+):[ \t]*\[\[([^[\]\n]+)\]\]/;
const DRAWING_RE = /(^|\n)##? Drawing[ \t]*\r?\n/g;

type Section = { headingStart: number; bodyStart: number; bodyEnd: number };

/** The section's place: after `# Excalidraw Data` when the file has one, so a
 * heading in the notes above it isn't taken for it. Text elements can't
 * hold one (the writer marks such a line with a zero-width space). */
function findSection(text: string): Section | null {
  const data = DATA_RE.exec(text);
  const from = data ? data.index + data[0].length : 0;
  const heading = HEADING_RE.exec(text.slice(from));
  if (!heading) return null;
  const headingStart = from + heading.index + heading[1].length;
  const bodyStart = from + heading.index + heading[0].length;
  const end = SECTION_END_RE.exec(text.slice(bodyStart));
  return { headingStart, bodyStart, bodyEnd: end ? bodyStart + end.index + end[1].length : text.length };
}

/** The target a link names: before `#` or `|`, trimmed. */
export function embeddedTarget(link: string): string {
  const cut = link.search(/[#|]/);
  return (cut < 0 ? link : link.slice(0, cut)).trim();
}

type Line = { start: number; end: number; next: number; text: string };

/** The body's lines: `end` before the line break, `next` after it. */
function linesOf(text: string, start: number, end: number): Line[] {
  const lines: Line[] = [];
  let at = start;
  while (at < end) {
    const newline = text.indexOf('\n', at);
    const next = newline < 0 || newline >= end ? end : newline + 1;
    const lineEnd = next > at && text[next - 1] === '\n' ? (text[next - 2] === '\r' ? next - 2 : next - 1) : next;
    lines.push({ start: at, end: lineEnd, next, text: text.slice(at, lineEnd) });
    at = next;
  }
  return lines;
}

/** Every `<id>: [[link]]` line in the section, in order. */
export function embeddedFiles(text: string): EmbeddedFile[] {
  const section = findSection(text);
  if (!section) return [];
  const found: EmbeddedFile[] = [];
  for (const line of linesOf(text, section.bodyStart, section.bodyEnd)) {
    const match = LINE_RE.exec(line.text);
    if (!match) continue;
    const linkStart = line.start + match[0].indexOf('[[') + 2;
    found.push({ id: match[1], link: match[2], target: embeddedTarget(match[2]), linkStart, linkEnd: linkStart + match[2].length });
  }
  return found;
}

/** The cheap look before embeddedFiles(). */
export function mayHaveEmbeddedFiles(text: string): boolean {
  return /embedded files/i.test(text);
}

/** A reference line as the plugin writes it. */
export function embeddedFileLine(id: string, link: string): string {
  return `${id}: [[${link}]]`;
}

export type EmbeddedFilesEdit = {
  /** Lines to have: each id with its link, added at the end when the
   * section has no line for that id yet. A line already there stays as
   * written, so a link a rename rewrote is kept. */
  add?: Iterable<readonly [id: string, link: string]>;
  /** Ids whose `[[…]]` lines go: images Nebula holds by reference that no
   * element uses any more, as the plugin drops them. Every other line stays. */
  drop?: ReadonlySet<string>;
};

/** Where a new section goes: before the `%%` that opens the drawing's
 * comment, else before the `## Drawing` heading, else at the end. */
function newSectionAt(text: string): number {
  const drawings = [...text.matchAll(DRAWING_RE)];
  const last = drawings[drawings.length - 1];
  if (!last) return text.length;
  const heading = (last.index ?? 0) + last[1].length;
  const comment = /(^|\n)%%[ \t]*\r?\n$/.exec(text.slice(0, heading));
  return comment ? comment.index + comment[1].length : heading;
}

/**
 * The text with its Embedded Files section edited: the lines for `drop`
 * dropped (with the blank line after each), lines for new ids added. The
 * text comes back as it was, byte for byte, when there's nothing to change.
 * A file without the section gets one, where the plugin puts it.
 */
export function editEmbeddedFiles(text: string, { add = [], drop }: EmbeddedFilesEdit): string {
  const section = findSection(text);
  const wanted = new Map<string, string>();
  for (const [id, link] of add) if (!wanted.has(id)) wanted.set(id, link);

  if (!section) {
    if (wanted.size === 0) return text;
    const at = newSectionAt(text);
    const before = text.slice(0, at);
    const gap = before === '' || before.endsWith('\n\n') || before.endsWith('\r\n\r\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const entries = [...wanted].map(([id, link]) => `${embeddedFileLine(id, link)}\n\n`).join('');
    return `${before}${gap}## Embedded Files\n${entries}${text.slice(at)}`;
  }

  const lines = linesOf(text, section.bodyStart, section.bodyEnd);
  const kept: Line[] = [];
  const have = new Set<string>();
  let dropped = false;
  let compact = false;
  let previousWasEntry = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = LINE_RE.exec(line.text);
    if (match && drop?.has(match[1])) {
      dropped = true;
      // The blank line the plugin writes after it goes with it.
      if (lines[index + 1]?.text.trim() === '') index += 1;
      previousWasEntry = false;
      continue;
    }
    if (match) {
      have.add(match[1]);
      if (previousWasEntry) compact = true;
    }
    previousWasEntry = Boolean(match);
    kept.push(line);
  }
  const adding = [...wanted].filter(([id]) => !have.has(id));
  if (!dropped && adding.length === 0) return text;

  let body = kept.map((line) => text.slice(line.start, line.next)).join('');
  if (adding.length > 0) {
    if (body.trim() === '') body = adding.map(([id, link]) => `${embeddedFileLine(id, link)}\n\n`).join('');
    else {
      // After the last line with something on it, in the section's own spacing.
      const lastFull = body.replace(/\s+$/, '').length;
      const lineEnd = body.indexOf('\n', lastFull);
      const cut = lineEnd < 0 ? body.length : lineEnd + 1;
      const head = lineEnd < 0 ? `${body}\n` : body.slice(0, cut);
      const entries = adding.map(([id, link]) => embeddedFileLine(id, link));
      const added = compact ? entries.map((entry) => `${entry}\n`).join('') : entries.map((entry) => `\n${entry}\n`).join('');
      body = `${head}${added}${body.slice(cut)}`;
    }
  }
  return `${text.slice(0, section.bodyStart)}${body}${text.slice(section.bodyEnd)}`;
}

/**
 * The text with each reference's link passed through `rewrite` (which gives
 * the new link, or null to leave it). Only the links change: every other
 * byte, line ends included, stays as it was.
 */
export function rewriteEmbeddedLinks(text: string, rewrite: (link: string) => string | null): { text: string; count: number } {
  let out = '';
  let at = 0;
  let count = 0;
  for (const file of embeddedFiles(text)) {
    const next = rewrite(file.link);
    if (next === null || next === file.link) continue;
    out += text.slice(at, file.linkStart) + next;
    at = file.linkEnd;
    count += 1;
  }
  return count === 0 ? { text, count } : { text: out + text.slice(at), count };
}
