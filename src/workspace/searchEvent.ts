/**
 * Asking the workspace to open search with a query: a tag clicked in
 * a note, in the editor or in the right panel opens search for `#tag`.
 *
 * It is a plain `CustomEvent` on `window`, so the reading view, the editor and
 * the panel (which live in different chunks and know nothing of the palette)
 * can ask without being wired to it. Whoever owns the palette listens:
 *
 *   window.addEventListener(SEARCH_EVENT, (event) => {
 *     const { query } = (event as CustomEvent<SearchRequest>).detail;
 *     event.preventDefault(); // "handled": requestSearch() returns true
 *     // open the palette with `query` in its field
 *   });
 */

export const SEARCH_EVENT = 'nebula:search';

export type SearchRequest = { query: string };

/** Opens search with `query`. True when something took the request (called `preventDefault`). */
export function requestSearch(query: string): boolean {
  if (typeof window === 'undefined') return false;
  return !window.dispatchEvent(new CustomEvent<SearchRequest>(SEARCH_EVENT, { detail: { query }, cancelable: true }));
}

/** Search for a tag: the query the index understands (`#tag`, lowercase, nested tags with their slashes). */
export function searchForTag(tag: string): boolean {
  return requestSearch(`#${tag.replace(/^#/, '').toLowerCase()}`);
}
