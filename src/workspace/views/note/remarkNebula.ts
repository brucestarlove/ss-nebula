/**
 * Nebula's markdown extras for the reading view, as a remark plugin:
 *
 * - `[[Note]]`, `[[Note|alias]]` and `![[file]]` become elements that carry
 *   what was written between the brackets (`data-wikilink`, `data-embed`);
 *   the reading view's components (embeds/) draw them as links and embeds.
 *   With no components they read as plain text: the alias, or the target.
 * - Inline `#tags` become tag pills.
 *
 * It only rewrites text nodes, so code stays as written. No dependencies:
 * the tree is walked by hand.
 */

type MdNode = {
  type: string;
  value?: string;
  depth?: number;
  children?: MdNode[];
  data?: Record<string, unknown>;
};

const SKIP = new Set(['code', 'inlineCode', 'html', 'math', 'inlineMath']);

const EXTRAS = /(!?)\[\[([^[\]\n]+?)\]\]|(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

/** What a wikilink shows: its alias, else its target ('Note > Heading'). */
export function wikilinkText(inner: string): string {
  const bar = inner.indexOf('|');
  if (bar >= 0) {
    const alias = inner.slice(bar + 1).trim();
    if (alias) return alias;
  }
  const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
  return target.replace(/#\^[^#]*$/, '').replace(/#/g, ' > ');
}

function span(type: string, className: string[], text: string, extra: Record<string, unknown> = {}, tag = 'span'): MdNode {
  return {
    type,
    data: {
      hName: tag,
      hProperties: { className, ...extra },
      hChildren: [{ type: 'text', value: text }],
    },
  };
}

function splitText(value: string, insideLink: boolean): MdNode[] | null {
  const nodes: MdNode[] = [];
  let last = 0;
  for (const match of value.matchAll(EXTRAS)) {
    const start = match.index ?? 0;
    if (match[2] !== undefined) {
      if (start > last) nodes.push({ type: 'text', value: value.slice(last, start) });
      const text = wikilinkText(match[2]);
      if (match[1]) nodes.push(span('nebulaEmbed', ['ws-embed'], text, { dataEmbed: match[2] }));
      // Inside a link's own text it's only words: a link can't hold a link.
      else if (insideLink) nodes.push(span('nebulaWikilink', ['ws-wikilink'], text, { title: match[2].split('|')[0].trim() }));
      else nodes.push(span('nebulaWikilink', ['ws-wikilink'], text, { dataWikilink: match[2] }));
    } else {
      const lead = match[3] ?? '';
      if (start + lead.length > last) nodes.push({ type: 'text', value: value.slice(last, start + lead.length) });
      nodes.push(span('nebulaTag', ['ws-tag', 'ws-tag-inline'], `#${match[4]}`));
    }
    last = start + match[0].length;
  }
  if (nodes.length === 0) return null;
  if (last < value.length) nodes.push({ type: 'text', value: value.slice(last) });
  return nodes;
}

/** The embeds of a paragraph that holds nothing else (spaces between them aside), or null. */
function aloneEmbeds(paragraph: MdNode): MdNode[] | null {
  const children = paragraph.children ?? [];
  const embeds = children.filter((child) => child.type === 'nebulaEmbed');
  if (embeds.length === 0) return null;
  const rest = children.filter((child) => child.type !== 'nebulaEmbed');
  return rest.every((child) => child.type === 'text' && !(child.value ?? '').trim()) ? embeds : null;
}

function transform(node: MdNode, insideLink = false): void {
  if (!node.children || SKIP.has(node.type)) return;
  const within = insideLink || node.type === 'link' || node.type === 'linkReference';
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      next.push(...(splitText(child.value, within) ?? [child]));
    } else {
      transform(child, within);
      // An embed alone in its paragraph stands on its own, as a block (a
      // note's text, with its paragraphs and headings, can't sit in a <p>).
      const alone = child.type === 'paragraph' ? aloneEmbeds(child) : null;
      if (alone) {
        for (const embed of alone) {
          if (embed.data) embed.data.hName = 'div';
          next.push(embed);
        }
      } else next.push(child);
    }
  }
  node.children = next;
}

export function remarkNebula() {
  return (tree: MdNode) => {
    transform(tree);
  };
}

function plainText(node: MdNode): string {
  if ((node.type === 'text' || node.type === 'inlineCode') && typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(plainText).join('');
}

/**
 * Drops a first heading that only repeats the note's title (its file name,
 * which the page already shows above the text), so the title isn't shown
 * twice. Matched without regard to case; any other heading, and the same
 * words further down, stay. The other nodes keep their source positions, so
 * task boxes still write back to their own lines.
 */
export function remarkHideTitle(title: string) {
  const wanted = title.trim().toLowerCase();
  return (tree: MdNode) => {
    const first = tree.children?.[0];
    if (first?.type === 'heading' && first.depth === 1 && plainText(first).trim().toLowerCase() === wanted) {
      tree.children = tree.children?.slice(1);
    }
  };
}
