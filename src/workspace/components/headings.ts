/** Finding a heading on the stage, for the outline and for links to a heading. */

/** A link to a heading in a file (`[[Note#Heading]]`): which file, which
 * heading, and a count that makes each click its own request. */
export type HeadingJump = { path: string; heading: string; n: number };

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

