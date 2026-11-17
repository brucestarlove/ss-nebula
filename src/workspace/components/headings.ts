/** Finding a heading on the stage, for the outline and for links to a heading. */
import { fold } from '../indexBuild';
import type { LinePlace } from '../views/shared/projectLinks';

/** A link to a heading in a file (`[[Note#Heading]]`): which file, which
 * heading, and a count that makes each click its own request. A search hit
 * or a Linked from line asks for a place by its words (`place`; slice 6),
 * with `heading` '' or the heading to fall back on. */
export type HeadingJump = { path: string; heading: string; n: number; place?: LinePlace };

/** How long a link to a heading waits for the view to draw it. */
export const HEADING_JUMP_MS = 4000;

function normalHeading(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The stage's nth heading with this text. A link's text is matched as a
 * reader sees it (case and runs of spaces don't matter); the outline's own
 * count of equal headings is exact. Headings inside an embedded note belong to
 * that note, not to the page, so they're passed over. */
export function findHeading(stage: ParentNode, text: string, nth = 0, exact = false): HTMLElement | null {
  const same = exact ? (shown: string | null) => shown?.trim() === text : (shown: string | null) => normalHeading(shown) === normalHeading(text);
  const matches = [...stage.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].filter(
    (element) => same(element.textContent) && !element.closest('.ws-embed-note'),
  );
  return matches[nth] ?? matches[0] ?? null;
}


/** Text as matched on the stage: folded (indexBuild.ts) and with runs of spaces made one. */
function matchable(text: string | null): string {
  return fold((text ?? '').replace(/\s+/g, ' ').trim());
}

/** Blocks a line of a note is drawn as: the reading view's, and the editor's lines. */
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre, dt, dd, .cm-line';

/** How long a line found by its words stays marked. */
const FOUND_MS = 1800;

/**
 * The block on the stage that shows a line, found by its words: the one
 * holding the line's text as a reader sees it (the longest part of a
 * snippet cut with '…'), else the first holding every one of `words`. Of
 * blocks inside one another, the innermost. Embedded notes are passed over.
 */
export function findText(stage: ParentNode, place: LinePlace): HTMLElement | null {
  const blocks = [...stage.querySelectorAll<HTMLElement>(BLOCKS)].filter((element) => !element.closest('.ws-embed-note'));
  const innermost = (matches: HTMLElement[]) => matches.find((element) => !matches.some((other) => other !== element && element.contains(other))) ?? null;
  const wanted = matchable(place.text.split('…').reduce((longest, part) => (part.trim().length > longest.length ? part.trim() : longest), ''));
  if (wanted) {
    const found = innermost(blocks.filter((element) => matchable(element.textContent).includes(wanted)));
    if (found) return found;
  }
  const words = (place.words ?? []).map(matchable).filter(Boolean);
  if (words.length === 0) return null;
  return innermost(blocks.filter((element) => {
    const text = matchable(element.textContent);
    return words.every((word) => text.includes(word));
  }));
}

/** Where a jump lands: its place (marked for a moment, so the eye finds it), else its heading. */
export function findJump(stage: ParentNode, jump: HeadingJump): HTMLElement | null {
  const found = jump.place ? findText(stage, jump.place) : null;
  if (found) {
    found.setAttribute('data-ws-found', '');
    window.setTimeout(() => found.removeAttribute('data-ws-found'), FOUND_MS);
    return found;
  }
  return jump.heading ? findHeading(stage, jump.heading) : null;
}
