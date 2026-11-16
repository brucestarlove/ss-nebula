import { plainHeading } from '../../../outline';
import type { WikiTarget } from '../links';

/**
 * The part of a note an embed shows: `![[Note#Heading]]` is that heading and
 * what's under it, up to the next heading of the same level or above;
 * `![[Note#^id]]` is the paragraph that ends in `^id`. A nested link
 * (`#A#B`) looks for B under A. Null when the note has no such part, so the
 * caller can show the whole note instead.
 */

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

type Line = { text: string; depth: number | null };

/** The lines of a body, each with its heading depth (null: not a heading, or inside a fence). */
function scan(body: string): Line[] {
  const lines = body.split('\n');
  let fence: string | null = null;
  return lines.map((text) => {
    const fenced = FENCE.exec(text);
    if (fence) {
      if (fenced && fenced[1][0] === fence[0] && fenced[1].length >= fence.length) fence = null;
      return { text, depth: null };
    }
    if (fenced) {
      fence = fenced[1];
      return { text, depth: null };
    }
    const heading = ATX.exec(text);
    return { text, depth: heading ? heading[1].length : null };
  });
}

function sameHeading(text: string, wanted: string): boolean {
  return plainHeading(ATX.exec(text)?.[2] ?? '').toLowerCase() === wanted.trim().toLowerCase();
}

function headingSection(lines: Line[], names: string[]): Line[] | null {
  let scope = lines;
  for (const name of names) {
    const start = scope.findIndex((line) => line.depth !== null && sameHeading(line.text, name));
    if (start < 0) return null;
    const depth = scope[start].depth as number;
    let end = scope.length;
    for (let index = start + 1; index < scope.length; index += 1) {
      const next = scope[index].depth;
      if (next !== null && next <= depth) {
        end = index;
        break;
      }
    }
    scope = scope.slice(start, end);
  }
  return scope;
}

function blockParagraph(lines: Line[], id: string): string | null {
  const marker = new RegExp(`(?:^|\\s)\\^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  const at = lines.findIndex((line) => marker.test(line.text));
  if (at < 0) return null;
  let first = at;
  while (first > 0 && lines[first - 1].text.trim() !== '') first -= 1;
  const picked = lines.slice(first, at + 1).map((line) => line.text);
  picked[picked.length - 1] = picked[picked.length - 1].replace(marker, '');
  return picked.join('\n');
}

export function sectionOf(body: string, link: Pick<WikiTarget, 'heading' | 'block'>): string | null {
  if (!link.heading && !link.block) return null;
  let lines = scan(body.replace(/\r\n?/g, '\n'));
  if (link.heading) {
    const section = headingSection(lines, link.heading.split('#'));
    if (!section) return null;
    lines = section;
  }
  if (link.block) return blockParagraph(lines, link.block);
  return lines.map((line) => line.text).join('\n');
}
