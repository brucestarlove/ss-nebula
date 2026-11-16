import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { kindFromContent } from '../../../../files/kinds';
import type { FileEntry } from '../../../../files/types';
import { titleFromName } from '../../shared/format';
import { useProjectLinks } from '../../shared/projectLinks';
import { parseFrontmatter } from '../markdown';
import { parseWikilink, wikilinkLabel, type WikiTarget } from '../links';
import { NoteContext } from '../noteContexts';
import { NoteMarkdown } from '../prose';
import { CanvasEmbed } from './CanvasEmbed';
import { NoteEnvContext, type NoteEnv } from './NoteEnv';
import { sectionOf } from './section';
import { FileLink } from './WikiLink';
import { useNearScreen } from './useNearScreen';

/** How many notes deep an embed goes: the page's note, its embeds, and theirs. */
export const MAX_EMBED_DEPTH = 2;
/** How much of an embedded note is shown, in characters; a link opens the rest. */
export const EMBED_CHARS = 20_000;

type Text = { status: 'loading' } | { status: 'ready'; text: string } | { status: 'error' };

function useNoteText(file: FileEntry, wanted: boolean): Text {
  const env = useContext(NoteEnvContext);
  const [state, setState] = useState<Text>({ status: 'loading' });
  const store = env?.store;
  useEffect(() => {
    if (!wanted || !store) return undefined;
    let cancelled = false;
    store.readText(file.path).then(
      (text) => !cancelled && setState({ status: 'ready', text }),
      () => !cancelled && setState({ status: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [wanted, store, file.path, file.size, file.modified]);
  return state;
}

/** The text up to `limit` characters, cut where a paragraph ends if it can be. */
function clip(text: string, limit: number): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false };
  const at = text.lastIndexOf('\n\n', limit);
  return { text: text.slice(0, at > limit / 2 ? at : limit), cut: true };
}

function Quiet({ className, children }: { className: string; children: string }) {
  return <div className={className}>{children}</div>;
}

function EmbeddedBody({ file, link, env }: { file: FileEntry; link: WikiTarget | null; env: NoteEnv }) {
  const project = useProjectLinks();
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearScreen(ref, '300px');
  const read = useNoteText(file, near);
  const title = titleFromName(file.name);
  const inner = useMemo<NoteEnv>(() => ({ ...env, path: file.path, depth: env.depth + 1, chain: [...env.chain, file.path] }), [env, file.path]);
  const shown = useMemo(() => {
    if (read.status !== 'ready') return null;
    const body = parseFrontmatter(read.text).body;
    // A section when the link names one that is there; otherwise the whole note.
    return clip((link && sectionOf(body, link)) ?? body, EMBED_CHARS);
  }, [read, link]);

  // A plain .md that is an Excalidraw drawing is a canvas, whatever it's called.
  if (read.status === 'ready' && kindFromContent(file.name, read.text) === 'canvas') return <CanvasEmbed file={file} />;
  const label = link ? wikilinkLabel({ ...link, alias: null }) : title;
  return (
    <div className="ws-embed-note" ref={ref} data-depth={env.depth + 1}>
      <div className="ws-embed-head">
        <FileLink file={file} label={label || title} heading={link?.heading} className="ws-embed-name" />
      </div>
      {read.status === 'error' ? <Quiet className="ws-embed-quiet">Couldn’t read this note.</Quiet> : null}
      {shown ? (
        <>
          <div className="ws-embed-body">
            <NoteEnvContext.Provider value={inner}>
              <NoteContext.Provider value={null}>
                <NoteMarkdown body={shown.text} title={link?.heading || link?.block ? '' : title} />
              </NoteContext.Provider>
            </NoteEnvContext.Provider>
          </div>
          {shown.cut ? (
            <button type="button" className="ws-embed-more" data-no-arc onClick={() => project.open(file.path)}>
              Open the note
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * `![[Another note]]`: that note's text in place, read-only, in a quiet
 * bordered block under its name (a link to it). It goes two notes deep and
 * no further, stops where a note would show itself again (a note that embeds
 * itself, or two that embed each other), and shows no more than 20,000
 * characters.
 */
export function NoteEmbed({ file, link }: { file: FileEntry; link?: WikiTarget }) {
  const env = useContext(NoteEnvContext);
  const title = titleFromName(file.name);
  const parsed = useMemo(() => link ?? parseWikilink(title, true), [link, title]);
  if (!env) return <FileLink file={file} label={title} />;
  if (env.chain.includes(file.path)) return <div className="ws-embed-note ws-embed-stop">{`“${title}” embeds itself, so it stops here.`}</div>;
  if (env.depth >= MAX_EMBED_DEPTH) {
    return (
      <div className="ws-embed-deep">
        <FileLink file={file} label={title} />
      </div>
    );
  }
  return <EmbeddedBody file={file} link={link ? parsed : null} env={env} />;
}
