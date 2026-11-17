import { useId, useMemo, useState } from 'react';
import { kindFromName } from '../../files/kinds';
import { basename, dirname } from '../../files/paths';
import type { FileKind } from '../../files/types';
import { useProjectIndex, type IndexedLink, type SearchHit, type SearchRange } from '../projectIndex';
import { resultTitle, splitHighlights } from '../quickOpen';
import { useProjectLinks, type LinePlace } from '../views/shared/projectLinks';
import { Button } from './Button';
import { iconForFile } from './fileIcon';
import { Icon } from './icons';

/**
 * The right panel's "Linked from": the files that link to the
 * active file, of any kind, each with the lines its links are on and the
 * link's own words marked. A file opens at its top, a line at that line.
 * Under it, collapsed until asked for, "Not linked yet": files that name
 * this one's title in their text without a link.
 */
export function BacklinksPanel({ path }: { path: string | null }) {
  const index = useProjectIndex();
  const links = useProjectLinks();
  const id = useId();
  const [mentionsOpen, setMentionsOpen] = useState(false);

  const groups = useMemo(() => {
    const byFile = new Map<string, IndexedLink[]>();
    for (const link of path ? index.backlinks(path) : []) {
      const list = byFile.get(link.from);
      if (list) list.push(link);
      else byFile.set(link.from, [link]);
    }
    return [...byFile.entries()];
  }, [index, path]);
  // Asked for only while open: each is a pass over every file's text.
  const mentions = useMemo(() => (path && mentionsOpen && index.mentions ? index.mentions(path) : []), [index, path, mentionsOpen]);

  const kindOf = (file: string): FileKind => index.docs.get(file)?.kind ?? kindFromName(basename(file));
  const openAt = (file: string, line: number | undefined, text: string, words: string[]) => {
    // A canvas opens as it is; a note at the line, found by its words.
    const place: LinePlace | undefined = kindOf(file) === 'note' && line !== undefined ? { text, words } : undefined;
    links.open(file, undefined, place);
  };

  return (
    <section className="ws-linked" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>
        Linked from
        {groups.length > 0 ? (
          <span className="ws-linked-count">
            {groups.length}
            <span className="ws-visually-hidden">{groups.length === 1 ? ' file' : ' files'}</span>
          </span>
        ) : null}
      </h3>
      {!path ? (
        <p className="ws-panel-empty">Open a file to see what links to it.</p>
      ) : groups.length === 0 ? (
        <p className="ws-panel-empty">{index.ready ? 'No note or canvas links here yet.' : 'Still reading the project…'}</p>
      ) : (
        <ul className="ws-linked-list">
          {groups.map(([from, items]) => (
            <li key={from}>
              <Button className="ws-linked-file" title={from} onClick={() => links.open(from)}>
                <Icon name={iconForFile(basename(from), kindOf(from))} />
                <span className="ws-linked-name">{resultTitle(basename(from))}</span>
                {dirname(from) ? <small>{dirname(from)}</small> : null}
              </Button>
              <ul className="ws-linked-lines">
                {items.map((link, n) => (
                  <li key={`${link.line ?? ''}:${n}`}>
                    <Button className="ws-linked-line" onClick={() => openAt(from, link.line, link.context, wordsIn(link.context, link.contextRange))}>
                      <Marked text={link.context || link.target} ranges={link.context && link.contextRange ? [link.contextRange] : []} />
                    </Button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {path && index.mentions ? (
        <div className="ws-linked-more">
          <Button className="ws-linked-toggle" aria-expanded={mentionsOpen} aria-controls={`${id}-m`} onClick={() => setMentionsOpen(!mentionsOpen)}>
            <Icon name="chevron" />
            Not linked yet
          </Button>
          {mentionsOpen ? (
            <div id={`${id}-m`}>
              {mentions.length === 0 ? (
                <p className="ws-panel-empty">{index.ready ? 'No other note or canvas names it without a link.' : 'Still reading the project…'}</p>
              ) : (
                <ul className="ws-linked-list">
                  {mentions.map((hit) => (
                    <Mention key={hit.path} hit={hit} kind={kindOf(hit.path)} onOpen={() => openAt(hit.path, hit.line, hit.snippet, wordsIn(hit.snippet, hit.ranges[0]))} />
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** A file that names this one without a link: its name, and the line that does. */
function Mention({ hit, kind, onOpen }: { hit: SearchHit; kind: FileKind; onOpen: () => void }) {
  const name = basename(hit.path);
  return (
    <li>
      <Button className="ws-linked-file" title={hit.path} onClick={onOpen}>
        <Icon name={iconForFile(name, kind)} />
        <span className="ws-linked-name">{resultTitle(name)}</span>
        {dirname(hit.path) ? <small>{dirname(hit.path)}</small> : null}
      </Button>
      {hit.snippet ? (
        <ul className="ws-linked-lines">
          <li>
            <Button className="ws-linked-line" onClick={onOpen}>
              <Marked text={hit.snippet} ranges={hit.ranges} />
            </Button>
          </li>
        </ul>
      ) : null}
    </li>
  );
}

/** The marked words, to find the line by when the whole of it isn't on screen. */
function wordsIn(text: string, range: SearchRange | undefined): string[] {
  return range ? text.slice(range[0], range[1]).split(/\s+/).filter(Boolean) : [];
}

function Marked({ text, ranges }: { text: string; ranges: SearchRange[] }) {
  return (
    <>
      {splitHighlights(text, ranges).map((run, n) => (run.mark ? <mark key={n}>{run.text}</mark> : <span key={n}>{run.text}</span>))}
    </>
  );
}
