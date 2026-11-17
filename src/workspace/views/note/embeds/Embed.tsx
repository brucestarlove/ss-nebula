import { useContext, useEffect, useRef, useState } from 'react';
import { kindFromName } from '../../../../files/kinds';
import type { FileEntry } from '../../../../files/types';
import { formatBytes } from '../../shared/format';
import { Glyph, type GlyphName } from '../../shared/Glyph';
import { useFileBlob } from '../../shared/useFileBlob';
import { useProjectLinks } from '../../shared/projectLinks';
import { parseWikilink, resolveLink, wikilinkLabel } from '../links';
import { CanvasEmbed } from './CanvasEmbed';
import { boxKey, knownBox, pictureStyle, placeStyle, rememberBox, sizeStyle, type Box, type EmbedSize } from './embedBoxes';
import { readImageSize } from './imageSize';
import { NoteEnvContext } from './NoteEnv';
import { NoteEmbed } from './NoteEmbed';
import { FileLink } from './WikiLink';
import { useNearScreen } from './useNearScreen';

export type { EmbedSize };

/** What stands where an embed's file isn't: its name, muted. No broken-image icon. */
export function MissingEmbed({ name, why }: { name: string; why?: string }) {
  return (
    <span className="ws-embed-missing" title={why ?? `${name} isn’t in this project`}>
      <Glyph name="image" />
      {name}
    </span>
  );
}

/** Where a picture will be, until it is: the size asked for, or its own once it's known (embedBoxes.ts), else a modest box. */
function PictureWait({ size, box }: { size: EmbedSize; box: Box | null | undefined }) {
  return <span className="ws-embed-wait ws-embed-wait-image" style={placeStyle(size, box)} aria-hidden="true" />;
}

function ImageLoaded({ file, alt, size, title }: { file: FileEntry; alt: string; size: EmbedSize; title?: string }) {
  const env = useContext(NoteEnvContext);
  const blob = useFileBlob(env!.store, file.path, file.name);
  const key = boxKey(env!.projectId, file);
  // The picture's size comes from its file's first bytes, before the picture is
  // put on the page, so its place is exact from the moment it appears. Null:
  // the bytes don't say (an SVG), and the picture settles as it loads.
  const [read, setRead] = useState<{ key: string; box: Box | null } | null>(null);
  const box = knownBox(key) ?? (read?.key === key ? read.box : undefined);
  const bytes = blob.status === 'ready' ? blob.blob : null;
  useEffect(() => {
    if (!bytes || box !== undefined) return undefined;
    let cancelled = false;
    void readImageSize(bytes).then((found) => {
      if (cancelled) return;
      if (found) rememberBox(key, found);
      setRead({ key, box: found });
    });
    return () => {
      cancelled = true;
    };
  }, [bytes, box, key]);
  if (blob.status === 'error') return <MissingEmbed name={alt} why={`Couldn’t read ${file.path}`} />;
  if (blob.status !== 'ready' || box === undefined) return <PictureWait size={size} box={box} />;
  return <img src={blob.url} alt={alt} title={title} loading="lazy" decoding="async" width={box?.width} height={box?.height} style={pictureStyle(size, box)} />;
}

/** A picture from the project. Its file is read when it is near the screen; the <img> is lazy as well, and its blob URL goes when the note does. Its place is kept from the first frame when its size is known (embedBoxes.ts). */
export function ImageEmbed({ file, alt, size, title }: { file: FileEntry; alt: string; size: EmbedSize; title?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const env = useContext(NoteEnvContext);
  const near = useNearScreen(ref);
  return (
    <span className="ws-embed-image" ref={ref}>
      {near ? <ImageLoaded file={file} alt={alt} size={size} title={title} /> : <PictureWait size={size} box={env ? knownBox(boxKey(env.projectId, file)) : undefined} />}
    </span>
  );
}

function MediaLoaded({ file, kind, size, label }: { file: FileEntry; kind: 'audio' | 'video'; size: EmbedSize; label: string }) {
  const env = useContext(NoteEnvContext);
  const blob = useFileBlob(env!.store, file.path, file.name);
  if (blob.status === 'error') return <MissingEmbed name={label} why={`Couldn’t read ${file.path}`} />;
  if (blob.status !== 'ready') return <span className="ws-embed-wait" aria-hidden="true" />;
  // The browser's own controls; nothing plays or loads more until it's asked to.
  return kind === 'audio' ? (
    <audio src={blob.url} controls preload="none" aria-label={label} />
  ) : (
    <video src={blob.url} controls preload="none" playsInline aria-label={label} style={sizeStyle(size)} />
  );
}

function MediaEmbed({ file, kind, size, label }: { file: FileEntry; kind: 'audio' | 'video'; size: EmbedSize; label: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const near = useNearScreen(ref);
  return (
    <span className="ws-embed-media" data-kind={kind} ref={ref}>
      {near ? <MediaLoaded file={file} kind={kind} size={size} label={label} /> : <span className="ws-embed-wait" aria-hidden="true" />}
    </span>
  );
}

const CARD_GLYPH: Record<string, GlyphName> = { pdf: 'pdf', audio: 'audio', video: 'video', image: 'image', text: 'data', canvas: 'canvas', note: 'note' };

/** A file that isn't shown in the page: its icon, name and size, and Open. */
export function FileCard({ file }: { file: FileEntry }) {
  const project = useProjectLinks();
  return (
    <span className="ws-embed-card">
      <Glyph name={CARD_GLYPH[kindFromName(file.name)] ?? 'file'} />
      <span className="ws-embed-card-name">{file.name}</span>
      <span className="ws-embed-card-size">{formatBytes(file.size)}</span>
      <button type="button" className="ws-view-btn" data-no-arc onClick={() => project.open(file.path)}>
        Open
      </button>
    </span>
  );
}

/**
 * A file shown in the note by what it is: a picture, a drawing (as a preview
 * image), another note's text, audio or video with their controls; a PDF and
 * anything else as a small card. `block` is whether it stands alone in its
 * paragraph: only then does another note's text open out in place (it holds
 * paragraphs and headings, which a line of words can't); inside a line it is
 * a link.
 */
export function FileEmbed({ file, alt, size, title, block }: { file: FileEntry; alt?: string; size?: EmbedSize; title?: string; block: boolean }) {
  const kind = kindFromName(file.name);
  const shown = size ?? null;
  switch (kind) {
    case 'image':
      return <ImageEmbed file={file} alt={alt || file.name} size={shown} title={title} />;
    case 'canvas':
      return <CanvasEmbed file={file} size={shown} />;
    case 'note':
      return block ? <NoteEmbed file={file} /> : <FileLink file={file} label={alt || undefined} />;
    case 'audio':
    case 'video':
      return <MediaEmbed file={file} kind={kind} size={shown} label={alt || file.name} />;
    default:
      return <FileCard file={file} />;
  }
}

/** `![[Note#Heading|300]]`: the file it names, drawn by what it is, or its name muted. */
export function WikiEmbed({ raw, block }: { raw: string; block: boolean }) {
  const env = useContext(NoteEnvContext);
  const project = useProjectLinks();
  const link = parseWikilink(raw, true);
  const file = link.target ? resolveLink(link.target, env?.path ?? '', project.files) : null;
  if (!file) return <MissingEmbed name={link.target || raw.trim()} />;
  if (kindFromName(file.name) === 'note') return block ? <NoteEmbed file={file} link={link} /> : <FileLink file={file} label={wikilinkLabel(link)} heading={link.heading} />;
  return <FileEmbed file={file} alt={link.alias ?? undefined} size={link.size} block={block} />;
}
