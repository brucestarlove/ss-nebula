/**
 * The project index: every note's and canvas's words, links,
 * headings and tags, held in memory and rebuilt when a project opens. Search, the "Linked from" panel and the tags panel all read it.
 *
 * Contract for the 2.0.2 lanes: the INDEX lane builds it (its own module
 * beside this one) and provides it from Workspace; the TAGS lane reads
 * `tags`. Lanes may add fields, never rename or remove one; report additions.
 * Until the index lands, Workspace provides `EMPTY_INDEX`.
 */
import { createContext, useContext } from 'react';
import type { Heading } from './outline';

/** One `[[link]]`, `![[embed]]` or project-relative `[text](path)` found in a file. */
export type IndexedLink = {
  /** The file the link is written in. */
  from: string;
  /** What was written between the brackets, before the `|` and `#`. */
  target: string;
  /** The file it resolves to now (links.ts `resolveLink`), or null. */
  resolved: string | null;
  heading?: string;
  embed: boolean;
  /** 0-based line in a note; a canvas link has none. */
  line?: number;
  /** The words around the link, for the panel (one line, trimmed). */
  context: string;
  /** Where the link's own words are in `context`, to mark them (INDEX lane, 2.0.2). */
  contextRange?: SearchRange;
};

export type IndexedDoc = {
  path: string;
  kind: 'note' | 'canvas';
  /** A note's Markdown; a canvas's text elements, one per line. */
  text: string;
  headings: Heading[];
  /** Lowercase, without the `#`, nested tags keep their slashes (`project/nebula`). */
  tags: string[];
  links: IndexedLink[];
};

export type SearchRange = [start: number, end: number];

export type SearchHit = {
  path: string;
  kind: 'note' | 'canvas';
  /** 0-based line in a note, or the text element's index in a canvas. */
  line?: number;
  /** The line the words were found on, trimmed around the match. */
  snippet: string;
  /** Where the query's words are in `snippet`. */
  ranges: SearchRange[];
};

export type ProjectIndex = {
  /** False while the first build runs. */
  ready: boolean;
  docs: ReadonlyMap<string, IndexedDoc>;
  /** Links to `path` from every other indexed file, in path order. */
  backlinks(path: string): IndexedLink[];
  /** Tag → the paths that carry it, sorted by tag. */
  tags(): ReadonlyMap<string, readonly string[]>;
  /** Words in notes and on canvases. A query of `#tag` lists the files carrying that tag. */
  search(query: string, limit?: number): SearchHit[];
  /** Files whose text names `path`'s title without linking to it: "Not linked yet" (INDEX lane, 2.0.2). */
  mentions?(path: string, limit?: number): SearchHit[];
};

export const EMPTY_INDEX: ProjectIndex = {
  ready: false,
  docs: new Map(),
  backlinks: () => [],
  tags: () => new Map(),
  search: () => [],
};

export const ProjectIndexContext = createContext<ProjectIndex>(EMPTY_INDEX);

export function useProjectIndex(): ProjectIndex {
  return useContext(ProjectIndexContext);
}
