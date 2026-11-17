import { useMemo } from 'react';
import { useProjectIndex } from '../projectIndex';
import { tagTree, type TagNode } from '../tags';
import { searchForTag } from '../searchEvent';
import { Button } from './Button';
import { Icon } from './icons';
import { TagButton } from './TagButton';

function filesLabel(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

function TagRows({ nodes }: { nodes: readonly TagNode[] }) {
  return (
    <ul className="ws-tagtree">
      {nodes.map((node) => (
        <li key={node.tag}>
          <Button className="ws-tagrow" aria-label={`Search for #${node.tag}, ${filesLabel(node.files.size)}`} onClick={() => searchForTag(node.tag)}>
            <span className="ws-tagrow-name">{node.name}</span>
            <span className="ws-tagrow-count" aria-hidden="true">
              {node.files.size}
            </span>
          </Button>
          {node.children.length > 0 ? <TagRows nodes={node.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The right panel's "Tags" section: the open note's tags as pills
 * that open search, and under them, folded, every tag in the project with the
 * number of files carrying it, nested tags under their parent. It reads the
 * project index, so it fills in once the index is ready.
 */
export function TagsPanel({ path }: { path: string | null }) {
  const index = useProjectIndex();
  const doc = path ? index.docs.get(path) : undefined;
  const all = useMemo(() => tagTree(index.tags()), [index]);
  const count = useMemo(() => index.tags().size, [index]);

  return (
    <section aria-labelledby="ws-tags-title" className="ws-tags">
      <h3 id="ws-tags-title">Tags</h3>
      {!doc ? (
        index.ready ? <p className="ws-panel-empty">Open a note to see its tags here.</p> : null
      ) : doc.tags.length === 0 ? (
        <p className="ws-panel-empty">{doc.kind === 'canvas' ? 'This canvas has no tags yet.' : 'This note has no tags yet. Write #a-word anywhere in it.'}</p>
      ) : (
        <ul className="ws-taglist" aria-label="Tags in this file">
          {doc.tags.map((tag) => (
            <li key={tag}>
              <TagButton tag={tag} />
            </li>
          ))}
        </ul>
      )}
      {index.ready ? (
        <details className="ws-alltags">
          <summary>
            <Icon name="chevron" className="ws-alltags-chevron" />
            <span>All tags in this project</span>
            <span className="ws-alltags-total">{count}</span>
          </summary>
          {all.length === 0 ? <p className="ws-panel-empty">No tags yet. Write #a-word in a note and it shows up here.</p> : <TagRows nodes={all} />}
        </details>
      ) : null}
    </section>
  );
}
