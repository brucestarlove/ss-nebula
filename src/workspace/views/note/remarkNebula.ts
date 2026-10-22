/**
 * Nebula's markdown extras for the reading view, as a remark plugin:
 *
 * - `[[Note]]`, `[[Note|alias]]` and `![[image.png]]` become plain text for
 *   now (the alias, or the target); links and embeds arrive in slice 5.
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

function span(type: string, className: string[], text: string, title?: string): MdNode {
  return {
    type,
    data: {
      hName: 'span',
      hProperties: title ? { className, title } : { className },
      hChildren: [{ type: 'text', value: text }],
    },
  };
}

function splitText(value: string): MdNode[] | null {
  const nodes: MdNode[] = [];
  let last = 0;
  for (const match of value.matchAll(EXTRAS)) {
    const start = match.index ?? 0;
    if (match[2] !== undefined) {
      if (start > last) nodes.push({ type: 'text', value: value.slice(last, start) });
      nodes.push(span('nebulaWikilink', ['ws-wikilink'], wikilinkText(match[2]), match[2].split('|')[0].trim()));
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

function transform(node: MdNode): void {
  if (!node.children || SKIP.has(node.type)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      next.push(...(splitText(child.value) ?? [child]));
    } else {
      transform(child);
      next.push(child);
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
