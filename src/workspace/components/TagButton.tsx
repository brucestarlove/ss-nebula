import { searchForTag } from '../searchEvent';
import { Button } from './Button';

/**
 * A tag that opens search for it, drawn as a link (workspace.css `.ws-tag`),
 * as it is in live preview and the Markdown source. A real button, so the
 * keyboard and a screen reader reach it; the name says what pressing it does.
 */
export function TagButton({ tag, className, label }: { tag: string; className?: string; /** Replaces the default name, e.g. to add a count. */ label?: string }) {
  const bare = tag.replace(/^#/, '');
  return (
    <Button className={['ws-tag', 'ws-tag-button', className].filter(Boolean).join(' ')} aria-label={label ?? `Search for #${bare}`} onClick={() => searchForTag(bare)}>
      #{bare}
    </Button>
  );
}
