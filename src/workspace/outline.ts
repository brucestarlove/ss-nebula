/** The headings of a markdown note, for the right panel's Outline. A light
 * line scanner rather than a full parser: ATX (`## Title`) and underlined
 * headings, skipping front matter and fenced code. */
export type Heading = { depth: number; text: string };

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const BLOCK_START = /^ {0,3}(?:[-*+][ \t]|\d+[.)][ \t]|>|#|\||```|~~~)/;

/** Heading text as a reader sees it: marks dropped, links reduced to their text. */
export function plainHeading(raw: string): string {
  return raw
    .replace(/[ \t]+#+[ \t]*$/, '')
    .replace(/^#+[ \t]*$/, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .trim();
}

/** A heading and where it's written: its 0-based line (an underlined heading's is its text's line). */
export type HeadingAt = Heading & { line: number };

export function extractOutline(markdown: string): Heading[] {
  return extractOutlineLines(markdown).map(({ depth, text }) => ({ depth, text }));
}

/** The outline with each heading's line, for finding it in the editor's text. */
export function extractOutlineLines(markdown: string): HeadingAt[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const headings: HeadingAt[] = [];
  let i = 0;

  // Front matter: a block between --- lines at the very top.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (end !== -1) i = end + 1;
  }

  let fence: string | null = null;
  let previous: string | null = null; // the last paragraph line, for underlines
  let previousLine = 0;

  for (; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      previous = null;
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      const text = plainHeading(atx[2] ?? '');
      if (text) headings.push({ depth: atx[1].length, text, line: i });
      previous = null;
      continue;
    }

    const underline = UNDERLINE.exec(line);
    if (underline && previous !== null) {
      const text = plainHeading(previous);
      if (text) headings.push({ depth: underline[1][0] === '=' ? 1 : 2, text, line: previousLine });
      previous = null;
      continue;
    }

    previous = line.trim() === '' || BLOCK_START.test(line) ? null : line;
    previousLine = i;
  }

  return headings;
}

/** For each heading, how many before it read the same: how the stage tells equal headings apart. */
export function occurrences(headings: readonly Heading[]): number[] {
  const seen = new Map<string, number>();
  return headings.map((heading) => {
    const nth = seen.get(heading.text) ?? 0;
    seen.set(heading.text, nth + 1);
    return nth;
  });
}

/**
 * The heading being read: the last one whose top has reached the reading
 * line, given each heading's top (null for one that isn't drawn). Scrolled
 * to the end, where a short last section never gets near the line, it's the
 * last one in view (`bottom` is the bottom of the view).
 */
export function readingIndex(tops: ReadonlyArray<number | null>, line: number, atEnd = false, bottom = Infinity): number | null {
  let found: number | null = null;
  for (let index = 0; index < tops.length; index += 1) {
    const top = tops[index];
    if (top !== null && (top <= line || (atEnd && top < bottom))) found = index;
  }
  return found;
}
