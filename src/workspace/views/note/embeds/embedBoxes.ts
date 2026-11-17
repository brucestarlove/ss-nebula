import type { CSSProperties } from 'react';
import type { FileEntry } from '../../../../files/types';

/**
 * The space an embed keeps before its picture has loaded, so nothing below
 * it moves when it arrives (reading view and editor alike).
 *
 * A picture's size is read once, from its file's first bytes (imageSize.ts)
 * or a drawing's elements (canvasScene.ts), and remembered here for this
 * visit, keyed by the file's path, size and time: when the note is read
 * again, or an editor widget is drawn again, the place is exact from the
 * first frame. Nothing is stored on disk. The first time, the place is a
 * modest box (note.css) that settles to the size when it's read, which
 * happens while the embed is still within a screen of being seen.
 */

export type Box = { width: number; height: number };

/** How big an embedded picture or video is asked to be: `![[a.png|300]]`, `|300x200`. */
export type EmbedSize = { width: number; height?: number } | null;

const KEPT = 500;
const known = new Map<string, Box>();

export function boxKey(projectId: string, file: FileEntry): string {
  return `${projectId}\u0000${file.path}\u0000${file.size ?? ''}\u0000${file.modified ?? ''}`;
}

export function knownBox(key: string): Box | undefined {
  return known.get(key);
}

/** Remembers a size, forgetting the oldest beyond a few hundred pictures. */
export function rememberBox(key: string, box: Box): void {
  known.delete(key);
  known.set(key, box);
  while (known.size > KEPT) known.delete(known.keys().next().value!);
}

/** Forgets every size (tests). */
export function forgetBoxes(): void {
  known.clear();
}

const ratio = (box: Box) => `${box.width} / ${box.height}`;

/** The size a picture was asked to be: its width, and its height if one was given. */
export function sizeStyle(size: EmbedSize): CSSProperties | undefined {
  if (!size) return undefined;
  return size.height ? { width: `${size.width}px`, height: `${size.height}px` } : { width: `${size.width}px` };
}

/**
 * The place a picture keeps while it loads: the asked-for size when there is
 * one (with the picture's own proportions for the height, once they're
 * known), else the picture's own size. Without either, the box's CSS default.
 */
export function placeStyle(size: EmbedSize, box: Box | null | undefined): CSSProperties | undefined {
  if (size) return box && !size.height ? { ...sizeStyle(size), aspectRatio: ratio(box) } : sizeStyle(size);
  return box ? natural(box.width, ratio(box)) : undefined;
}

/** The loaded picture's own style: only what was asked for, plus the proportions for a width alone (the width and height attributes hold the rest). */
export function pictureStyle(size: EmbedSize, box: Box | null | undefined): CSSProperties | undefined {
  return size && box && !size.height ? { ...sizeStyle(size), aspectRatio: ratio(box) } : sizeStyle(size);
}

/**
 * A box as wide as the page allows, up to `width`. Written as a width of 100%
 * capped by a max-width, never as a fixed width under `max-width: 100%`: in the
 * editor the line's width comes from its content (CodeMirror's content is a
 * flex item), so a fixed 1,174 px drawing widened every line of the note past
 * the screen, and the percentage had nothing to hold it to.
 */
function natural(width: number, aspectRatio: string): CSSProperties {
  return { width: '100%', maxWidth: `${width}px`, aspectRatio };
}

/** What a drawing keeps: a frame of its picture's proportions at its natural width (never wider than the page), or the size asked for. */
export function frameStyle(size: EmbedSize, box: Box | null | undefined): CSSProperties | undefined {
  if (size?.height) return natural(size.width, `${size.width} / ${size.height}`);
  if (size) return natural(size.width, box ? ratio(box) : '3 / 2');
  return box ? natural(box.width, ratio(box)) : undefined;
}

/* ---- the editor's estimate ------------------------------------------------ */

/** About how wide the page's text is, in pixels, for guessing a picture's height before it is drawn. */
const COLUMN = 660;
/** A drawing is shown no taller than this (note.css .ws-embed-canvas img: 30rem). */
const CANVAS_MAX = 480;

/**
 * A guess at the height of an embed's widget in the editor, for CodeMirror
 * to lay out the note by before the widget is drawn, so the scroll doesn't
 * jump when it is. Exact when the picture's size is known or asked for.
 */
export function estimateEmbedHeight(kind: string, size: EmbedSize, box: Box | undefined): number {
  // The widget's own padding.
  const edge = 10;
  switch (kind) {
    case 'image': {
      if (size?.height) return size.height + edge;
      if (size) return (box ? (Math.min(size.width, COLUMN) * box.height) / box.width : (size.width * 3) / 4) + edge;
      return (box ? (Math.min(box.width, COLUMN) * box.height) / box.width : 168) + edge;
    }
    case 'canvas': {
      // The slot's margins, the button's padding and border, then the frame.
      const around = 35 + 26 + edge;
      if (size?.height) return Math.min(size.height, CANVAS_MAX) + around;
      const width = size?.width ?? box?.width ?? COLUMN;
      const frame = box ? (Math.min(width, COLUMN - 26) * box.height) / box.width : (width * 2) / 3;
      return Math.min(frame, CANVAS_MAX) + around;
    }
    case 'note':
      return 140;
    case 'video':
      return (size?.height ?? 240) + edge;
    case 'audio':
      return 54 + edge;
    default:
      return 52 + edge;
  }
}
