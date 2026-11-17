import type { FileEntry, ProjectRecord } from '../files/types';
import { dirname } from '../files/paths';
import { describeName } from './paths';

/** Quick open (⌘K / Ctrl+K): this project's files by name, then the other
 * projects. Plain substring matching, case-insensitive, with the match
 * highlighted; names that start with the query come first. */
export type Highlight = [start: number, end: number];
export type FileResult = { path: string; title: string; folder: string; ranges: Highlight[] };
export type ProjectResult = { project: ProjectRecord; ranges: Highlight[] };

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function matchText(text: string, query: string): Highlight[] | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const at = text.toLowerCase().indexOf(needle);
  return at === -1 ? null : [[at, at + needle.length]];
}

/** How a file is named in results: notes and canvases by name alone, other
 * files with their extension ('Orion Nebula.jpg'). */
export function resultTitle(name: string): string {
  const { label, tag } = describeName(name);
  return tag ? name : label;
}

function rank(title: string, ranges: Highlight[]): [number, number] {
  if (ranges.length === 0) return [0, 0];
  const [start] = ranges[0];
  if (start === 0) return [0, 0];
  const before = title[start - 1];
  return [/[\p{L}\p{N}]/u.test(before) ? 2 : 1, start];
}

function byRank<T extends { title: string; ranges: Highlight[] }>(a: T, b: T): number {
  const [tierA, posA] = rank(a.title, a.ranges);
  const [tierB, posB] = rank(b.title, b.ranges);
  return tierA - tierB || posA - posB || a.title.length - b.title.length || collator.compare(a.title, b.title);
}

export function quickOpenFiles(entries: FileEntry[], query: string, limit = 50): FileResult[] {
  const results: FileResult[] = [];
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    const title = resultTitle(entry.name);
    const ranges = matchText(title, query);
    if (ranges) results.push({ path: entry.path, title, folder: dirname(entry.path), ranges });
  }
  results.sort(query.trim() ? byRank : (a, b) => collator.compare(a.title, b.title) || collator.compare(a.path, b.path));
  return results.slice(0, limit);
}

export function quickOpenProjects(projects: ProjectRecord[], currentId: string | null, query: string): ProjectResult[] {
  const results: (ProjectResult & { title: string })[] = [];
  for (const project of projects) {
    if (project.id === currentId) continue;
    const ranges = matchText(project.name, query);
    if (ranges) results.push({ project, ranges, title: project.name });
  }
  if (query.trim()) results.sort(byRank);
  return results.map(({ project, ranges }) => ({ project, ranges }));
}

/**
 * What quick open searches the notes and canvases for: the
 * query's words and `#tags`, or null for a query too short to be worth it
 * (one character, or a lone `#`). Words keep their case; the index folds them.
 */
export function searchWords(query: string): { words: string[]; tags: string[] } | null {
  const parts = query.trim().split(/\s+/).filter(Boolean);
  const words = parts.filter((part) => !part.startsWith('#'));
  const tags = parts.filter((part) => part.startsWith('#')).map((part) => part.replace(/^#+/, '')).filter(Boolean);
  if (tags.length === 0 && words.join(' ').length < 2) return null;
  return { words, tags };
}

/** Text cut into plain and marked runs, for rendering a match. */
export function splitHighlights(text: string, ranges: Highlight[]): { text: string; mark: boolean }[] {
  const runs: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (start > at) runs.push({ text: text.slice(at, start), mark: false });
    if (end > start) runs.push({ text: text.slice(Math.max(start, at), end), mark: true });
    at = Math.max(at, end);
  }
  if (at < text.length) runs.push({ text: text.slice(at), mark: false });
  return runs;
}
