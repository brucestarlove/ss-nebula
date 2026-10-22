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

export function extractOutline(markdown: string): Heading[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const headings: Heading[] = [];
  let i = 0;

  // Front matter: a block between --- lines at the very top.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (end !== -1) i = end + 1;
  }

  let fence: string | null = null;
  let previous: string | null = null; // the last paragraph line, for underlines

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
      if (text) headings.push({ depth: atx[1].length, text });
      previous = null;
      continue;
    }

    const underline = UNDERLINE.exec(line);
    if (underline && previous !== null) {
      const text = plainHeading(previous);
      if (text) headings.push({ depth: underline[1][0] === '=' ? 1 : 2, text });
      previous = null;
      continue;
    }

    previous = line.trim() === '' || BLOCK_START.test(line) ? null : line;
  }

  return headings;
}
