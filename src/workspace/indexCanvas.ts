/**
 * A canvas's words for the project index: the text on it, one text
 * element per line, and the `[[links]]` written in that text or set as an
 * element's link (Obsidian Excalidraw's way). It reads the scene as the
 * note embeds do (canvasScene.ts), without Excalidraw itself, and keeps
 * nothing of the scene but its words.
 *
 * Loaded on demand by useProjectIndexBuild.ts, the first time a project has
 * a canvas to read: reading an Obsidian drawing needs lz-string, which the
 * workspace's first load doesn't carry.
 */
import { drawableScene } from './views/note/embeds/canvasScene';
import { canvasLinks, type WrittenLink } from './indexBuild';

export type CanvasWords = { lines: string[]; links: WrittenLink[] };

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The words and links on a canvas file; nothing for a file that isn't a drawing. */
export function canvasWords(text: string, path: string): CanvasWords {
  let scene: ReturnType<typeof drawableScene>;
  try {
    scene = drawableScene(text, path);
  } catch {
    return { lines: [], links: [] };
  }
  if (!scene) return { lines: [], links: [] };
  const lines: string[] = [];
  const links: WrittenLink[] = [];
  for (const element of scene.elements) {
    // Text as it was typed (Excalidraw wraps `text` to the box), else as drawn; a frame's name.
    const words = element.type === 'text' ? stringOf(element.originalText) || stringOf(element.text) : element.type === 'frame' || element.type === 'magicframe' ? stringOf(element.name) : '';
    const line = words.replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (line) {
      lines.push(line);
      links.push(...canvasLinks(line, line));
    }
    const link = stringOf(element.link).trim();
    if (link.includes('[[')) links.push(...canvasLinks(link, line || link));
  }
  return { lines, links };
}
