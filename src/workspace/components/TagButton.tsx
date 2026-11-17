import { searchForTag } from '../searchEvent';
import { Button } from './Button';

/**
 * A tag as a pill that opens search for it: the reading view's, the editor's
 * and the panel's tags are all this shape (workspace.css `.ws-tag`). A real
 * button, so the keyboard and a screen reader reach it; the name says what
 * pressing it does.
 */
export function TagButton({ tag, className, label }: { tag: string; className?: string; /** Replaces the default name, e.g. to add a count. */ label?: string }) {
  const bare = tag.replace(/^#/, '');
  return (
    <Button className={['ws-tag', 'ws-tag-button', className].filter(Boolean).join(' ')} aria-label={label ?? `Search for #${bare}`} onClick={() => searchForTag(bare)}>
      #{bare}
    </Button>
  );
}
