import { useCallback, useContext, useMemo, type KeyboardEvent } from 'react';
import type { FileEntry } from '../../../../files/types';
import { useProjectLinks } from '../../shared/projectLinks';
import { linkHeading, makesNote, parseWikilink, resolveLink, wikilinkLabel } from '../links';
import { NoteEnvContext } from './NoteEnv';

/**
 * `[[Note]]`, `[[Note#Heading|alias]]`, `[[#Heading]]` as a link: it opens the
 * file in a tab (and scrolls to the heading), and one that names nothing is
 * drawn muted and makes the note when it's clicked. A link by role, with a
 * tab stop and Enter, so the keyboard reaches it as it does a mouse.
 */
export function WikiLink({ raw }: { raw: string }) {
  const env = useContext(NoteEnvContext);
  const project = useProjectLinks();
  const link = parseWikilink(raw);
  const label = wikilinkLabel(link) || raw.trim();
  const from = env?.path ?? '';
  // [[#Heading]] and [[^block]] are in the note the text belongs to.
  const own = link.target === '';
  const file = useMemo(() => (own ? (from ? { path: from } : null) : resolveLink(link.target, from, project.files)), [own, from, link.target, project.files]);
  const heading = linkHeading(link);
  const canMake = !file && makesNote(link.target);

  const go = useCallback(() => {
    if (file) project.open(file.path, heading);
    else if (canMake) project.create(link.target, from);
  }, [file, heading, canMake, project, link.target, from]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    go();
  };

  const title = file ? file.path : canMake ? `No note called ${link.target}. Click to make it.` : `No file called ${link.target}.`;
  return (
    <a role="link" tabIndex={0} className={file ? 'ws-wikilink' : 'ws-wikilink ws-wikilink-missing'} title={title} onClick={go} onKeyDown={onKeyDown}>
      {label}
    </a>
  );
}

/** A file's name as a link that opens it (at a heading, if given): where an embed can't be drawn in place. */
export function FileLink({ file, label, heading, className }: { file: FileEntry; label?: string; heading?: string | null; className?: string }) {
  const project = useProjectLinks();
  const go = () => project.open(file.path, heading ? heading.split('#').pop() || undefined : undefined);
  return (
    <a
      role="link"
      tabIndex={0}
      className={className ? `ws-wikilink ${className}` : 'ws-wikilink'}
      title={file.path}
      onClick={go}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        go();
      }}
    >
      {label || file.name}
    </a>
  );
}
