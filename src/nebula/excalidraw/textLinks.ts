/**
 * `[[links]]` written in a drawing's text become the element's link, as
 * Obsidian Excalidraw does: Excalidraw then shows its link icon, and a click
 * on it opens the note (the canvas view's `onLinkOpen`).
 *
 * It writes to the user's drawing, so it changes as little as it can:
 * - a text element with no link takes the first `[[ ]]` in its text;
 * - a `[[ ]]` link the text no longer holds follows the text's first one
 *   (the link was written from the text, and the text changed);
 * - any other link (a web address, a path, a `[[ ]]` the text still holds) is
 *   left as it is, and a link is never removed.
 */

const WIKI = /!?\[\[([^[\]\n]+)\]\]/;
const WIKI_LINK = /^!?\[\[[^[\]\n]+\]\]$/;

type TextLike = {
  id: string;
  type?: string;
  text?: unknown;
  link?: unknown;
  isDeleted?: boolean;
  version?: unknown;
  versionNonce?: unknown;
  updated?: unknown;
};

/** The link a text element's words ask for, or null when they leave its link as it is. */
export function linkFromText(element: TextLike): string | null {
  if (element.type !== 'text' || element.isDeleted || typeof element.text !== 'string') return null;
  const found = WIKI.exec(element.text);
  if (!found) return null;
  const wanted = `[[${found[1].trim()}]]`;
  const current = typeof element.link === 'string' ? element.link.trim() : '';
  if (!current) return wanted;
  if (current === wanted) return null;
  // A [[ ]] link the text still holds was chosen by someone: keep it.
  if (WIKI_LINK.test(current) && !element.text.includes(current.replace(/^!/, ''))) return wanted;
  return null;
}

/**
 * The elements whose links follow their text, as new element objects (a
 * new version, so the change is saved and synced), or an empty list when
 * nothing changes. The caller puts them back into the scene.
 */
export function elementsWithTextLinks<T extends TextLike>(elements: readonly T[]): T[] {
  const changed: T[] = [];
  for (const element of elements) {
    const link = linkFromText(element);
    if (link === null) continue;
    changed.push({
      ...element,
      link,
      version: (typeof element.version === 'number' ? element.version : 0) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    });
  }
  return changed;
}
