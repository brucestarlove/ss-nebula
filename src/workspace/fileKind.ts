import { kindFromName, kindOf } from '../files/kinds';
import type { FileEntry, FileKind, FileStore } from '../files/types';

/** What a file opens as: src/files/kinds.ts's kindOf, which reads a plain
 * `.md` to see whether it holds an Obsidian Excalidraw drawing
 * without loading the canvas code. A file that can't be read opens by its
 * name, so its view can say what went wrong. */
export async function resolveKind(store: FileStore, entry: Pick<FileEntry, 'path' | 'name'>): Promise<FileKind> {
  try {
    return await kindOf(store, entry.path);
  } catch {
    return kindFromName(entry.name);
  }
}
