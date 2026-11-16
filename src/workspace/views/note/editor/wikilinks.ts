import type { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { tags } from '@lezer/highlight';
import type { FileEntry } from '../../../../files/types';
import { isApplePlatform } from '../../shared/hooks';
import { linkHeading, makesNote, parseWikilink, resolveLink, type WikiTarget } from '../links';
import { projectLinksOf } from './projectLinks';

/**
 * `[[wikilinks]]` and `![[embeds]]` in the editor: the syntax (a lezer
 * Markdown extension, so they are nodes of the tree like any link), which
 * part of the text a drawn link shows, the file it names, and what opening
 * it does. livePreview.ts draws them; embeds.ts draws the embeds that stand
 * on a line of their own.
 */

/** What `markdown({ extensions })` takes (`@lezer/markdown` isn't a direct dependency). */
type MarkdownExtension = NonNullable<NonNullable<Parameters<typeof markdown>[0]>['extensions']>;

const BANG = 33; // !
const OPEN = 91; // [
const CLOSE = 93; // ]
const NEWLINE = 10;

/**
 * `[[…]]` is a Wikilink node and `![[…]]` an Embed, each with its brackets
 * as WikilinkMark children. The inside is one or more characters with no
 * bracket and no line break, as Obsidian (and updateLinks.ts) read it. Tried
 * before Markdown's own links, so `[[Orion]]` is never read as nested
 * `[ ]` links; code spans are parsed first and keep their text.
 */
export const wikilinkSyntax: MarkdownExtension = {
  defineNodes: [
    { name: 'Wikilink', style: tags.link },
    { name: 'Embed', style: tags.link },
    { name: 'WikilinkMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Wikilink',
      before: 'Link',
      parse(cx, next, pos) {
        const embed = next === BANG;
        const start = embed ? pos + 1 : pos;
        if ((!embed && next !== OPEN) || cx.char(start) !== OPEN || cx.char(start + 1) !== OPEN) return -1;
        let at = start + 2;
        for (; at < cx.end; at += 1) {
          const ch = cx.char(at);
          if (ch === CLOSE || ch === OPEN || ch === NEWLINE) break;
        }
        if (at === start + 2 || cx.char(at) !== CLOSE || cx.char(at + 1) !== CLOSE) return -1;
        const end = at + 2;
        return cx.addElement(cx.elt(embed ? 'Embed' : 'Wikilink', pos, end, [cx.elt('WikilinkMark', pos, start + 2), cx.elt('WikilinkMark', at, end)]));
      },
    },
  ],
};

/** A wikilink or embed in the text: where it is and what's between its brackets. */
export type WikiNode = { from: number; to: number; embed: boolean; raw: string; inner: number };

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

export function wikiNodeOf(state: EditorState, node: SyntaxNode): WikiNode | null {
  if (node.name !== 'Wikilink' && node.name !== 'Embed') return null;
  const embed = node.name === 'Embed';
  const inner = node.from + (embed ? 3 : 2);
  return { from: node.from, to: node.to, embed, raw: state.doc.sliceString(inner, node.to - 2), inner };
}

/** The wikilink or embed at `pos` (inside it or at either edge), or null. */
export function wikiNodeAt(state: EditorState, pos: number): WikiNode | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      const found = wikiNodeOf(state, node);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Which characters of a link's inside a drawn link shows, as offsets into
 * `raw`: the alias when there is one, else the target and its heading (the
 * reading view's 'Note > Heading', each '#' drawn as ' > '). Everything else
 * is hidden. An embed's `|300` is a size, not an alias. In a table the bar is
 * written `\|`, and its backslash is hidden with it.
 */
export function shownParts(raw: string, embed: boolean): Array<[number, number]> {
  const trimmed = (from: number, to: number): [number, number] | null => {
    while (from < to && /\s/.test(raw[from])) from += 1;
    while (to > from && /\s/.test(raw[to - 1])) to -= 1;
    return to > from ? [from, to] : null;
  };
  const bar = raw.indexOf('|');
  const link = parseWikilink(raw, embed);
  if (bar >= 0 && link.alias) {
    const alias = trimmed(bar + 1, raw.length);
    if (alias) return [alias];
  }
  const placeEnd = bar < 0 ? raw.length : raw[bar - 1] === '\\' ? bar - 1 : bar;
  const hash = raw.slice(0, placeEnd).indexOf('#');
  const target = trimmed(0, hash < 0 ? placeEnd : hash);
  if (hash < 0) return target ? [target] : [];
  const rest = raw.slice(hash + 1, placeEnd);
  if (rest.trimStart().startsWith('^')) {
    // A block: the note's name, or the block's id for one in this note.
    if (target) return [target];
    const id = trimmed(hash + 1 + rest.indexOf('^') + 1, placeEnd);
    return id ? [id] : [];
  }
  const blockAt = rest.indexOf('#^');
  const headingEnd = hash + 1 + (blockAt < 0 ? rest.length : blockAt);
  const parts: Array<[number, number]> = target ? [target] : [];
  let from = hash + 1;
  for (let at = from; at <= headingEnd; at += 1) {
    if (at === headingEnd || raw[at] === '#') {
      const part = trimmed(from, at);
      if (part) parts.push(part);
      from = at + 1;
    }
  }
  return parts;
}

/* ---- the file a link names ---------------------------------------------- */

// resolveLink() filters every file; a screen of links is drawn on every
// keystroke, so the answers are kept per list of files (a new list, a new map).
const resolved = new WeakMap<readonly FileEntry[], Map<string, FileEntry | null>>();

export function resolveCached(target: string, from: string, files: readonly FileEntry[]): FileEntry | null {
  let cache = resolved.get(files);
  if (!cache) resolved.set(files, (cache = new Map()));
  const key = `${from}\u0000${target}`;
  if (!cache.has(key)) cache.set(key, resolveLink(target, from, files));
  return cache.get(key) ?? null;
}

/** What a link does when it's opened, and what its title says (the reading view's words). */
export type LinkTarget = {
  link: WikiTarget;
  /** The file it opens: another, or this note for `[[#Heading]]`. */
  path: string | null;
  heading: string | undefined;
  /** No file, but a note can be made for it. */
  canMake: boolean;
  title: string;
};

export function linkTarget(state: EditorState, node: Pick<WikiNode, 'raw' | 'embed'>): LinkTarget {
  const { files, path: from } = projectLinksOf(state);
  const link = parseWikilink(node.raw, node.embed);
  const own = link.target === '';
  const file = own ? null : resolveCached(link.target, from, files);
  const path = own ? from || null : (file?.path ?? null);
  const canMake = !path && !own && makesNote(link.target);
  const key = isApplePlatform() ? '⌘' : 'Ctrl';
  const title = path ? `${path} (${key}-click to open)` : canMake ? `No note called ${link.target}. ${key}-click to make it.` : `No file called ${link.target || node.raw.trim()}.`;
  return { link, path, heading: linkHeading(link), canMake, title };
}

/** Opens the file a wikilink names (at its heading), or makes the note it names. True when it did either. */
export function followLink(state: EditorState, node: Pick<WikiNode, 'raw' | 'embed'>): boolean {
  const links = projectLinksOf(state);
  const target = linkTarget(state, node);
  if (target.path) {
    links.open(target.path, target.heading);
    return true;
  }
  if (target.canMake) {
    links.create(target.link.target, links.path);
    return true;
  }
  return false;
}
