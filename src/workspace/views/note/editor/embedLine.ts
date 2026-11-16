import { parseWikilink, resolveLink, resolveMarkdownPath } from '../links';
import type { EditorLinks } from './projectLinks';

/** A line that holds only an embed (embeds.tsx finds them). */
export type EmbedLine = {
  from: number;
  to: number;
  kind: 'wiki' | 'image';
  /** `![[raw]]`'s inside, or a markdown image's address. */
  raw: string;
  alt?: string;
  title?: string;
};

/** The file an embed line names, or null. */
export function embedFile(embed: EmbedLine, links: EditorLinks) {
  if (embed.kind === 'image') return resolveMarkdownPath(embed.raw, links.path, links.files);
  const link = parseWikilink(embed.raw, true);
  return link.target ? resolveLink(link.target, links.path, links.files) : null;
}

export function embedName(embed: EmbedLine): string {
  if (embed.kind === 'image') return embed.alt || embed.raw.split('/').pop() || embed.raw;
  return parseWikilink(embed.raw, true).target || embed.raw.trim();
}

