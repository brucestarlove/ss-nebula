import type { FileEntry } from '../files/types';
import { basename, dirname } from '../files/paths';
import { describeName } from './paths';

export type TreeNode = {
  path: string;
  name: string;
  type: 'file' | 'dir';
  entry: FileEntry;
  /** What the rail shows: the name without a note's or canvas's extension. */
  label: string;
  /** Any other extension, shown as a small tag ('jpg'), or ''. */
  tag: string;
  /** Folders only; sorted, folders first. */
  children: TreeNode[];
  /** Folders only: the files inside, however deep. */
  fileCount: number;
};

export type VisibleRow = { node: TreeNode; level: number; parent: string | null };

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Folders first, then A to Z by what the tree shows, ignoring case, with
 * numbers in order (Note 2 before Note 10). */
export function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return collator.compare(a.label, b.label) || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function makeNode(entry: FileEntry): TreeNode {
  const { label, tag } = entry.type === 'dir' ? { label: entry.name, tag: '' } : describeName(entry.name);
  return { path: entry.path, name: entry.name, type: entry.type, entry, label, tag, children: [], fileCount: 0 };
}

/** The project's files as a tree, from FileStore.list()'s flat list. */
export function buildTree(entries: FileEntry[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  const folder = (path: string): TreeNode => {
    let node = byPath.get(path);
    if (!node) {
      node = makeNode({ path, name: basename(path), type: 'dir' });
      byPath.set(path, node);
      attach(node);
    }
    return node;
  };

  const attach = (node: TreeNode) => {
    const parent = dirname(node.path);
    (parent ? folder(parent).children : roots).push(node);
  };

  for (const entry of entries) {
    const existing = byPath.get(entry.path);
    if (existing) {
      // A folder made up for an earlier child, now listed in its own right.
      existing.entry = entry;
      continue;
    }
    const node = makeNode(entry);
    byPath.set(entry.path, node);
    attach(node);
  }

  const finish = (nodes: TreeNode[]): number => {
    nodes.sort(compareNodes);
    let files = 0;
    for (const node of nodes) {
      if (node.type === 'dir') {
        node.fileCount = finish(node.children);
        files += node.fileCount;
      } else {
        files += 1;
      }
    }
    return files;
  };
  finish(roots);
  return roots;
}

/** The rows on screen, top to bottom: folders show their children only while
 * they, and every folder above them, are expanded. */
export function visibleNodes(tree: TreeNode[], expanded: ReadonlySet<string>): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (nodes: TreeNode[], level: number, parent: string | null) => {
    for (const node of nodes) {
      rows.push({ node, level, parent });
      if (node.type === 'dir' && expanded.has(node.path)) walk(node.children, level + 1, node.path);
    }
  };
  walk(tree, 1, null);
  return rows;
}

/** Every node, depth first, in tree order. */
export function walkTree(tree: TreeNode[], visit: (node: TreeNode) => void): void {
  for (const node of tree) {
    visit(node);
    if (node.type === 'dir') walkTree(node.children, visit);
  }
}
